import type { AuditService } from "../audit/audit-service.js";
import type { LeaseManager } from "../capability/lease-manager.js";
import { recordSandboxOutcome } from "../capability/sandbox-audit.js";
import type { SandboxGrantManager } from "../capability/sandbox-grant.js";
import type { ConsoleActions, ConsoleRestoreResult, ConsoleRevokeResult } from "./types.js";
// 作用：治理台的【收缩型】治理动作——用户可以在页面上提前收回授权，或把已经该失效的沙箱档位收回去。
// 【边界】这里只有两个动作，且都只能让权限变小：
//   1. revokeSession  撤销该会话仍有效的全部授权，并回滚沙箱档位（不会签发任何新授权）；
//   2. restoreSandbox 只结算该会话中【已经失效】的沙箱授权并回写档位，不碰仍有效的授权。
// 两个动作都写审计；它们不放宽任何权限，也不触碰 approval/沙箱策略之外的任何旋钮。
export interface GuardActionDeps {
  leases: LeaseManager;
  sandbox: SandboxGrantManager;
  audit: AuditService;
  now?: () => number;
}
/** 撤销原因——写进 Lease.revokeReason 与审计，便于事后回答「这条授权是谁收的」。 */
export const CONSOLE_REVOKE_REASON = "governance console: 用户提前收回";
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
}
function assertSessionId(sessionId: string): void {
  // 作用：Fail Closed —— 会话 ID 必须是非空字符串（治理动作不接受空目标）
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("GUARD_CONSOLE_INVALID: sessionId must be a non-empty string");
  }
}
