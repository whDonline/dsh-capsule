import type { AuditDecision, ToolAuditEvent } from "../audit/types.js";
import type { SandboxMode } from "../capability/escalation.js";
import type { CapabilityLease, LeaseKind, LeaseStatus, ScopeKind } from "../capability/types.js";
import type { SandboxModeOutcome, SessionGrantState } from "../capability/sandbox-grant.js";
// 作用：治理台只读视图——授权、工具统计与审计；不暴露原始工具参数。
export interface ConsolePluginView {
  id: string;
  kind: "guard";
}
export interface ConsoleToolStat {
  toolName: string;
  /** 去重调用数（按 callId：一条调用链 ASK→LEASE_ISSUED→TOOL_SUCCESS 产生多条事件只计 1 次） */
  invocations: number;
  ask: number;
  leaseIssued: number;
  leaseReused: number;
  approvalRejected: number;
  passthroughAllow: number;
  passthroughDeny: number;
  toolSuccess: number;
  toolError: number;
  lastActivityAt: number;
}
export interface ConsoleLeaseView {
  id: string;
  kind: LeaseKind;
  sessionId: string;
  toolName: string;
  scopeKind: ScopeKind;
  /** 脱敏后的 Scope 展示串（Lease 从不保存参数原文） */
  scopeDisplay: string;
  issuedAt: number;
  expiresAt: number;
  status: LeaseStatus;
  /** 视图层实时剩余毫秒 max(0, expiresAt - now)；安全校验仍以 LeaseManager.validate 为准 */
  remainingMs: number;
  revokedAt?: number;
  revokeReason?: string;
}
/** 授权（Lease）是否仍然有效——与沙箱档位是否已恢复是【两个独立状态】，不得合并成一个倒计时。 */
export type ConsoleAuthState = "active" | "expiring" | "expired" | "revoked" | "none";
/** 沙箱档位状态——回答「那一次放宽是否已经收回去了」。语义逐条对应 capability/sandbox-grant.ts：
 *   raised          Guard 提升过档位，且授权仍有效
 *   unchanged       授权仍有效，但档位本来就够宽（Guard 没改过）
 *   user-override   档位现在是用户自己设定的值（Guard 不覆盖用户选择）；授权可能仍有效，但不再生效
 *   pending-restore 授权已失效，档位仍是 Guard 写入的宽值——【倒计时归零后最危险的那个中间态】
 *   restored        授权已失效，档位已回滚
 *   not-involved    本会话没有沙箱授权
 *   unknown         读不到宿主档位（能力缺失）——此时绝不允许声称「已恢复」 */
export type ConsoleSandboxState = "raised" | "unchanged" | "user-override" | "pending-restore" | "restored" | "not-involved" | "unknown";
export interface ConsoleGrantView {
  id: string;
  toolName: string;
  kind: LeaseKind;
  /** 人话能力描述（UI 首屏直接展示，避免用户理解 Scope/Lease） */
  capabilityText: string;
  /** 人话授权原因（何时、为什么批准） */
  reasonText: string;
  scopeKind: ScopeKind;
  /** 完整 Scope 展示串——只进展开详情，不进首屏 */
  scopeDisplay: string;
  /** Scope key 前 8 位（技术详情用） */
  scopeKeyShort: string;
  issuedAt: number;
  expiresAt: number;
  remainingMs: number;
  /** 沙箱授权对应的目标档位（来自沙箱授权记录，可能缺失） */
  targetMode?: SandboxMode;
}
export interface ConsoleSessionAuth {
  state: ConsoleAuthState;
  activeCount: number;
  /** 仍有效的授权里最早到期的时间与剩余毫秒（无有效授权时缺省） */
  nextExpiresAt?: number;
  remainingMs?: number;
  grants: ConsoleGrantView[];
}
export interface ConsoleSandboxView {
  state: ConsoleSandboxState;
  /** 宿主实时读到的当前档位；undefined = 读不到（不许推断为「已恢复」） */
  currentMode?: SandboxMode;
  /** Guard 介入前的档位（回滚落点） */
  baselineMode?: SandboxMode;
  /** 被授权允许的最高档位 */
  targetMode?: SandboxMode;
  /** 本次读数的产生时间——UI 据此展示「核对中」，而不是拿倒计时推断 */
  checkedAt: number;
  lastOutcomeAt?: number;
  /** 人话补充说明（例如「你已把档位调回 workspace-write，Guard 不会覆盖」） */
  note?: string;
}
export interface ConsoleSessionView {
  sessionId: string;
  label: string;
  labelSource: "title" | "cwd" | "id";
  cwd?: string;
  auth: ConsoleSessionAuth;
  sandbox: ConsoleSandboxView;
  /** 价值指标（少点了几次批准 / 最长放开多久 / 有没有待收回的权限级别） */
  stats: ConsoleSessionStats;
  actions: {
    /** 有仍有效的授权可撤销 */
    canRevoke: boolean;
    /** 存在「授权已失效但档位未回滚」的情形，可手动立即回滚（纯收缩动作） */
    canRestoreSandbox: boolean;
  };
}
/** 作用：会话级价值指标——回答「这个插件到底帮我省了什么」，同时暴露需要人处理的风险。 */
export interface ConsoleSessionStats {
  /** 授权总条数（含已结束的） */
  total: number;
  /** 仍可复用的授权 */
  active: number;
  /** 因为复用而少点的批准次数 */
  savedApprovals: number;
  /** 最长一次放开的时长（毫秒） */
  longestWindowMs: number;
  /** 提升过权限级别的授权数 */
  raised: number;
  /** 已结束但仍未收回权限级别的授权数（需要处理） */
  pendingRestore: number;
}
export interface ConsoleFocus {
  sessionId?: string;
  /** explicit = 调用方指定（面板/URL 传入）；recent-activity = 按最近授权/活动推断；none = 没有任何会话 */
  source: "explicit" | "recent-activity" | "none";
}
/** 会话名称解析（宿主能力可选）：读 DSH 的 sessionTitle，读不到就降级为 cwd 或短 ID。 */
export interface ConsoleSessionDescriptor {
  label: string;
  source: "title" | "cwd" | "id";
  cwd?: string;
}
export interface ConsoleSessionDirectory {
  describe(sessionId: string): ConsoleSessionDescriptor;
}
/** 沙箱状态数据源（由 SandboxGrantManager 提供；未注入时治理台显示「不涉及沙箱」） */
export interface ConsoleSandboxSource {
  states(): readonly SessionGrantState[];
  lastOutcomeOf(sessionId: string): { outcome: SandboxModeOutcome; mode: SandboxMode; at: number } | undefined;
}
/** 收缩型治理动作（撤销授权 / 回滚档位）——只能收紧权限，永远不能放开。 */
export interface ConsoleRevokeResult {
  sessionId: string;
  revoked: number;
  results: readonly { outcome: string; mode: SandboxMode }[];
}
export interface ConsoleRestoreResult {
  sessionId: string;
  results: readonly { outcome: string; mode: SandboxMode }[];
}
/** 免打扰窗口请求——用户显式点击后由页面发起，等价于一次 allowed-once，但有界（TTL）且可随时收回。 */
export interface ConsoleWindowRequest {
  sessionId: string;
  /** 对哪个工具免打扰（与配置里的 escalation 规则一致，例如 pwsh） */
  toolName: string;
  /** 提升到哪一档（只允许沙箱档位闭集） */
  mode: SandboxMode;
  /** 窗口时长（秒），不得超过运行期 maxTtlSeconds */
  ttlSeconds: number;
}
export interface ConsoleWindowResult {
  sessionId: string;
  leaseId: string;
  /** 实际生效的档位（可能是"本来就够宽"的原档位） */
  mode: SandboxMode;
  outcome: string;
  expiresAt: number;
}
export interface ConsoleActions {
  revokeSession(sessionId: string): Promise<ConsoleRevokeResult>;
  restoreSandbox(sessionId: string): Promise<ConsoleRestoreResult>;
  /** 有界放宽：开启免打扰窗口（唯一由页面发起的放宽动作，受 TTL 上限与沙箱档位闭集约束） */
  openWindow(request: ConsoleWindowRequest): Promise<ConsoleWindowResult>;
}
export interface GovernanceSummary {
  leasesTotal: number;
  leasesActive: number;
  leasesRevoked: number;
  leasesExpired: number;
  auditedEvents: number;
}
export interface GovernanceSnapshot {
  /** 快照契约版本：2 = 增加会话视图与两状态（旧字段保持兼容，便于渐进升级） */
  schemaVersion: number;
  generatedAt: number;
  guardName: string;
  summary: GovernanceSummary;
  plugins: ConsolePluginView[];
  tools: ConsoleToolStat[];
  /** 最近活动（最新在前，条数受 activityLimit 约束） */
  activity: ToolAuditEvent[];
  leases: ConsoleLeaseView[];
  /** 当前聚焦的会话（默认展示它；未传 session 查询参数时按最近活动推断） */
  focus: ConsoleFocus;
  /** 会话视图（focus 的会话在最前） */
  sessions: ConsoleSessionView[];
}
export interface ConsoleAuditQuery {
  sessionId?: string;
  toolName?: string;
  decision?: AuditDecision;
  limit?: number;
}
export interface SnapshotOptions {
  /** 显式聚焦的会话（来自 ?session= 或面板传入）——即使该会话没有任何授权也会返回一个空视图 */
  sessionId?: string;
}
// 作用：治理台依赖审计与授权的最小数据源，不反向依赖具体实现，便于独立单测。
export interface ConsoleAuditSource {
  list(limit?: number): ToolAuditEvent[];
}
export interface ConsoleLeaseSource {
  list(): Promise<readonly CapabilityLease[]>;
}
export interface GovernanceConsoleDeps {
  audit: ConsoleAuditSource;
  leases: ConsoleLeaseSource;
  guardName?: string;
  /** 快照 Activity 区块保留的最近事件条数（默认 50，必须为正整数） */
  activityLimit?: number;
  /** 可注入时钟（默认 Date.now），供测试模拟时间推进 */
  now?: () => number;
  /** 沙箱授权状态源（可选：未注入时所有会话的沙箱状态为 not-involved） */
  sandbox?: ConsoleSandboxSource;
  /** 会话名称解析（可选：未注入时降级为「会话 短ID」） */
  sessions?: ConsoleSessionDirectory;
}
export interface ConsoleHttpConfig {
  /** 是否启动本地只读 Console HTTP 查看器（默认 false：仅提供编程 API，不监听任何端口） */
  enabled?: boolean;
  /** 监听地址，默认 127.0.0.1（默认 127.0.0.1，仅 loopback；如需远程查看请自行评估暴露面） */
  host?: string;
  /** 监听端口，默认 8787（传 0 时由操作系统分配随机可用端口） */
  port?: number;
}
