import type { AuditDecision, ToolAuditEvent } from "../audit/types.js";
import type { SandboxMode } from "../capability/escalation.js";
import type { CapabilityLease, LeaseKind, ScopeKind } from "../capability/types.js";
// 作用：治理台只读视图——会话、授权与决策记录；不暴露原始工具参数。
// 2026-10-31 清理：plugins / tools / leases / activity 四个快照字段没有任何界面或生产代码读取
//（只有测试在读），已随「无调用方的冗余」一并移除；需要原始事件请用 /api/audit，需要授权明细请看 sessions。
// 2026-11-01 清理：沙箱档位提升/回滚链路删除后，会话视图里的 sandbox 只剩「宿主当前档位」这一项读数；
// raised / pending-restore / restored / user-override 这些状态机字段全部移除（它们描述的是 Guard 改写过档位，
// 而本插件从 2026-11-01 起不再写沙箱档位）。
/** 授权（Lease）是否仍然有效——四态只由 Lease 自身决定。 */
export type ConsoleAuthState = "active" | "expiring" | "expired" | "revoked" | "none";
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
}
export interface ConsoleSessionAuth {
  state: ConsoleAuthState;
  activeCount: number;
  /** 仍有效的授权里最早到期的时间与剩余毫秒（无有效授权时缺省） */
  nextExpiresAt?: number;
  remainingMs?: number;
  grants: ConsoleGrantView[];
}
/** 会话当前沙箱档位（宿主实时读数）——只用于展示与免打扰适用性判断，不是 Guard 的状态。 */
export interface ConsoleSandboxView {
  /** 宿主实时读到的当前档位；undefined = 读不到（不许推断，页面显示「未知」） */
  currentMode?: SandboxMode;
  /** 档位的中文说法（服务端下发，前端不再自己维护映射表） */
  currentModeText?: string;
  /** 本次读数的产生时间——UI 据此展示「核对于 …」 */
  checkedAt: number;
}
/** 免打扰窗口内一次自动放行的记录（脱敏展示；不含参数原文）。 */
export interface ConsoleDndRecord {
  at: number;
  callId: string;
  toolName: string;
  requestedMode: SandboxMode;
  /** 目标档位中文名（服务端下发） */
  requestedModeText: string;
  display: string;
}
/** 免打扰窗口视图——与 Lease 完全分开：它不是一条授权，而是"限时完全访问"的审批放行窗口。 */
export interface ConsoleDndView {
  sessionId: string;
  startedAt: number;
  expiresAt: number;
  /** 开启窗口时的档位；用于解释"档位被改后窗口结束" */
  baselineMode?: SandboxMode;
  /** 窗口内已自动放行的次数 */
  allowedCount: number;
  /** 最近几条放行记录（最新在前，最多 20 条） */
  recent: readonly ConsoleDndRecord[];
}
export interface ConsoleSessionView {
  sessionId: string;
  label: string;
  labelSource: "title" | "cwd" | "id";
  cwd?: string;
  auth: ConsoleSessionAuth;
  sandbox: ConsoleSandboxView;
  /** 免打扰窗口（仅当存在活动窗口时下发；没有窗口就没有这个字段） */
  dnd?: ConsoleDndView;
  /** 价值指标（少点了几次批准 / 最长放开多久） */
  stats: ConsoleSessionStats;
  actions: {
    /** 有仍有效的授权可撤销 */
    canRevoke: boolean;
  };
}
/** 作用：会话级价值指标——回答「这个插件到底帮我省了什么」。 */
export interface ConsoleSessionStats {
  /** 授权总条数（含已结束的） */
  total: number;
  /** 仍可复用的授权 */
  active: number;
  /** 因为复用而少点的批准次数 */
  savedApprovals: number;
  /** 最长一次放开的时长（毫秒） */
  longestWindowMs: number;
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
/** 收缩型治理动作（撤销授权）——只能收紧权限，永远不能放开。 */
export interface ConsoleRevokeResult {
  sessionId: string;
  revoked: number;
}
export interface ConsoleActions {
  revokeSession(sessionId: string): Promise<ConsoleRevokeResult>;
  /** 免打扰时间窗：只放行审批，**不改沙箱档位**（原生档位保持用户设定值） */
  startDnd?(sessionId: string, ttlSeconds: number): { sessionId: string; expiresAt: number };
  /** 提前结束免打扰窗口（纯收缩） */
  stopDnd?(sessionId: string): boolean;
  /** 延长免打扰窗口（仍受 maxTtlSeconds 约束，不能续成永久授权） */
  extendDnd?(sessionId: string, addSeconds: number): { sessionId: string; expiresAt: number };
}
export interface GovernanceSummary {
  leasesTotal: number;
  leasesActive: number;
  leasesRevoked: number;
  leasesExpired: number;
  auditedEvents: number;
}
export interface GovernanceSnapshot {
  /** 快照契约版本：4 = 移除沙箱档位状态机（sandbox 只剩当前档位读数） */
  schemaVersion: number;
  generatedAt: number;
  guardName: string;
  summary: GovernanceSummary;
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
  /** 可注入时钟（默认 Date.now），供测试模拟时间推进 */
  now?: () => number;
  /** 免打扰窗口状态源（可选：未注入时会话视图不带 dnd 字段） */
  dnd?: { view(sessionId: string): ConsoleDndView | undefined };
  /** 当前会话沙箱档位（可选：未注入时 currentMode 缺失，页面显示「未知」） */
  currentMode?: (sessionId: string) => SandboxMode | undefined;
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
