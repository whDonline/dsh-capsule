// 作用：审计事件类型（重构规格第 9 节）——类型层面即禁止记录完整 Tool Arguments、
// Credential、Authorization Header、Token、Cookie、Password；Args 只允许 scope hash + 脱敏 display。
export type AuditDecision =
  | "PASSTHROUGH_ALLOW"
  | "PASSTHROUGH_DENY"
  | "ASK"
  | "LEASE_REUSED"
  | "LEASE_ISSUED"
  | "APPROVAL_REJECTED"
  | "TOOL_SUCCESS"
  | "TOOL_ERROR"
  /** P0-2：沙箱升级被批准后提升了会话沙箱模式（scopeDisplay 含工具名与目标模式） */
  | "SANDBOX_MODE_RAISED"
  /** P0-2：Lease 结束（撤销/到期）后会话沙箱模式已回滚 */
  | "SANDBOX_MODE_RESTORED"
  /** P0-2：模式已被用户手动改动，Guard 主动跳过回滚以免覆盖用户选择 */
  | "SANDBOX_MODE_SKIPPED_USER_OVERRIDE"
  /** 治理台：用户从页面提前收回了一条授权（收缩型动作，只会让权限变小） */
  | "LEASE_REVOKED";
export interface ToolAuditEvent {
  id: string;
  timestamp: number;
  sessionId?: string;
  callId: string;
  rootCallId: string;
  toolName: string;
  scopeKey?: string;
  scopeDisplay?: string;
  leaseId?: string;
  decision: AuditDecision;
}
