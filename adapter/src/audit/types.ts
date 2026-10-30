// 作用：审计事件类型（重构规格第 9 节）——类型层面即禁止记录完整 Tool Arguments、
// Credential、Authorization Header、Token、Cookie、Password；Args 只允许 scope hash + 脱敏 display。
// 决策枚举与其中文文案的唯一来源是 `audit/catalog.ts`（本文件只做再导出，避免出现第二份清单）。
import type { AuditDecision } from "./catalog.js";
export type { AuditDecision } from "./catalog.js";
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
