import type { ToolAuditEvent } from "../audit/types.js";
import { SANDBOX_MODES, sandboxModeLabel, type SandboxMode } from "../capability/escalation.js";
import type { CapabilityLease } from "../capability/types.js";
import type { SessionGrantState } from "../capability/sandbox-grant.js";
import { buildDecisions, describeCapability, summarizeDecisions, type DecisionRecord, type DecisionSummary } from "./decisions.js";
import type { ConsoleAuditQuery, ConsoleAuditSource, ConsoleAuthState, ConsoleFocus, ConsoleGrantView, ConsoleLeaseSource, ConsoleSandboxState, ConsoleSandboxView, ConsoleSessionAuth, ConsoleSessionView, GovernanceConsoleDeps, GovernanceSnapshot, GovernanceSummary, SnapshotOptions } from "./types.js";
/** 剩余时间进入「即将到期」的阈值（毫秒）——只影响展示文案，不影响任何授权判定。 */
const EXPIRING_THRESHOLD_MS = 30_000;
/** 决策日志查询参数（与治理接口的 ?sessionId= / ?toolName= / ?limit= 一一对应）。 */
export interface DecisionQuery {
  sessionId?: string;
  toolName?: string;
  limit?: number;
}
// 作用：聚合授权、工具调用与审计的只读治理视图，并把「授权是否有效」与「沙箱档位是否已恢复」
// 投影成两个互不覆盖的状态（规格 Phase 4 可用性改造）。
// 授权安全校验仍由 LeaseManager 执行，查询不修改运行状态；沙箱档位必须来自宿主实时读取，
// 读不到就是 unknown，禁止用「倒计时归零」推断出「已恢复」。
export class GovernanceConsole {
  private readonly now: () => number;
  private readonly guardName: string;
  constructor(private readonly deps: GovernanceConsoleDeps) {
    this.now = deps.now ?? Date.now;
    this.guardName = deps.guardName ?? "dsh-capability-guard";
  }
  async snapshot(options?: SnapshotOptions): Promise<GovernanceSnapshot> {
    // 作用：生成会话视图与计数摘要（会话视图是治理界面唯一的数据来源：它把「还剩多久」与
    // 「权限级别收回了没有」分成两行状态）。原始事件与逐条授权明细不再塞进快照：
    // 前者用 /api/audit，后者看 sessions[].auth.grants 与 /api/decisions。
    const now = this.now();
    const events = this.deps.audit.list();
    const leases = await this.deps.leases.list();
    const isLive = (lease: CapabilityLease): boolean => lease.status === "ACTIVE" && now < lease.expiresAt;
    const summary: GovernanceSummary = {
      leasesTotal: leases.length,
      leasesActive: leases.filter(isLive).length,
      leasesRevoked: leases.filter((lease) => lease.status === "REVOKED").length,
      leasesExpired: leases.filter((lease) => lease.status !== "REVOKED" && !isLive(lease)).length,
      auditedEvents: events.length,
    };
    const requested = typeof options?.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : undefined;
    const sessions = this.buildSessions(leases, events, now, requested);
    return {
      schemaVersion: 3,
      generatedAt: now,
      guardName: this.guardName,
      summary,
      focus: this.resolveFocus(requested, sessions),
      sessions,
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
  async decisions(query?: DecisionQuery): Promise<{ summary: DecisionSummary; records: DecisionRecord[] }> {
    // 作用：授权决策日志查询——一条授权 = 一条记录（批准 → 复用次数 → 权限级别效果 → 结束方式）。
    // 与 queryAudit 的区别：audit 是原始事件流（含大量遥测），decisions 是给人看/给机器集成的结论。
    // 非法 limit 按 Fail Closed 拒绝；排序固定为「最新批准在前」。
    if (query?.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
      throw new Error("GUARD_CONSOLE_INVALID: limit must be a positive integer");
    }
    const leases = await this.deps.leases.list();
    const records = buildDecisions({
      leases,
      events: this.deps.audit.list(),
      grantStates: this.deps.sandbox?.states() ?? [],
      now: this.now(),
      sessionId: query?.sessionId,
      toolName: query?.toolName,
      limit: query?.limit,
    });
    return { summary: summarizeDecisions(records), records };
  }
  private buildSessions(leases: readonly CapabilityLease[], events: readonly ToolAuditEvent[], now: number, requested: string | undefined): ConsoleSessionView[] {
    // 作用：按会话聚合授权与沙箱状态——会话来源只有两个（有授权的会话 / 有档位记录的会话），
    // 行数因此天然有界；显式指定的会话即使完全没有数据也会生成一个空视图，这样页面才能如实回答
    // 「本会话当前没有临时授权」，而不是把别人的授权显示成你的。
    const sandboxStates = new Map<string, SessionGrantState>();
    for (const state of this.deps.sandbox?.states() ?? []) sandboxStates.set(state.sessionId, state);
    const bySession = new Map<string, CapabilityLease[]>();
    for (const lease of leases) {
      const bucket = bySession.get(lease.sessionId);
      if (bucket) bucket.push(lease);
      else bySession.set(lease.sessionId, [lease]);
    }
    for (const sessionId of sandboxStates.keys()) {
      if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    }
    if (requested !== undefined && !bySession.has(requested)) bySession.set(requested, []);
    const lastAuditAt = new Map<string, number>();
    for (const event of events) {
      if (typeof event.sessionId !== "string" || event.sessionId.length === 0) continue;
      lastAuditAt.set(event.sessionId, Math.max(lastAuditAt.get(event.sessionId) ?? 0, event.timestamp));
    }
    const views: { view: ConsoleSessionView; activityAt: number }[] = [];
    // 作用：先算一次全量决策日志，再按会话分组取统计——避免每个会话各算一遍（O(n²) 但 n 很小）。
    const decisionsBySession = new Map<string, DecisionRecord[]>();
    for (const record of buildDecisions({ leases, events, grantStates: [...sandboxStates.values()], now })) {
      const bucket = decisionsBySession.get(record.sessionId);
      if (bucket) bucket.push(record);
      else decisionsBySession.set(record.sessionId, [record]);
    }
    for (const [sessionId, sessionLeases] of bySession) {
      const state = sandboxStates.get(sessionId);
      const auth = this.projectAuth(sessionLeases, state, now);
      const projectedSandbox = withModeText(this.projectSandbox(sessionId, state, sessionLeases, auth, now));
      // 「当前档位」是宿主实时读数，与「Guard 那次放宽收回了没有」无关：
      // 即使本会话没有沙箱授权，也要告诉 UI 现在是哪一档（免打扰据此判断完全访问不可用）。
      const liveMode = this.deps.currentMode?.(sessionId);
      const sandbox = liveMode !== undefined && projectedSandbox.currentMode === undefined
        ? withModeText({ ...projectedSandbox, currentMode: liveMode })
        : projectedSandbox;
      const descriptor = this.describeSession(sessionId);
      const dnd = this.deps.dnd?.view(sessionId);
      const activityAt = Math.max(lastAuditAt.get(sessionId) ?? 0, ...sessionLeases.map((lease) => lease.issuedAt), state?.lastOutcome?.at ?? 0);
      views.push({
        activityAt,
        view: {
          sessionId,
          label: descriptor.label,
          labelSource: descriptor.source,
          cwd: descriptor.cwd,
          auth,
          sandbox,
          ...(dnd === undefined ? {} : { dnd }),
          stats: summarizeDecisions(decisionsBySession.get(sessionId) ?? []),
          actions: {
            canRevoke: auth.activeCount > 0,
            // 只允许对「授权已失效但档位没回来」的会话手动回滚；用户自己改过的档位不得被覆盖（红线 2）
            canRestoreSandbox: sandbox.state === "pending-restore",
          },
        },
      });
    }
    views.sort((a, b) => b.activityAt - a.activityAt);
    if (requested !== undefined) {
      const index = views.findIndex((item) => item.view.sessionId === requested);
      if (index > 0) {
        const [focused] = views.splice(index, 1);
        if (focused) views.unshift(focused);
      }
    }
    return views.map((item) => item.view);
  }
  private projectAuth(leases: readonly CapabilityLease[], state: SessionGrantState | undefined, now: number): ConsoleSessionAuth {
    // 作用：授权状态投影——active/expiring/expired/revoked 四态只由 Lease 决定，与沙箱无关。
    // 「已过期但未被惰性标记」在这里按过期处理（与 projectLease 同一规则，仅展示层修正）。
    const expired = leases.filter((lease) => lease.status === "EXPIRED" || (lease.status === "ACTIVE" && now >= lease.expiresAt));
    const isLive = (lease: CapabilityLease): boolean => lease.status === "ACTIVE" && now < lease.expiresAt;
    const active = leases.filter(isLive);
    const targetModeByLease = new Map<string, SandboxMode>();
    for (const grant of state?.grants ?? []) targetModeByLease.set(grant.leaseId, grant.requestedMode);
    const grants: ConsoleGrantView[] = leases
      .map((lease) => this.projectGrant(lease, targetModeByLease.get(lease.id), now))
      .sort((a, b) => b.expiresAt - a.expiresAt);
    let authState: ConsoleAuthState = "none";
    if (active.length > 0) {
      const remaining = Math.max(0, Math.min(...active.map((lease) => lease.expiresAt)) - now);
      authState = remaining <= EXPIRING_THRESHOLD_MS ? "expiring" : "active";
    } else if (leases.length > 0) {
      // 有历史授权但都已失效：优先说明「到期的」，其次才是「被撤销的」。
      // 注意必须把已被 LeaseManager 惰性标记为 EXPIRED 的记录也算进来（读沙箱状态会顺带触发该标记），
      // 否则到期授权会被误报成「已撤销」。
      authState = expired.length > 0 ? "expired" : "revoked";
    }
    const earliest = active.length > 0 ? Math.min(...active.map((lease) => lease.expiresAt)) : undefined;
    return {
      state: authState,
      activeCount: active.length,
      nextExpiresAt: earliest,
      remainingMs: earliest === undefined ? undefined : Math.max(0, earliest - now),
      grants,
    };
  }
  private projectGrant(lease: CapabilityLease, targetMode: SandboxMode | undefined, now: number): ConsoleGrantView {
    // 作用：单条授权的人话投影——capabilityText 回答「放开了什么」，reasonText 回答「为什么会有它」。
    // 原始 ID / Scope 哈希只进技术详情（scopeDisplay / scopeKeyShort），不参与首屏文案。
    return {
      id: lease.id,
      toolName: lease.toolName,
      kind: lease.kind,
      capabilityText: describeCapability(lease, targetMode),
      reasonText: `你于 ${formatClock(lease.issuedAt)} 批准了这次${lease.kind === "sandbox-mode" ? "沙箱升级" : "工具调用"}`,
      scopeKind: lease.scope.kind,
      scopeDisplay: lease.scope.display,
      scopeKeyShort: lease.scope.key.slice(0, 8),
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      remainingMs: Math.max(0, lease.expiresAt - now),
      targetMode,
    };
  }
  private projectSandbox(sessionId: string, state: SessionGrantState | undefined, leases: readonly CapabilityLease[], auth: ConsoleSessionAuth, now: number): ConsoleSandboxView {
    // 作用：沙箱状态投影——回答「那次放宽收回来了没有」。判定顺序固定，任何情况下都不允许
    // 用授权倒计时推断档位状态；读不到宿主档位就是 unknown（页面据此显示「无法确认」）。
    const hasSandboxLease = leases.some((lease) => lease.kind === "sandbox-mode");
    const targetMode = state ? widestMode(state.grants.map((grant) => grant.requestedMode)) : undefined;
    if (!state) {
      const last = this.deps.sandbox?.lastOutcomeOf(sessionId);
      if (!last) {
        return hasSandboxLease
          ? { state: "unknown", targetMode, checkedAt: now, note: "本会话有沙箱授权，但没有档位变更记录（可能未实际提升）" }
          : { state: "not-involved", checkedAt: now };
      }
      return {
        state: last.outcome === "RESTORED" ? "restored" : "user-override",
        // 会话状态已被 releaseSession 清理：此刻没有 session 对象可实时读取，
        // 用终态记录里的模式（那就是 Guard 最后写入的值）作为展示，且文案里带上时间，不假装是实时读数。
        currentMode: last.mode,
        targetMode,
        checkedAt: now,
        lastOutcomeAt: last.at,
        note: last.outcome === "RESTORED" ? `Guard 已在 ${formatClock(last.at)} 把权限恢复到「${sandboxModeLabel(last.mode)}」` : `权限由你自己设定为「${sandboxModeLabel(last.mode)}」，Guard 未改动`,
      };
    }
    const current = state.currentMode;
    if (current === undefined) {
      return { state: "unknown", targetMode, baselineMode: state.baseline, checkedAt: now, note: "无法读取当前沙箱档位（宿主能力缺失），因此不显示是否已恢复" };
    }
    if (state.liveCount > 0) {
      if (state.status === "skipped" || (state.lastWritten !== undefined && current !== state.lastWritten)) {
        return { state: "user-override", currentMode: current, baselineMode: state.baseline, targetMode, checkedAt: now, note: `权限现在是「${sandboxModeLabel(current)}」（由你设定），Guard 不会覆盖你的选择` };
      }
      if (state.lastWritten === undefined) {
        return { state: "unchanged", currentMode: current, baselineMode: state.baseline, targetMode, checkedAt: now, note: "档位本来就足够宽，Guard 没有修改" };
      }
      return { state: "raised", currentMode: current, baselineMode: state.baseline, targetMode, checkedAt: now };
    }
    if (state.lastWritten === undefined) {
      // Guard 从未改过档位，也没有有效授权：与沙箱无关
      return { state: "not-involved", currentMode: current, checkedAt: now };
    }
    if (state.status === "restored") {
      return { state: "restored", currentMode: current, baselineMode: state.baseline, targetMode, checkedAt: now, lastOutcomeAt: state.lastOutcome?.at };
    }
    if (state.status === "skipped") {
      return { state: "user-override", currentMode: current, baselineMode: state.baseline, targetMode, checkedAt: now, note: `权限是「${sandboxModeLabel(current)}」（由你设定），Guard 不会覆盖你的选择` };
    }
    return {
      state: "pending-restore",
      currentMode: current,
      baselineMode: state.baseline,
      targetMode,
      checkedAt: now,
      note: auth.state === "revoked" ? "授权已撤销，但权限还没收回去" : "授权已到期，但权限还没收回去",
    };
  }
  private describeSession(sessionId: string): { label: string; source: "title" | "cwd" | "id"; cwd?: string } {
    // 作用：会话名称解析（可选宿主能力）——任何异常都降级为短 ID，绝不影响治理视图生成
    try {
      const described = this.deps.sessions?.describe(sessionId);
      if (described && typeof described.label === "string" && described.label.length > 0) return described;
    } catch {
      // 忽略：降级为短 ID
    }
    return { label: `会话 ${sessionId.slice(0, 8)}`, source: "id" };
  }
  private resolveFocus(requested: string | undefined, sessions: readonly ConsoleSessionView[]): ConsoleFocus {
    // 作用：聚焦会话选择——显式指定优先（即使该会话没有任何授权）；否则取最近有活动的会话，
    // 并在快照里如实标注来源，页面据此决定写「当前会话」还是「最近授权的会话」。
    if (requested !== undefined) return { sessionId: requested, source: "explicit" };
    const first = sessions[0];
    if (!first) return { source: "none" };
    return { sessionId: first.sessionId, source: "recent-activity" };
  }
}
/**
 * 作用：把沙箱视图里的档位补成「机器值 + 中文文本」两份。
 * 为什么放在投影末尾而不是每个 return 各自写：前端（对话内提示条 / 独立页面）不再维护档位映射表，
 * 文案的唯一来源是 `capability/escalation.ts`，这里统一附加，避免出现第 N 份映射。
 */
function withModeText(view: ConsoleSandboxView): ConsoleSandboxView {
  return {
    ...view,
    currentModeText: view.currentMode ? sandboxModeLabel(view.currentMode) : undefined,
    baselineModeText: view.baselineMode ? sandboxModeLabel(view.baselineMode) : undefined,
    targetModeText: view.targetMode ? sandboxModeLabel(view.targetMode) : undefined,
  };
}
/** 取最宽的档位——同一会话可能有多条不同目标的授权，展示时取最宽的那个（顺序以 SANDBOX_MODES 为准）。 */
function widestMode(modes: readonly SandboxMode[]): SandboxMode | undefined {
  if (modes.length === 0) return undefined;
  let widest = modes[0] as SandboxMode;
  for (const mode of modes) {
    if (SANDBOX_MODES.indexOf(mode) > SANDBOX_MODES.indexOf(widest)) widest = mode;
  }
  return widest;
}
/** 把时间戳格式化为本机时间的「时:分」，用于人话文案（不参与任何判定）。 */
function formatClock(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
