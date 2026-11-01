import type { AuditService } from "../audit/audit-service.js";
import type { LeaseManager } from "../capability/lease-manager.js";
import type { ConsoleRevokeResult } from "./types.js";
// 作用：治理台收缩型动作——只剩「撤销该会话仍有效的全部授权」。
//
// 【2026-11-01 移除】旧的 restoreSandbox（回滚档位）与 openWindow（签发 sandbox-mode 授权并提升档位）
// 已随「提升沙箱档位」整条链路删除：本插件不写沙箱档位，治理台也没有任何放宽型动作。
// 因此动作层现在只有纯收缩语义：撤销后下一次同类调用重新走 DSH 原生审批。
export interface GuardActionDeps {
  leases: LeaseManager;
  audit: AuditService;
}
/** 撤销原因——写进 Lease.revokeReason 与审计，便于事后回答「这条授权是谁收的」。 */
export const CONSOLE_REVOKE_REASON = "governance console: 用户提前收回";
export class GuardActions {
  constructor(private readonly deps: GuardActionDeps) {}
  async revokeSession(sessionId: string): Promise<ConsoleRevokeResult> {
    // 作用：撤销某会话仍有效的全部授权；幂等（没有可撤销的授权时返回 revoked=0）。
    // 撤销只影响授权本身：沙箱档位是用户自己的设置，Guard 从不改写它。
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
    return { sessionId, revoked };
  }
}
function assertSessionId(sessionId: string): void {
  // 作用：Fail Closed —— 会话 ID 必须是非空字符串（治理动作不接受空目标）
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("GUARD_CONSOLE_INVALID: sessionId must be a non-empty string");
  }
}
