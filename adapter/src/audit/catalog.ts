// 作用：审计决策的**唯一事实来源**——类型、运行期白名单与中文文案集中在这里，
// 任何新决策只需在本文件加一项，接口校验（http-server）、决策记录（decisions.ts）与前端展示
// （由 /api/audit 下发 decisionLabel）都会自动跟上。
// 历史教训：这三处原本各写一份平行清单，加一个新的 decision 时必须改三个文件，漏一处就是"静默不显示"。
export const AUDIT_DECISIONS = [
  "PASSTHROUGH_ALLOW",
  "PASSTHROUGH_DENY",
  "ASK",
  "LEASE_REUSED",
  "LEASE_ISSUED",
  "LEASE_REVOKED",
  "APPROVAL_REJECTED",
  "TOOL_SUCCESS",
  "TOOL_ERROR",
  "DND_OPENED",
  "DND_ALLOWED",
  "DND_EXTENDED",
  "DND_CLOSED",
] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];
/** 面向用户的中文说法——前端不再自己维护映射表，直接展示服务端下发的 label。 */
export const AUDIT_DECISION_LABELS: Record<AuditDecision, string> = {
  PASSTHROUGH_ALLOW: "原生放行",
  PASSTHROUGH_DENY: "原生拒绝",
  ASK: "已询问",
  LEASE_REUSED: "复用临时授权",
  LEASE_ISSUED: "已签发临时授权",
  LEASE_REVOKED: "已提前收回",
  APPROVAL_REJECTED: "你拒绝了",
  TOOL_SUCCESS: "执行成功",
  TOOL_ERROR: "执行失败",
  DND_OPENED: "开启免打扰（限时完全访问）",
  DND_ALLOWED: "免打扰自动放行",
  DND_EXTENDED: "延长免打扰窗口",
  DND_CLOSED: "结束免打扰窗口",
};
/** 作用：运行期合法性校验（查审计接口的 ?decision= 参数时用）。 */
export function isAuditDecision(value: unknown): value is AuditDecision {
  return typeof value === "string" && (AUDIT_DECISIONS as readonly string[]).includes(value);
}
