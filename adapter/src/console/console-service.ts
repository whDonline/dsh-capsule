import type { ToolAuditEvent } from "../audit/types.js";
import type { CapabilityLease } from "../capability/types.js";
import type { ConsoleAuditQuery, ConsoleAuditSource, ConsoleLeaseSource, ConsoleLeaseView, ConsolePluginView, ConsoleToolStat, GovernanceConsoleDeps, GovernanceSnapshot, GovernanceSummary } from "./types.js";
// 作用：聚合授权、工具调用与审计的只读治理视图。
// 授权安全校验仍由 LeaseManager 执行，查询不修改运行状态。
export class GovernanceConsole {
  private readonly now: () => number;
  private readonly guardName: string;
  private readonly activityLimit: number;
  constructor(private readonly deps: GovernanceConsoleDeps) {
    // 作用：构造校验（Fail Closed）——activityLimit 必须为正整数，非法配置直接拒绝启动
    this.now = deps.now ?? Date.now;
    this.guardName = deps.guardName ?? "dsh-capability-guard";
    this.activityLimit = deps.activityLimit ?? 50;
    if (!Number.isInteger(this.activityLimit) || this.activityLimit <= 0) {
      throw new Error("GUARD_CONSOLE_INVALID: activityLimit must be a positive integer");
    }
  }
  async snapshot(): Promise<GovernanceSnapshot> {
    // 作用：生成授权白名单投影、按 callId 去重的工具统计与最近审计活动。
    const now = this.now();
    const events = this.deps.audit.list();
    const leases = await this.deps.leases.list();
    const leaseViews = leases.map((lease) => this.projectLease(lease, now));
    const summary: GovernanceSummary = {
      leasesTotal: leaseViews.length,
      leasesActive: leaseViews.filter((lease) => lease.status === "ACTIVE").length,
      leasesRevoked: leaseViews.filter((lease) => lease.status === "REVOKED").length,
      leasesExpired: leaseViews.filter((lease) => lease.status === "EXPIRED").length,
      auditedEvents: events.length,
    };
    return {
      generatedAt: now,
      guardName: this.guardName,
      summary,
      plugins: this.buildPlugins(),
      tools: this.toolStats(events),
      activity: [...events].reverse().slice(0, this.activityLimit),
      leases: leaseViews,
    };
  }
  queryAudit(query: ConsoleAuditQuery): ToolAuditEvent[] {
    // 作用：审计事件过滤查询（最新在前）——sessionId/toolName/decision 精确匹配 + limit 截取；
    // 非法 limit（非正整数）按 Fail Closed 直接拒绝
    if (query?.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
      throw new Error("GUARD_CONSOLE_INVALID: limit must be a positive integer");
    }
    const reversed = [...this.deps.audit.list()].reverse();
    const filtered = reversed.filter(
      (event) =>
        (query?.sessionId === undefined || event.sessionId === query.sessionId) &&
        (query?.toolName === undefined || event.toolName === query.toolName) &&
        (query?.decision === undefined || event.decision === query.decision),
    );
    return query?.limit === undefined ? filtered : filtered.slice(0, query.limit);
  }
  private buildPlugins(): ConsolePluginView[] {
    // 作用：仅展示当前 Guard 插件，不枚举宿主的其他插件。
    return [{ id: this.guardName, kind: "guard" }];
  }
  private projectLease(lease: CapabilityLease, now: number): ConsoleLeaseView {
    // 作用：Lease 白名单投影——scope 只保留 kind 与脱敏 display（key 是参数哈希、无 Secret，保留
    // 供治理比对）；视图层把已过期但未被惰性标记的 ACTIVE 修正为 EXPIRED 仅供展示，不回写 store
    return {
      id: lease.id,
      kind: lease.kind,
      sessionId: lease.sessionId,
      toolName: lease.toolName,
      scopeKind: lease.scope.kind,
      scopeDisplay: lease.scope.display,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      status: lease.status === "ACTIVE" && now >= lease.expiresAt ? "EXPIRED" : lease.status,
      remainingMs: Math.max(0, lease.expiresAt - now),
      revokedAt: lease.revokedAt,
      revokeReason: lease.revokeReason,
    };
  }
  private toolStats(events: ToolAuditEvent[]): ConsoleToolStat[] {
    // 作用：Tools 维度统计——按 toolName 聚合各决策计数；invocations 按 callId 去重（一次调用链
    // ASK→LEASE_ISSUED→TOOL_SUCCESS 产生多条事件但只算一次调用）；lastActivityAt 取最新时间戳
    const stats = new Map<string, ConsoleToolStat & { callIds: Set<string> }>();
    for (const event of events) {
      const existing = stats.get(event.toolName);
      const entry = existing ?? { toolName: event.toolName, invocations: 0, ask: 0, leaseIssued: 0, leaseReused: 0, approvalRejected: 0, passthroughAllow: 0, passthroughDeny: 0, toolSuccess: 0, toolError: 0, lastActivityAt: 0, callIds: new Set<string>() };
      if (event.callId && !entry.callIds.has(event.callId)) {
        entry.callIds.add(event.callId);
        entry.invocations += 1;
      }
      entry.lastActivityAt = Math.max(entry.lastActivityAt, event.timestamp);
      if (event.decision === "ASK") entry.ask += 1;
      else if (event.decision === "LEASE_ISSUED") entry.leaseIssued += 1;
      else if (event.decision === "LEASE_REUSED") entry.leaseReused += 1;
      else if (event.decision === "APPROVAL_REJECTED") entry.approvalRejected += 1;
      else if (event.decision === "PASSTHROUGH_ALLOW") entry.passthroughAllow += 1;
      else if (event.decision === "PASSTHROUGH_DENY") entry.passthroughDeny += 1;
      else if (event.decision === "TOOL_SUCCESS") entry.toolSuccess += 1;
      else if (event.decision === "TOOL_ERROR") entry.toolError += 1;
      stats.set(event.toolName, entry);
    }
    return [...stats.values()].map(({ callIds, ...stat }) => stat);
  }
}
