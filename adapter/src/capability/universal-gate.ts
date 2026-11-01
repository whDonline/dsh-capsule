import type { AuditService } from "../audit/audit-service.js";
import type { AuditDecision } from "../audit/types.js";
import { parseEscalation } from "./escalation.js";
import { OperationRegistry } from "./operation-registry.js";
import { FamilyGrantStore, hasDestructiveCommand, identifyFamilies } from "./families.js";
import type { DndManager } from "./dnd.js";
import type { ResolvedToolPolicy, PolicyResolver } from "./policy.js";
import type { LeaseManager } from "./lease-manager.js";
import type { PendingRegistry } from "./pending.js";
import type { ScopeResolver } from "./scope-resolver.js";
import type { ApprovalOutcome, ApprovalRequestLike, CapabilityScope, PreToolDecision, ToolExecutionLike } from "./types.js";
// 作用：Universal Gate（重构规格第 6 节 + 2026-09-14 基线修正）——Guard 横切 DSH 原生 Tool Pipeline
// 的四个 hook：
//   tools/pre-execute  只接管下游 ask（真实 DSH 中通常为 allow → 透传；仅 hook 插件会产生 ask）
//   tools/execute      在工具体运行之前按 callId 记录操作指纹——这是整条链路上唯一能同时拿到
//                      callId 与 arguments 的时机（approval/request 载荷不含 arguments）
//   approval/request   默认原样委派给人/机 answerer；命中「同一条操作」的有效授权或免打扰窗口时
//                      代答 allowed-once（代答不等于放宽权限：本次调用仍由 DSH 按其审批结果执行）
//   tools/result       清理 pending + 记录最终结果
//
// 【2026-11-01 移除】旧版「批准后提升会话沙箱档位 + TTL 回滚」链路已整体删除：本插件不写沙箱档位，
// 只做审批层的短期授权与免打扰放行。因此 handleExecute 不再查授权、不再调用 setSandboxMode。
// 纯逻辑与 DSH 事件总线安装分离（install），保证核心算法可独立单测。
export interface UniversalGateDeps {
  policy: PolicyResolver;
  scopes: ScopeResolver;
  leases: LeaseManager;
  pending: PendingRegistry;
  audit: AuditService;
  /**
   * 用户可见的设置（开关 + 复用时长）。**必填**：没有设置就不存在「授权层」语义——
   * `active === false` 时所有 hook 直接透传（不签发、不改写任何状态）。
   */
  settings: { readonly active: boolean; readonly reuseTtlSeconds: number };
  /**
   * 免打扰窗口（2026-11-01 定稿）。**未注入即不启用免打扰**：所有审批回到原有语义。
   * 注入后，窗口内带 requestedMode 的已记录升级由它代答 allowed-once；其余仍然委派。
   */
  dnd?: Pick<DndManager, "evaluate">;
  /** 可注入时钟（默认 Date.now），保证 TTL/GC 语义可模拟时间测试 */
  now?: () => number;
}
export interface GuardEventBus {
  // 事件名/handler 签名/prepend 选项均已按真实 cordis 核实（2026-09-14）：
  //   on(name, listener, { prepend }) 支持 prepend（cordis 内部 unshift，后注册的 prepend 排最前）；
  //   四个事件名与签名见 integration/cordis-pipeline.test.ts（真实 Context/waterfall/emit 驱动）。
  on(event: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }): unknown;
}
export class UniversalGate {
  private readonly now: () => number;
  /** 按 callId 记录的操作指纹（① 同操作复用的判据） */
  private readonly operations = new OperationRegistry();
  /** ② 同族模式：最近一次人工批准后 TTL 内有效的族放行表 */
  private readonly familyGrants = new FamilyGrantStore();
  /**
   * 诊断计数：回答「为什么没有命中」——真实 DSH 里 callId / toolName 与 tools/execute 的对齐关系
   * 只能靠实测确认，因此把每次未命中的原因计数并通过 /api/config.diagnostics 暴露出来。
   */
  private readonly opStats = {
    approvals: 0,
    noRecord: 0,
    sessionMismatch: 0,
    toolMismatch: 0,
    noLease: 0,
    reusedExact: 0,
    reusedFamily: 0,
    dndAllowed: 0,
    issued: 0,
    lastMiss: undefined as { callId: string; toolName?: string; reason: string } | undefined,
  };
  private noteMiss(callId: string, toolName: string | undefined, reason: string): void {
    if (reason === "no-record") this.opStats.noRecord += 1;
    else if (reason === "session-mismatch") this.opStats.sessionMismatch += 1;
    else this.opStats.toolMismatch += 1;
    this.opStats.lastMiss = { callId, toolName, reason };
  }
  /** 作用：把「操作复用」的命中情况投影出来（只读诊断，不含参数原文）。 */
  diagnostics(): Record<string, unknown> {
    return { ...this.opStats, pendingRecords: this.operations.size, familyGrants: this.familyGrants.size };
  }
  constructor(private readonly deps: UniversalGateDeps) {
    this.now = deps.now ?? Date.now;
  }
  /** 作用：用户开关——关闭时所有 hook 直接透传（不签发、不改写状态）。 */
  private get active(): boolean {
    return this.deps.settings.active;
  }
  async handleExecute(exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown> {
    // 作用：tools/execute 处理器——DSH 的 around-dispatch 包装层，在工具体之前运行且
    // exec.arguments 完整可用。职责（严格限定，不改变任何执行结果）：
    //   1. 低频回收：pending GC（与 pre-execute 同一时机，不新增定时器）；
    //   2. 为本次调用记录操作指纹——approval/request 拿不到 arguments，只能在这里把
    //      「这次是什么操作」按 callId 存下来，等审批到达时反查；
    //   3. 始终 await next() 并原样返回结果，绝不改写、绝不否决。
    if (!this.active) return await next();
    this.deps.pending.gc(this.now());
    if (typeof exec?.callId === "string" && exec.callId.length > 0 && typeof exec?.name === "string" && exec.name.length > 0) {
      const sessionId = exec.agent?.id;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        this.operations.gc(this.now());
        this.familyGrants.gc(this.now());
        // 先按策略解析 Scope（Fail Closed：策略禁用 / 解析失败就不记录，审批时照常交还人类）。
        // 记录的是「这一次调用的授权单位」，审批通过后直接用它签发 Lease——两条路径因此共用同一 key。
        try {
          const policy = this.deps.policy.resolve(exec.name);
          if (policy.enabled) {
            const scope = this.deps.scopes.resolve({ toolName: exec.name, arguments: exec.arguments }, policy);
            const escalation = parseEscalation(exec.arguments);
            this.operations.set({
              callId: exec.callId,
              sessionId,
              toolName: exec.name,
              scope,
              mode: escalation?.requestedMode,
              families: identifyFamilies(exec.name, exec.arguments, escalation?.requestedMode),
              // 含破坏性程序的脚本：族照常登记（供其它脚本复用），但**这一次**调用不允许走族复用
              blocked: hasDestructiveCommand(commandOf(exec.arguments)),
              recordedAt: this.now(),
            });
          }
        } catch {
          // 策略/Scope 解析失败：不记录（审批照常交还人类），绝不猜测一个更宽的 Scope
        }
      }
    }
    return await next();
  }
  async handlePreExecute(exec: ToolExecutionLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    // 作用：tools/pre-execute 处理器（规格 6.2 算法）——先调 next() 获得下游原生 DSH Policy 的最终
    // PreToolDecision：deny 永远透传（Lease 不得覆盖 DENY）；allow 不制造新 Approval；只有 ask 才进入
    // Guard：命中有效 Lease → allow（复用），否则保持 ask 并在 reason 中明确告知批准将签发 Lease。
    if (!this.active) return await next();
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
    const escalation = parseEscalation(exec.arguments);
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
          mode: escalation?.requestedMode,
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
        // 免打扰窗口要靠它判断「这是一次沙箱升级」；approval/request 载荷本身不含参数
        mode: escalation?.requestedMode,
      },
      exec.signal,
    );
    this.recordAudit(exec, "ASK", { scopeKey: scope.key, scopeDisplay: scope.display });
    return { kind: "ask", reason: appendGuardReason(downstream.reason, scope, policy.ttlSeconds) };
  }
  async handleApprovalRequest(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    // 作用：approval/request 处理器（规格 6.3 算法）——默认把结果原样交还给真正的 DSH human/machine
    // answerer；只有「同一条操作已有有效授权」或「免打扰窗口内的已记录升级」才代答 allowed-once。
    // rejected/cancelled/unavailable 一律不签发并清理记录；不修改 outcome，不绕过 approval policy=never。
    //
    // 【安全不变量（P0-3，禁止破坏）】本处理器必须【只观察、绝不合成 outcome】（以下两条例外除外）：
    //   1. Guard 以 prepend 方式排在 `approval/request` 瀑布最前面，而 DSH 自带的 UI answerer 本身
    //      也是这条瀑布上的下游 listener（dsh-api-remotes 认领、dsh-client-ui-approval 渲染）；
    //      任何提前 return 的分支都会在【零人工交互】下批准一切，并顺带把人类答话器整个旁路掉；
    //   2. 因此默认 return 的值【必须】是且只能是 next() 的原样返回值（本方法中 next() 只出现一次）；
    //   3. 代答 allowed-once 只允许发生在 handleOperationApproval 里，且必须满足其注释中的全部条件；
    //   4. 该不变量由 universal-gate.test.ts 的 P0-3 用例守护（含 sentinel 全等断言）。
    if (!this.active) return await next();
    if (typeof req?.callId !== "string" || req.callId.length === 0) {
      return await next();
    }
    return await this.handleOperationApproval(req, next);
  }
  /**
   * 作用：审批处理——「批准一次 = 同一条操作在一段时间内不再问」。
   *
   * 【这是唯一允许合成 outcome 的地方，条件必须严格】
   * 代答 allowed-once 的前提（缺一不可）：
   *   ① 本 callId 在 tools/execute 被 Guard 亲自记录过操作指纹；
   *   ② 审批请求的会话与工具名与记录一致；
   *   ③ 存在仍然有效（ACTIVE 且未过期）的授权，且 scope key 与指纹完全一致；或存在覆盖本次操作的
   *      免打扰窗口（仅限带 requestedMode 的沙箱升级）；
   *   ④ 用户开关处于启用状态（已在 handleApprovalRequest 入口判断）。
   * 任何一条不满足 → 必须 `await next()` 交还给人类答话器。
   *
   * 未命中时的批准行为：签发一条「操作授权」（exact-arguments 语义），不触碰沙箱档位。
   */
  private async handleOperationApproval(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const callId: unknown = req.callId;
    if (typeof callId !== "string" || callId.length === 0) return await next();
    this.opStats.approvals += 1;
    // 两类 Guard 亲自记录的上下文：
    //   ① tools/execute 记录的操作（DSH 真实审批入口：工具体内 approveEscalation 晚于 execute）；
    //   ② tools/pre-execute 已 ASK 的调用（仅在上下游 hook 产生 ask 时存在）。
    // 两者都带 session/tool/scope，且 exact-arguments 使用同一指纹算法，因此签发的授权可以互相复用。
    const operation = this.operations.get(callId);
    const pending = operation ? undefined : this.deps.pending.get(callId);
    if (!operation && !pending) {
      this.noteMiss(callId, req.toolName, "no-record");
      return await next();
    }
    const context = operation
      ? {
          callId,
          sessionId: operation.sessionId,
          toolName: operation.toolName,
          scope: operation.scope,
          mode: operation.mode,
          families: operation.families,
          blocked: operation.blocked === true,
        }
      : {
          callId,
          sessionId: pending!.sessionId,
          toolName: pending!.toolName,
          scope: pending!.scope,
          mode: pending!.mode,
          families: undefined,
          blocked: false,
        };
    const requesterId = approvalAgentId(req);
    if (requesterId !== undefined && requesterId !== context.sessionId) {
      this.noteMiss(callId, req.toolName, "session-mismatch");
      return await next();
    }
    if (typeof req.toolName === "string" && req.toolName.length > 0 && req.toolName !== context.toolName) {
      this.noteMiss(callId, req.toolName, `tool-mismatch(${context.toolName})`);
      return await next();
    }
    // 免打扰窗口（2026-11-01 定稿）：窗口内只自动放行「带 requestedMode 的沙箱升级」；
    // 没有 requestedMode 的审批（不是升级）继续交还人类，避免把免打扰扩散成"所有审批都放行"。
    if (this.deps.dnd) {
      const verdict = this.deps.dnd.evaluate({
        sessionId: context.sessionId,
        callId: context.callId,
        toolName: context.toolName,
        mode: context.mode,
        display: context.scope.display,
      });
      if (verdict === "allow") {
        this.opStats.dndAllowed += 1;
        this.operations.delete(callId);
        return "allowed-once";
      }
    }
    // ① 命中已有授权 → 代答（不调用人类答话器，也不提升任何权限）
    const reusable = await this.deps.leases.findMatching(context.sessionId, context.toolName, context.scope.key);
    if (reusable) {
      this.deps.audit.record({
        sessionId: context.sessionId,
        callId: context.callId,
        rootCallId: context.callId,
        toolName: context.toolName,
        scopeKey: context.scope.key,
        scopeDisplay: context.scope.display,
        leaseId: reusable.id,
        decision: "LEASE_REUSED",
      });
      this.opStats.reusedExact += 1;
      this.operations.delete(callId);
      return "allowed-once";
    }
    // 族放行：① 档只看「同前缀」（Claude Code 的 `Bash(npm run *)`），② 档看全部族。
    // 族放行（两档合并后**始终生效**）：前缀族是 ALL 语义（复合命令逐条都要有放行），
    // 文件/目录/只读工具族是 ANY 语义；族只由人工批准建立，并在 reuseTtlSeconds 后失效。
    // 含破坏性程序的调用：族照常登记给别人用，但**这一次**必须重新征求同意。
    if (context.blocked) {
      this.opStats.noLease += 1;
      return await next();
    }
    if (context.families && context.families.length > 0) {
      const familyGrant = this.familyGrants.match(context.families, this.now(), undefined, (leaseId) => this.deps.leases.isLive(leaseId));
      if (familyGrant) {
        this.deps.audit.record({
          sessionId: context.sessionId,
          callId: context.callId,
          rootCallId: context.callId,
          toolName: context.toolName,
          scopeKey: context.scope.key,
          scopeDisplay: `${context.scope.display} · 凭族放行：${familyGrant.label}`,
          decision: "LEASE_REUSED",
        });
        this.opStats.reusedFamily += 1;
        this.operations.delete(callId);
        return "allowed-once";
      }
    }
    // ② 未命中 → 交给人类（next 只调用一次，结果原样返回）
    this.opStats.noLease += 1;
    const result = await next();
    if (normalizeOutcome(result) === "allowed-once") {
      const ttlSeconds = this.deps.settings.reuseTtlSeconds;
      try {
        const lease = await this.deps.leases.issue({
          sessionId: context.sessionId,
          toolName: context.toolName,
          scope: context.scope,
          ttlSeconds,
          sourceCallId: callId,
        });
        // 人工批准即建立/续期这次操作所属的族（两种档位都记：① 之后只用 prefix，② 用全部）。
        // 族绑定这条授权：授权被撤销/过期后族立即失效（见 FamilyGrantStore.match 的 isLive 检查）。
        if (context.families && context.families.length > 0) {
          this.familyGrants.grant(context.families, ttlSeconds, this.now(), lease.id);
        }
        // 供 tools/result 审计关联：pre-execute 若为该 callId 建过待办，把结果补回去
        const pendingRecord = this.deps.pending.get(callId);
        if (pendingRecord) {
          pendingRecord.leaseId = lease.id;
          pendingRecord.decision = "APPROVED";
        }
        this.deps.audit.record({
          sessionId: context.sessionId,
          callId: context.callId,
          rootCallId: context.callId,
          toolName: context.toolName,
          scopeKey: context.scope.key,
          scopeDisplay: context.scope.display,
          leaseId: lease.id,
          decision: "LEASE_ISSUED",
        });
        this.opStats.issued += 1;
      } catch (err) {
        // 签发失败：Fail Closed——不签发、不放宽，只写不含 Secret 的诊断日志
        process.stderr.write(`[dsh-guard] operation lease issue failed for call ${callId}: ${String(err)}\n`);
      }
    } else {
      // 非 allowed-once：这次调用不会执行，不会再有 tools/result 兜底，立即清理 pre-execute 留下的待办
      const pendingRecord = this.deps.pending.get(callId);
      if (pendingRecord) {
        pendingRecord.decision = "REJECTED";
        this.deps.pending.delete(callId);
      }
      this.deps.audit.record({
        sessionId: context.sessionId,
        callId: context.callId,
        rootCallId: context.callId,
        toolName: context.toolName,
        scopeKey: context.scope.key,
        scopeDisplay: context.scope.display,
        decision: "APPROVAL_REJECTED",
      });
    }
    this.operations.delete(callId);
    return result;
  }
  handleToolResult(exec: ToolExecutionLike, result: { isError?: boolean }): void {
    // 作用：tools/result 观察者（规格 6.4）——记录最终结果与 Lease 使用情况；不得修改结果。
    // 已签发的 Lease 属会话级授权，其生命周期由 TTL/revoke 决定，不随单次调用结束而回收
    //（否则"批准一次复用多次"就不成立）。
    const current = typeof exec?.callId === "string" ? this.deps.pending.get(exec.callId) : undefined;
    this.recordAudit(exec, result?.isError ? "TOOL_ERROR" : "TOOL_SUCCESS", current ? { scopeKey: current.scope.key, scopeDisplay: current.scope.display, leaseId: current.leaseId } : undefined);
    if (typeof exec?.callId === "string") this.deps.pending.delete(exec.callId);
  }
  install(bus: GuardEventBus): () => void {
    // 作用：把四个 handler 挂到 DSH 事件总线——pre-execute / tools/execute / approval/request 均 prepend
    // （成为外层中间件：依次先 next() 拿到下游结果）；tools/result 是纯观察者（emit，无决策）；
    // 返回 dispose 函数（调用各 disposer、清空 pending）
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
    };
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
/** 作用：从工具参数里取命令文本（只有 shell 类工具有）——用于判断是否含破坏性程序。 */
function commandOf(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.script === "string") return record.script;
  return "";
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
