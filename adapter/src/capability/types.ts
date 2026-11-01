// 作用：Universal Mode 核心领域类型（重构规格第 5.2 节）——与 DSH 运行时解耦的纯数据模型，
// 供 LeaseManager / UniversalGate / Audit 共用；禁止在本文件引入任何 DSH/Cordis 依赖。
import type { SandboxMode } from "./escalation.js";
export type LeaseStatus = "ACTIVE" | "REVOKED" | "EXPIRED";
/** 授权种类：只有一种——「审批层短期授权」。2026-11-01 已移除 sandbox-mode（提升沙箱档位）那一类：
 * 本插件不改写会话沙箱档位，批准一次只放行当次调用 + 在 TTL 内复用同一条操作。 */
export type LeaseKind = "universal";
export type ScopeKind = "exact-arguments" | "fields" | "tool";
export interface CapabilityScope {
  kind: ScopeKind;
  /** 用于匹配的稳定 key；只允许 hash 或稳定字符串，不允许包含 Secret 原文 */
  key: string;
  /** 给用户展示；必须经过脱敏（敏感字段值替换为 ***） */
  display: string;
}
export interface CapabilityLease {
  id: string;
  kind: LeaseKind;
  sessionId: string;
  toolName: string;
  scope: CapabilityScope;
  issuedAt: number;
  expiresAt: number;
  status: LeaseStatus;
  revokedAt?: number;
  revokeReason?: string;
  sourceCallId?: string;
}
export type PendingDecision = "PENDING" | "LEASE_REUSED" | "ASKED" | "APPROVED" | "REJECTED";
export interface PendingExecution {
  callId: string;
  rootCallId: string;
  sessionId: string;
  toolName: string;
  scope: CapabilityScope;
  ttlSeconds: number;
  startedAt: number;
  leaseId?: string;
  decision: PendingDecision;
  /** 本次调用申请的目标沙箱档位（仅沙箱升级调用有）——免打扰窗口据此判断「这是一次升级」 */
  mode?: SandboxMode;
}
export type PreToolDecisionKind = "allow" | "deny" | "ask";
export interface PreToolDecision {
  kind: PreToolDecisionKind;
  reason?: string;
}
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
// 作用：Guard 所需的 DSH ToolExecution 最小形状（重构规格第 34 节校验基线 2026-09-14：
// ToolExecution 包含 callId/rootCallId/name/arguments/agent/signal，Agent.id 即 SessionId）。
// 接入真实 DSH 时以当前安装版本官方 TypeScript 类型定义为准逐字段核对（规则 4，禁止凭猜测硬编码）。
export interface ToolExecutionLike {
  callId: string;
  rootCallId: string;
  name: string;
  arguments: unknown;
  agent?: { id: string };
  signal?: AbortSignal;
}
// 作用：Guard 所需的 DSH Approval Request 最小形状（规格第 34 节：包含 agent/toolName/callId/reason/signal，
// 不复制 arguments）；同样以实际安装版本类型定义为准。
export interface ApprovalRequestLike {
  callId?: string;
  agent?: unknown;
  toolName?: string;
  reason?: string;
  signal?: AbortSignal;
}
