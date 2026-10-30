import type { AuditService } from "../audit/audit-service.js";
import type { SandboxModeResult } from "./sandbox-grant.js";
// 作用：把一次沙箱模式结果写成审计事件——展示文案只在此处生成，避免 gate 与治理台各写一套。
// 【必须携带 sessionId/leaseId】这两条事件回答的是「哪个会话的档位被收回了、对应哪条授权」，
// 历史缺陷正是这里没有归属字段，导致治理台无法把「授权失效」与「档位已恢复」两个状态对上。
// 未真正发生模式变更的结果（UNCHANGED / RAISED 由调用方另行记录）不在此产生事件，避免审计噪声。
export function recordSandboxOutcome(audit: AuditService, result: SandboxModeResult): void {
  if (result.outcome === "RESTORED") {
    audit.record({
      sessionId: result.sessionId,
      leaseId: result.leaseId,
      callId: "",
      rootCallId: "",
      toolName: "",
      scopeDisplay: `沙箱模式回滚至 ${result.mode}`,
      decision: "SANDBOX_MODE_RESTORED",
    });
  } else if (result.outcome === "SKIPPED_USER_OVERRIDE") {
    audit.record({
      sessionId: result.sessionId,
      leaseId: result.leaseId,
      callId: "",
      rootCallId: "",
      toolName: "",
      scopeDisplay: `会话沙箱模式为 ${result.mode}（用户已改动），跳过回滚`,
      decision: "SANDBOX_MODE_SKIPPED_USER_OVERRIDE",
    });
  }
}
