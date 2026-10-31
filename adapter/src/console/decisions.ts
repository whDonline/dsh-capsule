import type { ToolAuditEvent } from "../audit/types.js";
import { sandboxModeLabel, type SandboxMode } from "../capability/escalation.js";
import type { CapabilityLease, LeaseKind, ScopeKind } from "../capability/types.js";
import type { SessionGrantState } from "../capability/sandbox-grant.js";
// 作用：把「审计事件流」折叠成「授权决策日志」——一条授权 = 一条记录，回答四个问题：
//   谁在什么时候批准了什么（批准）→ 被复用了多少次（使用）→ 权限级别有没有被抬/收（变更）→ 怎么结束的（结束）。
// 为什么不再直接展示原始事件：PASSTHROUGH_ALLOW / TOOL_SUCCESS 这类是**遥测**，一条真实会话里能占九成以上，
// 把真正的授权决策埋在噪声里，用户会问"审计到底审计了什么"。原始事件仍然保留，但降级为排障用的可展开区域。
//
// 【纯函数】本模块不读写任何运行时状态：只消费 Lease 列表、审计事件与沙箱状态投影，
// 因此可以独立单测，也不会给工具调用热路径增加任何开销（查询时才计算）。
export interface DecisionSandboxEffect {
  /** 这次授权要求的目标档位 */
  requestedMode?: SandboxMode;
  /** 实际提升到的档位（未提升则缺省） */
  raisedTo?: SandboxMode;
  /** 提升档位的中文说法（服务端下发，前端不再自己映射） */
  raisedToText?: string;
  /** 权限级别被收回的时间与落点 */
  restoredAt?: number;
  restoredTo?: SandboxMode;
  restoredToText?: string;
  /** 权限级别被用户改过，Guard 主动跳过回滚 */
  skipped?: boolean;
}
export interface DecisionRecord {
  leaseId: string;
  sessionId: string;
  toolName: string;
  kind: LeaseKind;
  scopeKind: ScopeKind;
  /** 人话能力描述（"pwsh 可以免审批升到「完全访问」"） */
  capability: string;
  /** 批准时给出的说明（可能来自模型的 justification，已脱敏截断） */
  reason: string;
  grantedAt: number;
  expiresAt: number;
  /** 有效期（秒）——展示"你批了 5 分钟" */
  ttlSeconds: number;
  /** 这条授权被复用的次数（= 用户少点的批准次数） */
  uses: number;
  /** ② 同族模式的复用来自哪个族（审计串「凭族放行：xxx」里取回） */
  familyLabel?: string;
  lastUsedAt?: number;
  /** active = 仍可复用；expired = 自然到期；revoked = 被提前收回 */
  outcome: "active" | "expired" | "revoked";
  endedAt?: number;
  revokedReason?: string;
  /** 这条授权对会话权限级别造成的效果（非沙箱授权则缺省） */
  sandbox?: DecisionSandboxEffect;
  /** 实际放开时长：active 时算到 now，结束时算到 endedAt */
  windowMs: number;
}
export interface DecisionSummary {
  /** 授权条数 */
  total: number;
  /** 仍可用的授权 */
  active: number;
  /** 因为复用而少点的批准次数（价值指标） */
  savedApprovals: number;
  /** 最长一次放开的时长 */
  longestWindowMs: number;
  /** 提升过权限级别的授权数 */
  raised: number;
  /** 授权已失效但权限级别还没收回（需要人处理） */
  pendingRestore: number;
  /** 复用来源分布：精确匹配 / 族放行 / 免打扰窗口 */
  reuseByKind: { exact: number; family: number; window: number };
  /** 命中最多的族（Top 3，只有 ② 同族模式会产生） */
  topFamilies: { label: string; count: number }[];
}
export interface DecisionBuildInput {
  leases: readonly CapabilityLease[];
  events: readonly ToolAuditEvent[];
  /** 沙箱状态投影（可选：没有它就不展示权限级别细节，但决策本身仍成立） */
  grantStates?: readonly SessionGrantState[];
  now: number;
  /** 只看某个会话 */
  sessionId?: string;
  /** 只看某个工具 */
  toolName?: string;
  /** 最多返回多少条（最新在前） */
  limit?: number;
}
/** 作用：把 Scope 翻译成一句人话——用户不需要知道 exact-arguments / SHA-256 是什么。 */
export function describeCapability(lease: CapabilityLease, targetMode?: SandboxMode): string {
  if (lease.kind === "sandbox-mode") {
    return targetMode ? `${lease.toolName} 可以免审批升到「${sandboxModeLabel(targetMode)}」` : `${lease.toolName} 的沙箱升级已获批准`;
  }
  if (lease.scope.kind === "exact-arguments") return `${lease.toolName} 的这条操作（与上次完全一致）在到期前不再询问`;
  if (lease.scope.kind === "fields") return `${lease.toolName} 在相同字段范围内重试，不再询问`;
  if (lease.scope.kind === "tool") return `${lease.toolName} 的任何调用都不再询问（范围最宽）`;
  return `${lease.toolName} 的同类调用不再询问`;
}
/** 作用：档位中文名的唯一来源在 `capability/escalation.ts`（`sandboxModeLabel`），本模块不再维护第二份映射。 */
export function buildDecisions(input: DecisionBuildInput): DecisionRecord[] {
  // 作用：按 leaseId 归并事件，生成「一条授权一份记录」的决策日志。
  // 授予来源：Lease 本身（权威时间与状态）；使用次数与结束方式：审计事件；权限级别效果：沙箱状态投影。
  const byLease = new Map<string, ToolAuditEvent[]>();
  for (const event of input.events) {
    if (!event.leaseId) continue;
    const bucket = byLease.get(event.leaseId);
    if (bucket) bucket.push(event);
    else byLease.set(event.leaseId, [event]);
  }
  const sandboxByLease = new Map<string, SessionGrantState>();
  for (const state of input.grantStates ?? []) {
    for (const grant of state.grants) sandboxByLease.set(grant.leaseId, state);
  }
  const records: DecisionRecord[] = [];
  for (const lease of input.leases) {
    if (input.sessionId !== undefined && lease.sessionId !== input.sessionId) continue;
    if (input.toolName !== undefined && lease.toolName !== input.toolName) continue;
    const events = byLease.get(lease.id) ?? [];
    const reused = events.filter((event) => event.decision === "LEASE_REUSED");
    const issued = events.find((event) => event.decision === "LEASE_ISSUED" || event.decision === "WINDOW_OPENED" || event.decision === "SANDBOX_MODE_RAISED");
    const restored = events.find((event) => event.decision === "SANDBOX_MODE_RESTORED");
    const skipped = events.some((event) => event.decision === "SANDBOX_MODE_SKIPPED_USER_OVERRIDE");
    const state = sandboxByLease.get(lease.id);
    const grant = state?.grants.find((item) => item.leaseId === lease.id);
    const active = lease.status === "ACTIVE" && input.now < lease.expiresAt;
    const endedAt = lease.status === "REVOKED" ? (lease.revokedAt ?? lease.expiresAt) : active ? undefined : lease.expiresAt;
    const sandbox: DecisionSandboxEffect | undefined = grant
      ? {
          requestedMode: grant.requestedMode,
          raisedTo: grant.raised ? grant.writtenMode : undefined,
          raisedToText: grant.raised ? sandboxModeLabel(grant.writtenMode) : undefined,
          restoredAt: restored?.timestamp,
          restoredTo: restored ? restoredMode(restored) : undefined,
          restoredToText: restored ? sandboxModeLabel(restoredMode(restored)) : undefined,
          skipped: skipped || undefined,
        }
      : undefined;
    records.push({
      leaseId: lease.id,
      sessionId: lease.sessionId,
      toolName: lease.toolName,
      kind: lease.kind,
      scopeKind: lease.scope.kind,
      capability: describeCapability(lease, grant?.requestedMode),
      reason: approvedReason(issued, lease),
      grantedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      ttlSeconds: Math.max(0, Math.round((lease.expiresAt - lease.issuedAt) / 1000)),
      uses: reused.length,
      familyLabel: reused.map((event) => familyOf(event)).find((label) => label !== undefined),
      lastUsedAt: reused.length > 0 ? Math.max(...reused.map((event) => event.timestamp)) : undefined,
      outcome: active ? "active" : lease.status === "REVOKED" ? "revoked" : "expired",
      endedAt,
      revokedReason: lease.revokeReason,
      sandbox,
      windowMs: Math.max(0, (endedAt ?? input.now) - lease.issuedAt),
    });
  }
  records.sort((a, b) => b.grantedAt - a.grantedAt);
  return input.limit !== undefined ? records.slice(0, input.limit) : records;
}
export function summarizeDecisions(records: readonly DecisionRecord[]): DecisionSummary {
  // 作用：把决策日志压成一行可展示的「价值指标」——尤其是 savedApprovals（用户少点了几次批准）。
  let savedApprovals = 0;
  let longestWindowMs = 0;
  let raised = 0;
  let active = 0;
  let pendingRestore = 0;
  // 复用来源分布：① 精确匹配 / ② 族放行（审计串里带「凭族放行」）/ ③ 免打扰窗口（sandbox-mode 授权被复用）
  const reuseByKind = { exact: 0, family: 0, window: 0 };
  const familyCounts = new Map<string, number>();
  for (const record of records) {
    savedApprovals += record.uses;
    longestWindowMs = Math.max(longestWindowMs, record.windowMs);
    if (record.sandbox?.raisedTo) raised += 1;
    if (record.outcome === "active") active += 1;
    if (record.uses > 0) {
      if (record.kind === "sandbox-mode") reuseByKind.window += record.uses;
      else if (record.familyLabel) {
        reuseByKind.family += record.uses;
        familyCounts.set(record.familyLabel, (familyCounts.get(record.familyLabel) ?? 0) + record.uses);
      } else reuseByKind.exact += record.uses;
    }
    // 「授权已结束但权限级别没被收回」：沙箱授权提升过、已结束、且没有恢复记录也没有跳过记录
    if (record.sandbox?.raisedTo && record.outcome !== "active" && !record.sandbox.restoredAt && !record.sandbox.skipped) {
      pendingRestore += 1;
    }
  }
  const topFamilies = [...familyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([label, count]) => ({ label, count }));
  return { total: records.length, active, savedApprovals, longestWindowMs, raised, pendingRestore, reuseByKind, topFamilies };
}
/** 作用：从「凭族放行：xxx」审计串里取出族名（只有 ② 同族模式会写这种串）。 */
function familyOf(event: ToolAuditEvent): string | undefined {
  const text = event.scopeDisplay ?? "";
  const marker = "凭族放行：";
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : undefined;
}
/** 作用：从审计事件里取「批准时的说明」——优先用事件里的脱敏 scopeDisplay，其次给出结构化默认文案。 */
function approvedReason(issued: ToolAuditEvent | undefined, lease: CapabilityLease): string {
  const display = issued?.scopeDisplay;
  if (typeof display === "string" && display.length > 0) return display;
  const at = new Date(lease.issuedAt);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `你在 ${pad(at.getHours())}:${pad(at.getMinutes())} 批准了这次${lease.kind === "sandbox-mode" ? "沙箱升级" : "调用"}`;
}
/** 作用：从回滚审计的展示串里取回滚落点（文案形如「沙箱模式回滚至 workspace-write」）。 */
function restoredMode(event: ToolAuditEvent): SandboxMode | undefined {
  const text = event.scopeDisplay ?? "";
  if (text.includes("danger-full-access")) return "danger-full-access";
  if (text.includes("workspace-write")) return "workspace-write";
  if (text.includes("read-only")) return "read-only";
  return undefined;
}
