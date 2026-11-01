import type { AuditService } from "../audit/audit-service.js";
import { sandboxModeLabel, type SandboxMode } from "./escalation.js";
// 作用：免打扰窗口（2026-11-01 产品定稿）——「限时完全访问」的审批放行层。
//
// 语义（刻意保持窄）：
//   - 窗口内，本会话中【由 Guard 在 tools/execute 记录过、且带 requestedMode 的沙箱升级调用】
//     一律自动答 allowed-once；其它审批（没有 requestedMode / 非本会话 / 没有记录）继续交还人类。
//   - **不改沙箱档位、不改审批策略、不签发 Lease**：放开的是"这次升级问不问人"，不是"会话变成完全访问"。
//   - 窗口有界、可停止、可延长；到期 / 用户手改原生档位 / 插件卸载立即失效。
//   - 完全访问档位下没有可放行的审批（DSH 的该 preset 审批策略是 never），manager 直接拒绝开启。
//
// 为什么不复用 Lease：免打扰是"时间窗 + 每次单次升级"，不是一条可复用授权；
// 用 Lease 记账会污染授权视图（历史缺陷：toolName=免打扰 的假 Lease、决策日志里看不到放行记录）。
/** 窗口内一次自动放行的记录（只保留展示所需字段，不含参数原文）。 */
export interface DndDecisionRecord {
  at: number;
  callId: string;
  toolName: string;
  requestedMode: SandboxMode;
  /** 目标档位的中文说法（服务端唯一来源，前端不再维护映射） */
  requestedModeText: string;
  /** 已脱敏的操作描述（来自 tools/execute 记录） */
  display: string;
}
/** 对外只读视图（快照 / 治理台共用）。 */
export interface DndWindowView {
  sessionId: string;
  startedAt: number;
  expiresAt: number;
  /** 开启窗口时的会话档位；用于检测用户是否手动改过档位 */
  baselineMode?: SandboxMode;
  allowedCount: number;
  recent: readonly DndDecisionRecord[];
}
/** 审批到达时交给 manager 的最小上下文（来自 OperationRegistry 的记录）。 */
export interface DndEvaluation {
  sessionId: string;
  callId: string;
  toolName: string;
  /** 本次调用申请的目标档位；undefined 表示不是沙箱升级 → 不接管 */
  mode?: SandboxMode;
  display: string;
}
export type DndVerdict = "allow" | "delegate";
export interface DndManagerDeps {
  audit: AuditService;
  /** 读当前会话档位；undefined = 读不到（此时不做"档位被改"判定，避免误杀） */
  modeOf: (sessionId: string) => SandboxMode | undefined;
  /** 单个窗口允许的最长总时长（毫秒），来自运行期 maxTtlSeconds */
  maxWindowMs: () => number;
  now?: () => number;
}
interface MutableWindow {
  sessionId: string;
  startedAt: number;
  expiresAt: number;
  baselineMode?: SandboxMode;
  allowedCount: number;
  recent: DndDecisionRecord[];
}
/** 每个窗口最多展示多少条放行记录（只用于 UI；完整记录在审计里）。 */
const RECENT_LIMIT = 20;
export class DndManager {
  private readonly windows = new Map<string, MutableWindow>();
  private readonly now: () => number;
  constructor(private readonly deps: DndManagerDeps) {
    this.now = deps.now ?? Date.now;
  }
  /** 作用：开启（或重开）一个免打扰窗口。完全访问档位、非法 TTL、超上限一律拒绝。 */
  start(sessionId: string, ttlSeconds: number): DndWindowView {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("GUARD_DND_INVALID: sessionId must be a non-empty string");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("GUARD_DND_INVALID: ttlSeconds must be a positive integer");
    const maxMs = this.deps.maxWindowMs();
    if (!Number.isInteger(maxMs) || maxMs <= 0) throw new Error("GUARD_DND_INVALID: max window is unavailable");
    if (ttlSeconds * 1000 > maxMs) throw new Error(`GUARD_DND_INVALID: ttlSeconds must be <= ${Math.floor(maxMs / 1000)}`);
    const mode = this.deps.modeOf(sessionId);
    if (mode === "danger-full-access") {
      throw new Error("GUARD_DND_NOT_APPLICABLE: 当前已是完全访问挡位，没有需要放行的审批（DSH 的完全访问 preset 审批策略为 never）");
    }
    if (this.windows.has(sessionId)) this.close(sessionId, "restarted");
    const at = this.now();
    const window: MutableWindow = {
      sessionId,
      startedAt: at,
      expiresAt: at + ttlSeconds * 1000,
      baselineMode: mode,
      allowedCount: 0,
      recent: [],
    };
    this.windows.set(sessionId, window);
    this.deps.audit.record({
      sessionId,
      callId: "",
      rootCallId: "",
      toolName: "免打扰",
      scopeKey: `dnd:${sessionId}:${at}`,
      scopeDisplay: `开启免打扰 ${Math.round(ttlSeconds / 60)} 分钟：窗口内自动批准沙箱升级（限时完全访问，不改挡位）`,
      decision: "DND_OPENED",
    });
    return this.viewOf(window);
  }
  /** 作用：提前结束窗口（纯收缩）。返回是否真的存在一个活动窗口。 */
  stop(sessionId: string, reason = "user"): boolean {
    if (!this.windows.has(sessionId)) return false;
    this.close(sessionId, reason);
    return true;
  }
  /** 作用：延长窗口；延长后的总时长仍不得超过 maxWindowMs（不允许无限续成永久授权）。 */
  extend(sessionId: string, addSeconds: number): DndWindowView {
    const window = this.requireActive(sessionId);
    if (!Number.isInteger(addSeconds) || addSeconds <= 0) throw new Error("GUARD_DND_INVALID: addSeconds must be a positive integer");
    const maxMs = this.deps.maxWindowMs();
    if (!Number.isInteger(maxMs) || maxMs <= 0) throw new Error("GUARD_DND_INVALID: max window is unavailable");
    const next = Math.max(window.expiresAt, this.now()) + addSeconds * 1000;
    if (next - window.startedAt > maxMs) {
      throw new Error(`GUARD_DND_INVALID: window must stay within ${Math.floor(maxMs / 1000)}s from start`);
    }
    window.expiresAt = next;
    this.deps.audit.record({
      sessionId,
      callId: "",
      rootCallId: "",
      toolName: "免打扰",
      scopeKey: `dnd:${sessionId}:${window.startedAt}`,
      scopeDisplay: `延长免打扰 ${Math.round(addSeconds / 60)} 分钟（到期时间 ${new Date(next).toISOString()}）`,
      decision: "DND_EXTENDED",
    });
    return this.viewOf(window);
  }
  /** 作用：审批到达时判定——只有"本会话 + 有 requestedMode 的升级"才自动放行。 */
  evaluate(input: DndEvaluation): DndVerdict {
    const window = this.activeWindow(input.sessionId);
    if (!window) return "delegate";
    if (input.mode === undefined) return "delegate";
    const record: DndDecisionRecord = {
      at: this.now(),
      callId: input.callId,
      toolName: input.toolName,
      requestedMode: input.mode,
      requestedModeText: sandboxModeLabel(input.mode),
      display: input.display,
    };
    window.allowedCount += 1;
    window.recent.unshift(record);
    if (window.recent.length > RECENT_LIMIT) window.recent.length = RECENT_LIMIT;
    this.deps.audit.record({
      sessionId: input.sessionId,
      callId: input.callId,
      rootCallId: input.callId,
      toolName: input.toolName,
      scopeKey: `dnd:${input.sessionId}:${window.startedAt}`,
      scopeDisplay: `${input.display} · 免打扰窗口内自动放行（${sandboxModeLabel(input.mode)}）`,
      decision: "DND_ALLOWED",
    });
    return "allow";
  }
  /** 作用：读某会话的活动窗口（读的时候顺便结算过期）。 */
  view(sessionId: string): DndWindowView | undefined {
    const window = this.activeWindow(sessionId);
    return window ? this.viewOf(window) : undefined;
  }
  /** 作用：低频结算——过期关闭、用户手改原生档位则关闭（切回原档位也不复活）。 */
  sweep(): void {
    const at = this.now();
    for (const sessionId of [...this.windows.keys()]) {
      const window = this.windows.get(sessionId);
      if (!window) continue;
      if (at >= window.expiresAt) {
        this.close(sessionId, "expired");
        continue;
      }
      if (window.baselineMode !== undefined) {
        const current = this.deps.modeOf(sessionId);
        if (current !== undefined && current !== window.baselineMode) this.close(sessionId, "mode-changed");
      }
    }
  }
  /** 作用：插件卸载时清空全部窗口，并留下可追溯的关闭记录。 */
  closeAll(reason: string): void {
    for (const sessionId of [...this.windows.keys()]) this.close(sessionId, reason);
  }
  private requireActive(sessionId: string): MutableWindow {
    const window = this.activeWindow(sessionId);
    if (!window) throw new Error("GUARD_DND_INVALID: no active dnd window");
    return window;
  }
  private activeWindow(sessionId: string): MutableWindow | undefined {
    const window = this.windows.get(sessionId);
    if (!window) return undefined;
    if (this.now() >= window.expiresAt) {
      this.close(sessionId, "expired");
      return undefined;
    }
    return window;
  }
  private close(sessionId: string, reason: string): void {
    const window = this.windows.get(sessionId);
    if (!window) return;
    this.windows.delete(sessionId);
    this.deps.audit.record({
      sessionId,
      callId: "",
      rootCallId: "",
      toolName: "免打扰",
      scopeKey: `dnd:${sessionId}:${window.startedAt}`,
      scopeDisplay: `结束免打扰（${reason}）：窗口内共自动放行 ${window.allowedCount} 次`,
      decision: "DND_CLOSED",
    });
  }
  private viewOf(window: MutableWindow): DndWindowView {
    return {
      sessionId: window.sessionId,
      startedAt: window.startedAt,
      expiresAt: window.expiresAt,
      baselineMode: window.baselineMode,
      allowedCount: window.allowedCount,
      recent: [...window.recent],
    };
  }
}
