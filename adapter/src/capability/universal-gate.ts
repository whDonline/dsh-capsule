import type { AuditService } from "../audit/audit-service.js";
import type { AuditDecision } from "../audit/types.js";
import { parseEscalation, type SandboxMode } from "./escalation.js";
import type { SandboxGrantManager, SandboxModeResult } from "./sandbox-grant.js";
import { recordSandboxOutcome } from "./sandbox-audit.js";
import type { ResolvedToolPolicy, PolicyResolver } from "./policy.js";
import type { LeaseManager } from "./lease-manager.js";
import type { PendingRegistry } from "./pending.js";
import type { ScopeResolver } from "./scope-resolver.js";
import type { ApprovalOutcome, ApprovalRequestLike, CapabilityScope, EscalationGrant, PreToolDecision, ToolExecutionLike } from "./types.js";
// 作用：Universal Gate（重构规格第 6 节 + 2026-09-14 基线修正）——Guard 横切 DSH 原生 Tool Pipeline
// 的四个 hook：
//   tools/pre-execute  只接管下游 ask（真实 DSH 中通常为 allow → 透传；仅 hook 插件会产生 ask）
//   tools/execute      【P0-2 新增】在工具体运行之前识别沙箱升级并记录待批准上下文——
//                      这是整条链路上唯一能同时拿到 callId 与 arguments 的时机（approval/request
//                      载荷不含 arguments）；同时复用已有 Lease 主动提升模式、低频回收失效授权
//   approval/request   始终 next() 委派给人/机 answerer；allowed-once → 签发 Lease + 提升会话模式
//   tools/result       清理 pending/escalation 记录 + 记录最终结果
// 纯逻辑与 DSH 事件总线安装分离（install），保证核心算法可独立单测。
export interface UniversalGateDeps {
  policy: PolicyResolver;
  scopes: ScopeResolver;
  leases: LeaseManager;
  pending: PendingRegistry;
  audit: AuditService;
  /**
   * P0-2：会话沙箱模式授权管理器。**未注入即完全关闭沙箱升级链路**（等价于旧行为：
   * Guard 不识别、不记录、不签发沙箱升级授权），这样"不配置就不改变任何 DSH 语义"由构造方式保证。
   */
  sandboxGrants?: SandboxGrantManager;
  /** 可注入时钟（默认 Date.now），保证 TTL/GC 语义可模拟时间测试 */
  now?: () => number;
}
// 作用：沙箱升级上下文在 tools/result 之后的宽限期（毫秒）——实测存在 tools/result 早于
// approval/request 到达的时序，必须留出窗口让随后到达的审批仍能找到上下文；同时该窗口有界，
// 避免「工具早已结束、callId 被重放」时仍凭旧上下文签发授权。取值远大于一次审批的正常往返时间。
export const ESCALATION_CONTEXT_GRACE_MS = 30_000;
export interface GuardEventBus {
  // 事件名/handler 签名/prepend 选项均已按真实 cordis 核实（2026-09-14）：
  //   on(name, listener, { prepend }) 支持 prepend（cordis 内部 unshift，后注册的 prepend 排最前）；
  //   四个事件名与签名见 integration/cordis-pipeline.test.ts（真实 Context/waterfall/emit 驱动）。
  on(event: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }): unknown;
}
export class UniversalGate {
  private readonly now: () => number;
  /** P0-2：按 callId 关联的「沙箱升级待批准」记录（approval/request 载荷无 arguments，只能这样关联） */
  private readonly escalations = new Map<string, EscalationGrant>();
  constructor(private readonly deps: UniversalGateDeps) {
    this.now = deps.now ?? Date.now;
  }
  async handleExecute(exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown> {
    // 作用：tools/execute 处理器（P0-2）——DSH 的 around-dispatch 包装层，在工具体之前运行且
    // exec.arguments 完整可用。职责（严格限定，不改变任何执行结果）：
    //   1. 低频回收：pending GC + 失效沙箱授权结算（与 pre-execute 同一时机，不新增定时器）；
    //   2. 沙箱升级识别：仅当本次调用带可识别的升级参数时才记账；命中有效 Lease 则【主动提升会话模式】，
    //      使工具体不再触发审批（这就是"批准一次、后续自动生效"的落地方式——在不合成 approval outcome
    //      的前提下复用授权，因为提升后那次审批根本不会发生）；
    //   3. 始终 await next() 并原样返回结果，绝不改写、绝不否决。
    await this.settleAll();
    const grants = this.deps.sandboxGrants;
    if (grants && typeof exec?.callId === "string" && exec.callId.length > 0 && typeof exec?.name === "string" && exec.name.length > 0) {
      const sessionId = exec.agent?.id;
      const escalation = parseEscalation(exec.arguments);
      if (escalation && typeof sessionId === "string" && sessionId.length > 0) {
        try {
          const policy = this.deps.policy.resolve(exec.name);
          if (policy.enabled && policy.scope.mode === "sandbox-escalation") {
            const scope = this.deps.scopes.resolve({ toolName: exec.name, arguments: exec.arguments }, policy);
            this.escalations.set(exec.callId, {
              callId: exec.callId,
              rootCallId: typeof exec.rootCallId === "string" ? exec.rootCallId : exec.callId,
              sessionId,
              session: exec.agent?.session,
              toolName: exec.name,
              scope,
              requestedMode: escalation.requestedMode,
              ttlSeconds: policy.ttlSeconds,
              startedAt: this.now(),
            });
            await this.reuseEscalationLease(exec, sessionId, scope.key, escalation.requestedMode, exec.agent?.session);
          }
          // policy 未启用或 scope 不是 sandbox-escalation：不接管本次升级（DSH 原生审批照常进行）
        } catch {
          // 策略/Scope 解析失败：Fail Closed——不记录、不提升，保持 DSH 原生语义
        }
      }
    }
    return await next();
  }
  async handlePreExecute(exec: ToolExecutionLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    // 作用：tools/pre-execute 处理器（规格 6.2 算法）——先调 next() 获得下游原生 DSH Policy 的最终
    // PreToolDecision：deny 永远透传（Lease 不得覆盖 DENY）；allow 不制造新 Approval；只有 ask 才进入
    // Guard：命中有效 Lease → allow（复用），否则保持 ask 并在 reason 中明确告知批准将签发 Lease。
    this.deps.pending.gc(this.now());
    if (typeof exec?.callId !== "string" || exec.callId.length === 0 || typeof exec?.name !== "string" || exec.name.length === 0) {
      return await next();
    }
    const downstream = await next();
    if (downstream?.kind === "deny") {
      this.recordAudit(exec, "PASSTHROUGH_DENY");
      return downstream;
    }
    if (downstream?.kind === "allow") {
      this.recordAudit(exec, "PASSTHROUGH_ALLOW");
      return downstream;
    }
    if (downstream?.kind !== "ask") {
      return downstream;
    }
    const sessionId = exec.agent?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      // 无 agent/session：禁止创建 Session Lease（不得发明 global/anonymous lease），保持原始 ask 语义
      return downstream;
    }
    let policy: ResolvedToolPolicy;
    try {
      policy = this.deps.policy.resolve(exec.name);
    } catch {
      // 策略解析失败（如 TTL 非法）：Fail Closed，不接管，保持原 ask
      return downstream;
    }
    if (!policy.enabled) {
      return downstream;
    }
    let scope: CapabilityScope;
    try {
      scope = this.deps.scopes.resolve({ toolName: exec.name, arguments: exec.arguments }, policy);
    } catch {
      // Scope 解析失败：不接管、不签发，保持原始 ask。
      return downstream;
    }
    const lease = await this.deps.leases.findMatching(sessionId, exec.name, scope.key);
    if (lease) {
      this.deps.pending.set(
        {
          callId: exec.callId,
          rootCallId: exec.rootCallId,
          sessionId,
          toolName: exec.name,
          scope,
          ttlSeconds: policy.ttlSeconds,
          startedAt: this.now(),
          leaseId: lease.id,
          decision: "LEASE_REUSED",
        },
        exec.signal,
      );
      this.recordAudit(exec, "LEASE_REUSED", { scopeKey: scope.key, scopeDisplay: scope.display, leaseId: lease.id });
      return { kind: "allow" };
    }
    this.deps.pending.set(
      {
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        sessionId,
        toolName: exec.name,
        scope,
        ttlSeconds: policy.ttlSeconds,
        startedAt: this.now(),
        decision: "ASKED",
      },
      exec.signal,
    );
    this.recordAudit(exec, "ASK", { scopeKey: scope.key, scopeDisplay: scope.display });
    return { kind: "ask", reason: appendGuardReason(downstream.reason, scope, policy.ttlSeconds) };
  }
  async handleApprovalRequest(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    // 作用：approval/request 处理器（规格 6.3 算法）——先交给真正的 DSH human/machine answerer（next），
    // 仅当该 callId 是 Guard 管理的 ASK 且结果为 allowed-once 时签发 Lease；rejected/cancelled/unavailable
    // 一律不签发并清理 pending；不修改 outcome，不绕过 approval policy=never（answerer 内部处理）。
    //
    // 【安全不变量（P0-3，禁止破坏）】本处理器必须【只观察、绝不合成 outcome】：
    //   1. Guard 以 prepend 方式排在 `approval/request` 瀑布最前面，而 DSH 自带的 UI answerer 本身
    //      也是这条瀑布上的下游 listener（dsh-api-remotes 认领、dsh-client-ui-approval 渲染）；
    //      任何提前 return 的分支都会在【零人工交互】下批准一切，并顺带把人类答话器整个旁路掉；
    //   2. 因此 return 的值【必须】是且只能是 next() 的原样返回值。`next()` 在本方法中只出现一次，
    //      其返回值只经过赋值给 result 后原样返回，不存在任何改写、包装或默认值兜底；
    //   3. 本方法体内禁止出现 "allowed-once" 字面量（它只允许用于【比较】下游结果，禁止用于返回值）；
    //   4. 该不变量由 universal-gate.test.ts 的 P0-3 用例守护（含 sentinel 全等断言，覆盖四种结果）。
    if (typeof req?.callId !== "string" || req.callId.length === 0) {
      return await next();
    }
    // P0-2：本次审批可能对应两种上下文之一——① pre-execute 阶段已 ASK 的调用（pending）；
    // ② tools/execute 阶段识别的沙箱升级（escalations，其 GetScope 只能在那里算）。
    // 两者都不命中即完全不接管（保持 DSH 原生语义）。
    const pendingExec = this.deps.pending.get(req.callId);
    const escalationGrant = this.escalations.get(req.callId);
    if (!pendingExec && !escalationGrant) {
      return await next();
    }
    // P0-3 不变量要求：失败路径也必须把结果交还给下游，因此这里用一次可空记录 + 两条互斥分支，
    // 但 next() 仍然全方法只调用一次，返回值仍然原样传出
    const context = pendingExec ?? escalationGrant!;
    // 会话绑定校验（P0-5）：审批请求自带的 agent 必须与被授权上下文所属 session 一致。
    // 载荷 agent 形状随版本可变，因此只在能确定 id 时校验；不一致一律不接管（Fail Closed：
    // 宁可不签发，也不允许 A 会话的批准被用于给 B 会话签发授权）
    const requesterId = approvalAgentId(req);
    if (requesterId !== undefined && requesterId !== context.sessionId) {
      process.stderr.write(`[dsh-guard] approval session mismatch for call ${req.callId}: requester=${requesterId} context=${context.sessionId}\n`);
      return await next();
    }
    // 下游 answerer 的唯一一次调用：其结果必须原样返回（见上方不变量）
    const result = await next();
    if (normalizeOutcome(result) === "allowed-once") {
      // 已消费本次升级的待批准上下文：立刻从表中移除，避免「同一 callId 的审批被重放」时
      // 反复签发同类 Lease（上下文的作用域就是这一次审批，用掉即失效）
      if (escalationGrant) this.escalations.delete(req.callId);
      try {
        const lease = await this.deps.leases.issue({
          sessionId: context.sessionId,
          toolName: context.toolName,
          scope: context.scope,
          ttlSeconds: context.ttlSeconds,
          kind: escalationGrant ? "sandbox-mode" : "universal",
          sourceCallId: req.callId,
        });
        if (pendingExec) pendingExec.leaseId = lease.id;
        if (pendingExec) pendingExec.decision = "APPROVED";
        this.deps.audit.record({
          sessionId: context.sessionId,
          callId: context.callId,
          rootCallId: context.rootCallId,
          toolName: context.toolName,
          scopeKey: context.scope.key,
          scopeDisplay: context.scope.display,
          leaseId: lease.id,
          decision: "LEASE_ISSUED",
        });
        if (escalationGrant) {
          // P0-2：沙箱升级获批——只有 Lease 真正签发成功后才提升会话模式（Fail Closed：
          // 签发失败则权限一点不放），两件事绑定为一个原子语义单元。
          // session 优先取 tools/execute 阶段亲自观察到的对象，载荷 agent.session 仅作兜底
          const payloadSession = req.agent && typeof req.agent === "object" ? (req.agent as { session?: unknown }).session : undefined;
          await this.applySandboxGrant(req.callId, escalationGrant, lease.id, escalationGrant.session ?? payloadSession);
        }
      } catch (err) {
        // 签发失败（防御路径）：Fail Closed 不签发、不提升，仅写 stderr 诊断日志（不含任何 Secret）
        process.stderr.write(`[dsh-guard] lease issue failed for call ${req.callId}: ${String(err)}\n`);
      }
    } else {
      if (pendingExec) pendingExec.decision = "REJECTED";
      this.deps.audit.record({
        sessionId: context.sessionId,
        callId: context.callId,
        rootCallId: context.rootCallId,
        toolName: context.toolName,
        scopeKey: context.scope.key,
        scopeDisplay: context.scope.display,
        decision: "APPROVAL_REJECTED",
      });
      // 非 allowed-once：调用不会执行，不会再有 tools/result 兜底，立即清理上下文（规格 22.13）
      this.deps.pending.delete(req.callId);
      this.escalations.delete(req.callId);
    }
    return result;
  }
  handleToolResult(exec: ToolExecutionLike, result: { isError?: boolean }): void {
    // 作用：tools/result 观察者（规格 6.4）——记录最终结果与 Lease 使用情况，并标记沙箱升级上下文已结算；
    // 不得修改结果。已签发的 sandbox-mode Lease 属会话级授权，其生命周期由 TTL/revoke 决定，
    // 不随单次调用结束而回收（否则"批准一次复用多次"就不成立）。
    const current = typeof exec?.callId === "string" ? this.deps.pending.get(exec.callId) : undefined;
    this.recordAudit(exec, result?.isError ? "TOOL_ERROR" : "TOOL_SUCCESS", current ? { scopeKey: current.scope.key, scopeDisplay: current.scope.display, leaseId: current.leaseId } : undefined);
    if (typeof exec?.callId === "string") {
      this.deps.pending.delete(exec.callId);
      // 只标记结算时间，不立刻删除：见 EscalationGrant.settledAt 注释（存在 result 早于 approval 的时序）
      const escalation = this.escalations.get(exec.callId);
      if (escalation) escalation.settledAt = this.now();
    }
  }
  install(bus: GuardEventBus): () => void {
    // 作用：把四个 handler 挂到 DSH 事件总线——pre-execute / tools/execute / approval/request 均 prepend
    // （成为外层中间件：依次先 next() 拿到下游结果）；tools/result 是纯观察者（emit，无决策）；
    // 返回 dispose 函数（调用各 disposer、清空 pending 与沙箱升级记录）
    if (typeof bus?.on !== "function") {
      throw new Error("GUARD_INSTALL_FAILED: bus.on unavailable");
    }
    const disposers: unknown[] = [];
    disposers.push(bus.on("tools/pre-execute", (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => this.handlePreExecute(exec, next), { prepend: true }));
    disposers.push(bus.on("tools/execute", (exec: ToolExecutionLike, next: () => Promise<unknown>) => this.handleExecute(exec, next), { prepend: true }));
    disposers.push(bus.on("approval/request", (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => this.handleApprovalRequest(req, next), { prepend: true }));
    disposers.push(bus.on("tools/result", (exec: ToolExecutionLike, result: { isError?: boolean }) => this.handleToolResult(exec, result ?? {})));
    return () => {
      for (const disposer of disposers) {
        if (typeof disposer === "function") (disposer as () => void)();
      }
      this.deps.pending.clear();
      this.escalations.clear();
    };
  }
  private async settleAll(): Promise<readonly SandboxModeResult[]> {
    // 作用：低频回收（P0-2）——pending GC、过期沙箱升级上下文清理、失效沙箱授权结算。
    // 与 pre-execute 用同一时机，不引入任何定时器；结算属「收缩权限」方向，晚执行不会造成越权。
    const now = this.now();
    this.deps.pending.gc(now);
    for (const [callId, escalation] of [...this.escalations.entries()]) {
      const expired = now >= escalation.startedAt + escalation.ttlSeconds * 1000;
      const settledLongAgo = escalation.settledAt !== undefined && now >= escalation.settledAt + ESCALATION_CONTEXT_GRACE_MS;
      if (expired || settledLongAgo) this.escalations.delete(callId);
    }
    if (!this.deps.sandboxGrants) return [];
    const settled = await this.deps.sandboxGrants.settle();
    for (const result of settled) {
      recordSandboxOutcome(this.deps.audit, result);
    }
    return settled;
  }
  async settleNow(): Promise<readonly SandboxModeResult[]> {
    // 作用：供 30 秒低频 sweeper 与治理台「立即回滚档位」调用的公开入口——只做「收缩」方向的
    // 结算（把已失效授权的会话宽模式收回），不签发、不提升、不改任何授权状态。
    // 安全正确性不依赖它：即使一次都不调用，失效 Lease 也不会再授权任何调用（见 settle 注释）。
    return await this.settleAll();
  }
  private async applySandboxGrant(callId: string, grant: EscalationGrant, leaseId: string, session: unknown): Promise<void> {
    // 作用：沙箱升级获批后提升会话模式（P0-2）——同一 Lease 重复获批是幂等的（SandboxGrantManager
    // 内部保证）；提升结果写入审计，供治理视图与合规追溯回答"这次权限是什么时候放宽的、放宽到哪一档。
    // 无 session 对象时跳过：签发 Lease 仍然有效（记录授权事实），但不改沙箱（不越权、也不假装生效）
    const grants = this.deps.sandboxGrants;
    if (!grants || session === undefined || session === null) return;
    const applied = await grants.applyGrant({ leaseId, sessionId: grant.sessionId, session, toolName: grant.toolName, requestedMode: grant.requestedMode });
    const decision: AuditDecision = applied.outcome === "RAISED" ? "SANDBOX_MODE_RAISED" : applied.outcome === "SKIPPED_USER_OVERRIDE" ? "SANDBOX_MODE_SKIPPED_USER_OVERRIDE" : "LEASE_ISSUED";
    const display = applied.outcome === "RAISED" ? `会话沙箱模式提升至 ${applied.mode}` : `${grant.scope.display}（当前模式 ${applied.mode} 已足够）`;
    this.deps.audit.record({
      sessionId: grant.sessionId,
      callId,
      rootCallId: grant.rootCallId,
      toolName: grant.toolName,
      scopeKey: grant.scope.key,
      scopeDisplay: display,
      leaseId,
      decision,
    });
  }
  private async reuseEscalationLease(exec: ToolExecutionLike, sessionId: string, scopeKey: string, requestedMode: SandboxMode, session: unknown): Promise<void> {
    // 作用：命中有效 Lease 时【主动提升】会话沙箱模式（P0-2 复用路径）——提升后工具体不会触发升级审批，
    // 因此无需在 approval/request 里合成任何 outcome（守住 P0-3 不变量），却能达到"批准一次、后续免问"。
    // 未命中则不提升，交由 DSH 原生审批流程；任何异常都吞掉（Fail Closed：不提升不等于放行）。
    // 无 session 对象时直接跳过——无法读写 session log 就不能提升（提升失败只会让用户被多问一次，不会越权）
    const grants = this.deps.sandboxGrants;
    if (!grants || session === undefined || session === null) return;
    try {
      const lease = await this.deps.leases.findMatching(sessionId, exec.name, scopeKey, "sandbox-mode");
      if (!lease) return;
      const applied = await grants.applyGrant({ leaseId: lease.id, sessionId, session, toolName: exec.name, requestedMode });
      if (applied.outcome === "RAISED") {
        this.recordAudit(exec, "SANDBOX_MODE_RAISED", { scopeKey, scopeDisplay: `tool=${exec.name} 会话沙箱模式提升至 ${applied.mode}`, leaseId: lease.id });
      }
    } catch {
      // 提升失败不抛出：保持 DSH 原生审批语义（用户仍会被问一次），不影响本次调用本身
    }
  }
  private recordAudit(exec: ToolExecutionLike, decision: AuditDecision, extra?: { scopeKey?: string; scopeDisplay?: string; leaseId?: string }): void {
    // 作用：组装审计事件——只含 Session/callId/Tool 名/Scope 哈希与脱敏 display/Lease id，绝不含参数原文
    this.deps.audit.record({
      sessionId: typeof exec?.agent?.id === "string" ? exec.agent.id : undefined,
      callId: typeof exec?.callId === "string" ? exec.callId : "",
      rootCallId: typeof exec?.rootCallId === "string" ? exec.rootCallId : "",
      toolName: typeof exec?.name === "string" ? exec.name : "",
      decision,
      ...extra,
    });
  }
}
function approvalAgentId(req: ApprovalRequestLike): string | undefined {
  // 作用：从审批请求中确定性提取发起者 session id——DSH 的载荷 agent 是 Agent 实例（id 为 SessionId）；
  // 形状不符（缺 agent / 缺 id / 非字符串）时返回 undefined，表示「无法判定」，由调用方按不校验处理
  const agent = req?.agent;
  if (typeof agent !== "object" || agent === null) return undefined;
  const id = (agent as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
function normalizeOutcome(outcome: ApprovalOutcome | { decision?: string } | unknown): string | undefined {  // 作用：归一化 Approval 结果——支持字符串与 {decision} 对象两种形状（以实际 DSH 返回形状为准）
  if (typeof outcome === "string") return outcome;
  if (typeof outcome === "object" && outcome !== null) {
    const decision = (outcome as { decision?: unknown }).decision;
    if (typeof decision === "string") return decision;
  }
  return undefined;
}
function appendGuardReason(original: string | undefined, scope: CapabilityScope, ttlSeconds: number): string {
  // 作用：在原始 ask reason 后追加 Guard 说明（规格 4.2）——用户必须明确看到"批准将签发什么 Scope、
  // 多长 TTL 的 Lease"，只有看到该信息并返回 allowed-once 后才允许创建 Lease（禁止静默扩展）
  const guardNote = `DSH Guard：批准本次请求将为当前 Session 签发一个 Scope=${scope.display}、TTL=${ttlSeconds}s 的短期 Lease；Lease 在到期前同 Scope 可复用，且可主动撤销。`;
  return original ? `${original}；${guardNote}` : guardNote;
}
