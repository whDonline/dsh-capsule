// 作用：Universal Mode 核心领域类型（重构规格第 5.2 节）——与 DSH 运行时解耦的纯数据模型，
// 供 LeaseManager / UniversalGate / Audit 共用；禁止在本文件引入任何 DSH/Cordis 依赖。
import type { SandboxMode } from "./escalation.js";
export type LeaseStatus = "ACTIVE" | "REVOKED" | "EXPIRED";
/** sandbox-mode 是 P0-2 新增的 Lease 种类：其授权效果是「提升会话沙箱模式」，复用语义按 (toolName, 目标模式) */
export type LeaseKind = "universal" | "sandbox-mode";
export type ScopeKind = "exact-arguments" | "fields" | "tool" | "sandbox-escalation";
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
}
export type PreToolDecisionKind = "allow" | "deny" | "ask";
export interface PreToolDecision {
  kind: PreToolDecisionKind;
  reason?: string;
}
// 作用（P0-2）：一次「沙箱升级」待批准上下文——由 tools/execute 在工具体运行之前记录，
// 供 approval/request 在拿到 allowed-once 后签发 sandbox-mode Lease 并提升会话模式。
// 为什么不复用 PendingExecution：PendingExecution 表达的是「pre-execute 已 ASK 的调用」，
// 而沙箱升级在 pre-execute 阶段并不 ASK（下游默认 allow），两者是不同的等待状态，混用会污染语义。
export interface EscalationGrant {
  callId: string;
  rootCallId: string;
  sessionId: string;
  /** tools/execute 阶段观察到的 session 对象——审批通过后提升沙箱模式时要用它读写 session log。
   * 刻意在此暂存而不是从 approval/request 载荷取：载荷的 agent 形状随版本变化，而这里是 Guard
   * 自己在工具执行阶段亲自观察到的对象，来源更可靠（载荷 agent 仅作为兜底）。 */
  session?: unknown;
  toolName: string;
  scope: CapabilityScope;
  /** 目标沙箱模式（来自工具参数，已通过闭集校验） */
  requestedMode: SandboxMode;
  ttlSeconds: number;
  startedAt: number;
  /** tools/result 到达时间——工具本次调用已结束。**不可据此立刻删除本记录**：
   * 实测（真 cordis 集成测试）存在 tools/result 早于 approval/request 到达的时序，
   * 若立刻删除，随后到达的审批就会找不到上下文而无法签发授权（授权静默失效）。
   * 因此只标记时间，由 settleAll 在宽限期后清理。 */
  settledAt?: number;
}
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
// 作用：Guard 所需的 DSH ToolExecution 最小形状（重构规格第 34 节校验基线 2026-09-14：
// ToolExecution 包含 callId/rootCallId/name/arguments/agent/signal，Agent.id 即 SessionId）。
// 接入真实 DSH 时以当前安装版本官方 TypeScript 类型定义为准逐字段核对（规则 4，禁止凭猜测硬编码）。
// agent.session 是本项目额外声明的可选字段：真实 DSH 的 Agent 带有 .session 访问器（approval 载荷同样
// 可达），沙箱模式提升需要它来读写 session log（ctx.sessionProjections.stateOf / session.append）。
export interface ToolExecutionLike {
  callId: string;
  rootCallId: string;
  name: string;
  arguments: unknown;
  agent?: { id: string; session?: unknown };
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
