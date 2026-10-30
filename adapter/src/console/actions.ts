import type { AuditService } from "../audit/audit-service.js";
import { escalationScopeDisplay, escalationScopeKey, isSandboxMode, SANDBOX_MODES, type SandboxMode } from "../capability/escalation.js";
import type { LeaseManager } from "../capability/lease-manager.js";
import { recordSandboxOutcome } from "../capability/sandbox-audit.js";
import type { SandboxGrantManager } from "../capability/sandbox-grant.js";
import type { ConsoleActions, ConsoleRestoreResult, ConsoleRevokeResult, ConsoleWindowRequest, ConsoleWindowResult } from "./types.js";
// 作用：治理台动作层——两个【收缩】动作 + 一个【有界放宽】动作。
//   1. revokeSession  撤销该会话仍有效的全部授权，并回滚沙箱档位（只收紧）；
//   2. restoreSandbox 只结算该会话中【已经失效】的沙箱授权并回写档位（只收紧）；
//   3. openWindow     用户主动开启「免打扰窗口」：为 (工具, 目标档位) 签发一条有界沙箱授权并提升会话档位。
//
// 【为什么 openWindow 是放宽，也必须存在】用户真实的痛点是"接下来半小时别问我"，而 DSH 原生的审批弹窗
// 没有可插按钮的槽位（conversation.approval.detail 是 single 槽，替换会顶掉原生审批渲染）。因此只能在
// **用户自己的界面**上把这个决定做成一次显式点击：点击即同意，等价于一次 allowed-once。
// 【边界（不得突破）】
//   - 只允许沙箱档位升级这一类授权；不接受任意范围、不写 approval 策略、不改 permissionPresets；
//   - TTL 必须为正整数且不得超过运行期策略的 maxTtlSeconds（Fail Closed，不静默裁剪）；
//   - 必须能解析到真实 Session 对象（拿不到就不许开，否则"授权了却没生效"会骗人）；
//   - 必须写审计（WINDOW_OPENED），并在页面上以倒计时 + 「提前收回」呈现。
export interface GuardActionDeps {
  leases: LeaseManager;
  sandbox: SandboxGrantManager;
  audit: AuditService;
  now?: () => number;
  /** 解析会话对象（真实实现 ctx.sessions.get(id)）——开窗口要提升档位，没有它就无法真正生效 */
  resolveSession?: (sessionId: string) => unknown;
  /** 运行期 TTL 上限（秒）——窗口时长不得超过它；未注入时用 1800 兜底 */
  maxTtlSeconds?: () => number;
  /** 该工具是否被配置为沙箱升级链路（sandbox-escalation）——注入时窗口只允许对这些工具开 */
  allowTool?: (toolName: string) => boolean;
}
/** 撤销原因——写进 Lease.revokeReason 与审计，便于事后回答「这条授权是谁收的」。 */
export const CONSOLE_REVOKE_REASON = "governance console: 用户提前收回";
/** 窗口授权的默认上限（秒）——与 DEFAULT_UNIVERSAL_POLICY.maxTtlSeconds 一致，仅在未注入依赖时兜底。 */
const FALLBACK_MAX_TTL_SECONDS = 1800;
export class GuardActions implements ConsoleActions {
  private readonly now: () => number;
  constructor(private readonly deps: GuardActionDeps) {
    this.now = deps.now ?? Date.now;
  }
  async revokeSession(sessionId: string): Promise<ConsoleRevokeResult> {
    // 作用：撤销某会话仍有效的全部授权（含沙箱授权），随后回滚该会话的沙箱档位。
    // 幂等：没有可撤销的授权时返回 revoked=0，仍会尝试结算（可能只是档位没收回）。
    assertSessionId(sessionId);
    const leases = await this.deps.leases.list();
    const active = leases.filter((lease) => lease.sessionId === sessionId && lease.status === "ACTIVE");
    let revoked = 0;
    for (const lease of active) {
      const ok = await this.deps.leases.revoke(lease.id, CONSOLE_REVOKE_REASON);
      if (!ok) continue;
      revoked += 1;
      this.deps.audit.record({
        sessionId,
        leaseId: lease.id,
        callId: "",
        rootCallId: "",
        toolName: lease.toolName,
        scopeKey: lease.scope.key,
        scopeDisplay: lease.scope.display,
        decision: "LEASE_REVOKED",
      });
    }
    const results = await this.deps.sandbox.releaseSession(sessionId);
    for (const result of results) recordSandboxOutcome(this.deps.audit, result);
    return { sessionId, revoked, results: results.map((result) => ({ outcome: result.outcome, mode: result.mode })) };
  }
  async restoreSandbox(sessionId: string): Promise<ConsoleRestoreResult> {
    // 作用：把「授权已失效但档位还没回来」的中间态收掉——只结算已失效的授权，
    // 仍有效的授权与用户自己改过的档位都不动（冲突检测在 SandboxGrantManager 内部）。
    assertSessionId(sessionId);
    const results = await this.deps.sandbox.restoreSession(sessionId);
    for (const result of results) recordSandboxOutcome(this.deps.audit, result);
    return { sessionId, results: results.map((result) => ({ outcome: result.outcome, mode: result.mode })) };
  }
  async openWindow(request: ConsoleWindowRequest): Promise<ConsoleWindowResult> {
    // 作用：用户显式开启「免打扰窗口」——签发一条 sandbox-mode 授权并立即把会话档位提升到目标档位。
    // 之后同类升级调用会走 tools/execute 的复用路径（先提升、后执行），因此 DSH 根本不会再弹审批。
    // 全部参数 Fail Closed 校验；任何一步失败都回滚已签发的授权，绝不留下"授权了却没用"的半成品。
    const sessionId = request?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("GUARD_CONSOLE_INVALID: sessionId must be a non-empty string");
    }
    if (typeof request.toolName !== "string" || request.toolName.length === 0) {
      throw new Error("GUARD_CONSOLE_INVALID: toolName must be a non-empty string");
    }
    if (!isSandboxMode(request.mode)) {
      throw new Error(`GUARD_CONSOLE_INVALID: mode must be one of ${SANDBOX_MODES.join(", ")}`);
    }
    const maxTtl = this.deps.maxTtlSeconds ? this.deps.maxTtlSeconds() : FALLBACK_MAX_TTL_SECONDS;
    const ttlSeconds = request.ttlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > maxTtl) {
      throw new Error(`GUARD_CONSOLE_INVALID: ttlSeconds must be an integer in (0, ${maxTtl}]`);
    }
    if (!this.deps.resolveSession) {
      throw new Error("GUARD_CONSOLE_INVALID: session resolver unavailable");
    }
    if (this.deps.allowTool && !this.deps.allowTool(request.toolName)) {
      // 只允许给「配置里真的走沙箱升级链路」的工具开窗：否则窗口只是一个无意义的放宽通道
      throw new Error("GUARD_CONSOLE_INVALID: tool is not configured for sandbox escalation");
    }
    const session = this.deps.resolveSession(sessionId);
    if (session === undefined || session === null) {
      // 拿不到会话对象就无法提升档位：宁可拒绝，也不签发一条不会生效的授权（那等于骗用户）
      throw new Error("GUARD_CONSOLE_INVALID: session not resolvable (cannot raise sandbox mode)");
    }
    const mode = request.mode as SandboxMode;
    const scope = {
      kind: "sandbox-escalation" as const,
      key: escalationScopeKey({ toolName: request.toolName, requestedMode: mode }),
      display: escalationScopeDisplay({ toolName: request.toolName, requestedMode: mode }),
    };
    const lease = await this.deps.leases.issue({ sessionId, toolName: request.toolName, scope, ttlSeconds, kind: "sandbox-mode", sourceCallId: "window" });
    this.deps.audit.record({
      sessionId,
      leaseId: lease.id,
      callId: "",
      rootCallId: "",
      toolName: request.toolName,
      scopeKey: scope.key,
      scopeDisplay: `用户在治理台开启免打扰窗口：${request.toolName} 可升至「${modeText(mode)}」，${ttlSeconds} 秒后自动收回`,
      decision: "WINDOW_OPENED",
    });
    try {
      const applied = await this.deps.sandbox.applyGrant({ leaseId: lease.id, sessionId, session, toolName: request.toolName, requestedMode: mode });
      recordSandboxOutcome(this.deps.audit, applied);
      return { sessionId, leaseId: lease.id, mode: applied.mode, outcome: applied.outcome, expiresAt: lease.expiresAt };
    } catch (err) {
      // 提升失败：把刚签发的授权撤销掉，避免"有授权但没生效"的误导状态
      await this.deps.leases.revoke(lease.id, "window failed to raise sandbox mode");
      throw err;
    }
  }
}
function assertSessionId(sessionId: string): void {
  // 作用：Fail Closed —— 会话 ID 必须是非空字符串（治理动作不接受空目标）
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("GUARD_CONSOLE_INVALID: sessionId must be a non-empty string");
  }
}
function modeText(mode: SandboxMode): string {
  if (mode === "read-only") return "只读";
  if (mode === "workspace-write") return "工作区可写";
  return "完全访问";
}
