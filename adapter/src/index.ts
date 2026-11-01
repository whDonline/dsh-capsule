import { AuditService } from "./audit/audit-service.js";
import { isAuditDecision } from "./audit/catalog.js";
import { sha256Scope } from "./capability/canonical.js";
import { LeaseManager } from "./capability/lease-manager.js";
import { MemoryLeaseStore } from "./capability/lease-store.js";
import { PendingRegistry } from "./capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./capability/policy.js";
import { ScopeResolver } from "./capability/scope-resolver.js";
import { createSensitivePathGuard, defaultSensitiveRules, parseExtraRules, type SensitivePathRule } from "./capability/sensitive-paths.js";
import { AccessLog, directoryOf, isOutsideWorkspace, toolPathOf } from "./capability/access-log.js";
import { DndManager } from "./capability/dnd.js";
import { isSandboxMode, type SandboxMode } from "./capability/escalation.js";
import { DEFAULTABLE_SCOPE_MODES, SCOPE_MODES, isScopeMode, type ScopeMode } from "./capability/scope-modes.js";
import { UniversalGate } from "./capability/universal-gate.js";
import { GuardActions } from "./console/actions.js";
import { GovernanceConsole } from "./console/console-service.js";
import { GovernancePolicy } from "./console/policy.js";
import { createHostSessionDirectory } from "./console/session-directory.js";
import { DEFAULT_GUARD_SETTINGS, GuardSettings } from "./capability/settings.js";
import { AuditJournal } from "./audit/journal.js";
import type { ToolAuditEvent } from "./audit/types.js";
import type { ToolExecutionLike } from "./capability/types.js";
import type { CapabilityLease } from "./capability/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerGuardWebRoutes, startConsoleServer, DEFAULT_CONSOLE_HOST, DEFAULT_CONSOLE_PORT, GUARD_WEB_PREFIX, ROUTE_RETRY_DELAYS_MS, guardRouteStatus, type GuardRouteStatus, type ConsoleHttpHandle } from "./console/http-server.js";
import type { ConsoleHttpConfig } from "./console/types.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
// 作用：宿主适配器——把 DSH 的「读取会话沙箱模式」能力收敛成一个只有读取的最小接口。
// 本插件**不写**沙箱档位（2026-11-01：提升档位 + 回滚整条链路已删除），因此这里没有 setter，
// 编译期就保证 Guard 无法改动用户的沙箱设置。
// 【cordis API 事实（2026-09-14 由插件装载测试发现）】服务必须用 `ctx.get(name)` 读取：
//   inject 声明的是**硬依赖**，而未经 inject 的服务用属性访问（`ctx.sessionProjections`）会被
//   cordis 代理直接抛 `cannot get property "…" without inject`。`ctx.get()` 在服务缺失时返回
//   undefined，正是"缺失即降级"所需的语义，因此本适配器只依赖 `ctx.get`。
// 读取：ctx.get("sessionProjections").stateOf(session, "sandboxMode")
// 依赖缺失时：读返回保守默认 workspace-write → 免打扰窗口的「完全访问下不可开启」判断会退化为
// 不拦截；这只影响提示准确性，不涉及任何权限放宽。
export interface SandboxModeReader {
  /** 读取该 session 当前生效的沙箱模式。 */
  sessionSandboxMode(session: unknown): SandboxMode;
}
export function buildSandboxModeReader(ctx: CapsuleHostContext, fallbackMode: SandboxMode = "workspace-write"): SandboxModeReader {
  const readMode = (session: unknown): SandboxMode => {
    const projections = getService(ctx, "sessionProjections") as { stateOf?: unknown } | undefined;
    if (!projections || typeof projections.stateOf !== "function") return fallbackMode;
    try {
      const state = (projections.stateOf as (session: unknown, key: string) => unknown)(session, "sandboxMode");
      if (isSandboxMode(state)) return state;
    } catch {
      // 投影读取异常：按缺失处理（保守默认），绝不猜测
    }
    return fallbackMode;
  };
  return { sessionSandboxMode: readMode };
}
function getService(ctx: CapsuleHostContext, name: string): unknown {
  // 作用：按 cordis 的方式解析宿主服务——只走 `ctx.get(name)`（缺失返回 undefined，不抛错）。
  // 刻意【不用】属性访问：未经 inject 的服务在 cordis 代理上访问属性会直接抛错。
  const get = (ctx as { get?: unknown }).get;
  if (typeof get !== "function") return undefined;
  try {
    return (get as (name: string) => unknown).call(ctx, name);
  } catch {
    return undefined;
  }
}
export { AuditService, GovernanceConsole, GovernancePolicy, GuardActions, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, ScopeResolver, UniversalGate, createHostSessionDirectory, registerGuardWebRoutes, startConsoleServer, DEFAULT_UNIVERSAL_POLICY, DEFAULT_CONSOLE_HOST, DEFAULT_CONSOLE_PORT, DEFAULTABLE_SCOPE_MODES, GUARD_WEB_PREFIX, ROUTE_RETRY_DELAYS_MS, SCOPE_MODES, guardRouteStatus, isScopeMode, sha256Scope };
export type { UniversalPolicyConfig } from "./capability/policy.js";
export type { ScopeMode } from "./capability/scope-modes.js";
export type { ConsoleHttpConfig } from "./console/types.js";
export type { ConsoleHttpHandle, GuardRouteStatus } from "./console/http-server.js";
export type { GuardMode, GuardSettingsSnapshot } from "./capability/settings.js";
// 作用：Guard 插件完整配置——策略项（Partial<UniversalPolicyConfig>）+ Phase 4 Governance Console
// 查看器开关（默认开启；提供授权剩余时间、审计与范围挡位配置）+ 免打扰窗口结算节拍。
export interface GuardPluginConfig extends Partial<UniversalPolicyConfig> {
  console?: ConsoleHttpConfig;
  /** 低频结算节拍（毫秒）：默认 30000；0 表示关闭。只用于让免打扰窗口的过期/档位漂移结算更及时；
   * 授权是否有效始终在读写时实时判定，因此它【不是安全机制】。 */
  sweepIntervalMs?: number;
  /** 用户开关的初始值（默认 true）。运行期可在「能力授权」页切换，不落盘。 */
  modeEnabled?: boolean;
  /** ① ② 复用时长（秒）；缺省沿用产品默认 */
  reuseTtlSeconds?: number;
  /** 免打扰窗口的默认时长（秒） */
  dndDurationSeconds?: number;
  /** 审计持久化（默认开启）：事件与授权追加写入本地 NDJSON，重启后可重放 */
  persistAudit?: boolean;
  /** 审计日志路径（默认 <用户目录>/.dsh/capability-guard/audit.ndjson） */
  auditFile?: string;
  /** 敏感路径静态保护（默认开启）：true/false 或 { enabled, extra: [{ path, scope }] }。
   * 只经由 DSH 原生 `ctx.tools.guard()` 拒绝，不修改任何权限；命令类工具只做文本扫描（启发式）。 */
  sensitivePaths?: boolean | SensitivePathsConfig;
  /** 工作区外访问记录（默认开启）：只记目录、不记文件名；false 关闭。 */
  accessLog?: boolean;
}
export interface SensitivePathsConfig {
  enabled?: boolean;
  extra?: readonly { path: string; scope?: "deny" | "deny-write" }[];
}
/** 作用：默认审计日志路径——放用户目录而不是 workspace，避免被误提交进仓库。 */
export function defaultAuditFile(): string {
  return join(homedir(), ".dsh", "capability-guard", "audit.ndjson");
}
/** 默认低频结算节拍——多快把已到期的免打扰窗口收掉（治理台会显示窗口剩余时间）。 */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
// 作用：解析并校验结算节拍——必须是非负整数（0 = 关闭）；非法值 Fail Closed 直接拒绝装配，
// 避免出现「配了个 NaN 就静默不结算」的难以察觉的偏差。
export function resolveSweepInterval(config: GuardPluginConfig | undefined): number {
  const raw = config?.sweepIntervalMs;
  if (raw === undefined) return DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error("GUARD_INSTALL_FAILED: sweepIntervalMs must be a non-negative integer");
  }
  return raw;
}
// 作用：Governance Console 默认配置——**默认启动**并绑定 loopback。治理页面是本插件的主要可用性
// 入口（查看哪些授权还剩多久、审计、切换范围挡位），因此默认开启；端口被占用时回退到随机端口
// （不会让插件装配失败），端口与访问地址同时写入 stderr 供用户直接打开。
export function resolveConsoleConfig(config: GuardPluginConfig | undefined): Required<Pick<ConsoleHttpConfig, "enabled" | "host" | "port">> & { fallbackPort: boolean } {
  const raw = config?.console;
  const host = raw?.host ?? DEFAULT_CONSOLE_HOST;
  const port = raw?.port ?? DEFAULT_CONSOLE_PORT;
  return { enabled: raw?.enabled !== false, host, port, fallbackPort: true };
}
// 作用：解析敏感路径配置——缺省开启；非法形状直接拒绝装配（Fail Closed），不静默忽略。
export function resolveSensitivePathsConfig(config: GuardPluginConfig | undefined): { enabled: boolean; extra: readonly SensitivePathRule[] } {
  const raw = config?.sensitivePaths;
  if (raw === undefined || raw === true) return { enabled: true, extra: [] };
  if (raw === false) return { enabled: false, extra: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("GUARD_INSTALL_FAILED: sensitivePaths must be a boolean or an object");
  }
  return { enabled: raw.enabled !== false, extra: parseExtraRules(raw.extra) };
}
// 作用：解析访问记录开关——默认开启；非法类型直接拒绝装配（Fail Closed），避免"配错了静默不记录"。
export function resolveAccessLogConfig(config: GuardPluginConfig | undefined): boolean {
  const raw = config?.accessLog;
  if (raw === undefined) return true;
  if (typeof raw !== "boolean") throw new Error("GUARD_INSTALL_FAILED: accessLog must be a boolean");
  return raw;
}
// 作用：DSH Guard 插件入口（重构规格第 16 节）——纯 TypeScript 挂载 Universal Gate 四个 hook；
// 不 spawn Python、不依赖 Docker / Unix Domain Socket（Legacy Isolated Runtime 已按项目决策移除）。
export const name = "dsh-capability-guard";
export const inject = ["tools", "approval"];
export async function apply(ctx: CapsuleHostContext, config?: GuardPluginConfig): Promise<DisposeHook> {
  // 作用：组装 Guard 并安装到 DSH——策略来自插件配置（缺省 DEFAULT_UNIVERSAL_POLICY：默认 TTL 60s、
  // 上限 1800s、默认 exact-arguments scope）；任何安装失败立即抛错（Fail Closed，绝不静默降级）。
  // 治理台聚合授权、工具调用与审计；不注册凭证服务或代理执行工具，也不写沙箱档位。
  const deployment = {
    enabled: config?.enabled ?? DEFAULT_UNIVERSAL_POLICY.enabled,
    rules: config?.rules ?? DEFAULT_UNIVERSAL_POLICY.rules,
    defaultScopePaths: config?.defaultScopePaths ?? DEFAULT_UNIVERSAL_POLICY.defaultScopePaths,
  };
  // 先在装配早期校验敏感路径配置（Fail Closed）：非法配置不应在装了一半 hook 之后才报错。
  const sensitiveConfig = resolveSensitivePathsConfig(config);
  const accessLogEnabled = resolveAccessLogConfig(config);
  const governance = new GovernancePolicy({
    initial: {
      defaultScope: isScopeMode(config?.defaultScope) ? config.defaultScope : DEFAULT_UNIVERSAL_POLICY.defaultScope,
      defaultTtlSeconds: config?.defaultTtlSeconds ?? DEFAULT_UNIVERSAL_POLICY.defaultTtlSeconds,
      maxTtlSeconds: config?.maxTtlSeconds ?? DEFAULT_UNIVERSAL_POLICY.maxTtlSeconds,
    },
    deployment,
    source: "plugin-config",
  });
  const policyConfig = (): UniversalPolicyConfig => ({ ...governance.config, defaultScopePaths: deployment.defaultScopePaths });
  // 用户可见的设置（开关 / 复用时长 / 免打扰默认时长）。与部署策略相互独立：
  // 部署 enabled=false 表示"不装配"，这里的 enabled=false 表示"装好了但用户关掉了"。
  const settings = new GuardSettings({
    initial: {
      enabled: config?.modeEnabled ?? DEFAULT_GUARD_SETTINGS.enabled,
      // 复用时长默认取「产品默认」（30 分钟 = 一次开发会话），而不是部署策略里的 defaultTtlSeconds；
      // 否则把默认值调大也没用（实测：默认仍是 300 秒）。
      reuseTtlSeconds: config?.reuseTtlSeconds ?? DEFAULT_GUARD_SETTINGS.reuseTtlSeconds,
      dndDurationSeconds: config?.dndDurationSeconds ?? DEFAULT_GUARD_SETTINGS.dndDurationSeconds,
    },
    maxTtlSeconds: governance.current.maxTtlSeconds,
  });
  // 审计持久化：追加式 NDJSON（事件 + 授权），重启时重放——否则 DSH 一重启，历史审计全丢。
  // 关闭方式：profile 里 `persistAudit: false`；路径可用 `auditFile` 覆盖（默认用户目录）。
  const journal = config?.persistAudit === false ? undefined : new AuditJournal(config?.auditFile ?? defaultAuditFile());
  const store = new MemoryLeaseStore();
  const audit = new AuditService(1000, journal ? (event) => journal.append({ type: "event", event }) : undefined);
  if (journal) {
    // 重放：同一 Lease 的多条记录只保留最后一条状态（签发 → 撤销/过期），避免重复入库。
    // 兼容旧日志：已移除的决策（沙箱档位提升/回滚）与旧的 sandbox-mode 授权一律跳过——
    // 那些授权对应的能力已经不存在，重放它们只会让治理台显示一条永远不会生效的"授权"。
    const events: ToolAuditEvent[] = [];
    const latestLeases = new Map<string, CapabilityLease>();
    for (const record of journal.load()) {
      if (record.type === "event") {
        if (isAuditDecision(record.event?.decision)) events.push(record.event);
      } else if (record.lease?.kind === "universal") {
        latestLeases.set(record.lease.id, record.lease);
      }
    }
    audit.restore(events);
    for (const lease of latestLeases.values()) {
      try {
        store.insert(lease);
      } catch {
        // 单条坏数据跳过，不影响其余历史
      }
    }
  }
  const leases = new LeaseManager(store, Date.now, journal ? (lease) => journal.append({ type: "lease", lease }) : undefined);
  // 免打扰窗口（2026-11-01 定稿）：任务级"限时完全访问"的审批放行层。
  // 只放行窗口内带 requestedMode 的已记录升级；不改沙箱档位、不改审批策略、不签发 Lease。
  const resolveSession = (sessionId: string): unknown => {
    const sessions = getService(ctx, "sessions") as { get?: (id: string) => unknown } | undefined;
    if (!sessions || typeof sessions.get !== "function") return undefined;
    try {
      return sessions.get(sessionId);
    } catch {
      return undefined;
    }
  };
  const resolveMode = (sessionId: string): SandboxMode | undefined => {
    const session = resolveSession(sessionId);
    if (session === undefined || session === null) return undefined;
    const policy = getService(ctx, "sandboxPolicy") as { resolve?: (request: { session: unknown }) => { mode?: unknown } } | undefined;
    if (policy && typeof policy.resolve === "function") {
      try {
        const resolved = policy.resolve({ session });
        if (isSandboxMode(resolved?.mode)) return resolved.mode;
      } catch {
        // 读取失败时回落到投影读取
      }
    }
    try {
      return buildSandboxModeReader(ctx).sessionSandboxMode(session);
    } catch {
      return undefined;
    }
  };
  const dnd = new DndManager({
    audit,
    modeOf: resolveMode,
    maxWindowMs: () => governance.config.maxTtlSeconds * 1000,
  });
  // 作用：读会话工作区根——敏感路径的「相对路径」按它解析；读不到就交给 normalizePath 用 cwd 兜底。
  const resolveWorkspaceRoot = (session: unknown): string | undefined => {
    if (session === undefined || session === null) return undefined;
    const policy = getService(ctx, "sandboxPolicy") as { resolve?: (request: { session: unknown }) => { workspaceRoot?: unknown } } | undefined;
    if (policy && typeof policy.resolve === "function") {
      try {
        const resolved = policy.resolve({ session });
        if (typeof resolved?.workspaceRoot === "string" && resolved.workspaceRoot.length > 0) return resolved.workspaceRoot;
      } catch {
        // 读取失败：返回 undefined（调用方用 cwd 兜底）
      }
    }
    return undefined;
  };
  // 工作区外访问记录：只记目录、只记工作区外的文件类工具调用；它是可观测性，不参与判定。
  const accessLog = new AccessLog();
  const observeTool = (exec: ToolExecutionLike): void => {
    if (!accessLogEnabled) return;
    const info = toolPathOf(exec.name, exec.arguments);
    const sessionId = exec.agent?.id;
    if (!info || typeof sessionId !== "string" || sessionId.length === 0) return;
    const session = (exec as { agent?: { session?: unknown } }).agent?.session;
    const root = resolveWorkspaceRoot(session);
    if (!root) return;
    const context = { home: homedir(), platform: process.platform, workspaceRoot: root };
    if (!isOutsideWorkspace(info.path, root, context)) return;
    const dir = directoryOf(info.path, context);
    accessLog.record({ sessionId, toolName: exec.name, dir, operation: info.operation });
    audit.record({
      sessionId,
      callId: typeof exec.callId === "string" ? exec.callId : "",
      rootCallId: typeof exec.rootCallId === "string" ? exec.rootCallId : "",
      toolName: exec.name,
      scopeKey: `access:${dir}`,
      scopeDisplay: `工作区外${info.operation === "write" ? "写入" : "读取"}：${dir}`,
      decision: "ACCESS_OUTSIDE",
    });
  };
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    dnd,
    observe: observeTool,
    // 用户开关关闭时所有 hook 直接透传（不签发、不提升、不改写任何状态）
    settings,
  });
  const govConsole = new GovernanceConsole({
    audit,
    leases,
    guardName: name,
    // 免打扰窗口是独立于 Lease 的实时状态（不进授权列表、不伪装成授权）
    dnd: { view: (sessionId: string) => dnd.view(sessionId) },
    // 工作区外访问记录（只读投影，目录级）
    access: { view: (sessionId: string) => accessLog.view(sessionId) },
    // 宿主实时档位：只用于展示「当前是哪一档」与免打扰的适用性判断
    currentMode: resolveMode,
    // 会话显示名（可选能力：读不到标题就降级为 cwd / 短 ID）
    sessions: createHostSessionDirectory(ctx),
  });
  // 收缩型治理动作：撤销授权（只会让权限变小）
  const actions = new GuardActions({ leases, audit });
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  // 敏感路径静态保护：注册到 DSH 原生单调 guard（只许拒、不许放），不是我们自己发明的拦截器。
  // 服务缺失时退化为「不保护」，并写 stderr；绝不因为缺服务而拒绝一切调用。
  const sensitiveRules = [...defaultSensitiveRules({ home: homedir(), platform: process.platform }), ...sensitiveConfig.extra];
  const toolsService = getService(ctx, "tools") as { guard?: unknown } | undefined;
  let disposeSensitiveGuard: (() => void) | undefined;
  if (sensitiveConfig.enabled && toolsService && typeof toolsService.guard === "function") {
    const guardFn = createSensitivePathGuard({
      rules: sensitiveRules,
      context: (exec) => ({
        home: homedir(),
        platform: process.platform,
        workspaceRoot: resolveWorkspaceRoot((exec as { agent?: { session?: unknown } }).agent?.session),
      }),
      onDeny: (exec, hit) => {
        audit.record({
          sessionId: typeof exec.agent?.id === "string" ? exec.agent.id : undefined,
          callId: typeof exec.callId === "string" ? exec.callId : "",
          rootCallId: typeof exec.rootCallId === "string" ? exec.rootCallId : "",
          toolName: typeof exec.name === "string" ? exec.name : "",
          scopeKey: `sensitive:${hit.rule.id}`,
          scopeDisplay: `命中敏感路径保护「${hit.rule.id}」：${hit.target}（${hit.rule.scope === "deny" ? "读写都禁止" : "只禁止写入"}）${hit.heuristic ? "（命令文本启发式）" : ""}`,
          decision: "STATIC_DENY",
        });
      },
    });
    try {
      // 用户关掉 Guard 时，敏感路径保护也必须一起停（保持「关闭 = 完全不介入」的语义）。
      const rawGuard = guardFn;
      const guarded = (exec: Parameters<typeof rawGuard>[0]) => (settings.active ? rawGuard(exec) : undefined);
      const disposer = (toolsService.guard as (fn: typeof guarded) => unknown).call(toolsService, guarded);
      if (typeof disposer === "function") disposeSensitiveGuard = disposer as () => void;
    } catch (err) {
      process.stderr.write(`[dsh-guard] sensitive paths guard unavailable: ${String(err)}\n`);
    }
  }
  // 免打扰时间窗：Gate 只负责在审批到达时问 manager；窗口状态由 DndManager 独占（不写档位、不签 Lease）。
  const consoleActions = {
    // 显式委托：GuardActions 是 class，方法在原型上，展开运算符拷不过来
    revokeSession: (sessionId: string) => actions.revokeSession(sessionId),
    startDnd: (sessionId: string, ttlSeconds: number) => {
      if (!settings.active) throw new Error("GUARD_DND_INVALID: 能力授权已关闭，免打扰不会生效");
      if (resolveSession(sessionId) === undefined) throw new Error("GUARD_DND_INVALID: session not resolvable");
      const view = dnd.start(sessionId, ttlSeconds);
      return { sessionId, expiresAt: view.expiresAt };
    },
    stopDnd: (sessionId: string) => dnd.stop(sessionId, "user"),
    extendDnd: (sessionId: string, addSeconds: number) => {
      const view = dnd.extend(sessionId, addSeconds);
      return { sessionId, expiresAt: view.expiresAt };
    },
  };
  // 低频结算：让免打扰窗口的「已到期 / 原生档位被改」及时落到状态与审计上。
  // 正确性不依赖它（窗口有效性在每次判定时实时比较），关闭它只会让状态晚一点更新。
  const sweepIntervalMs = resolveSweepInterval(config);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      dnd.sweep();
    }, sweepIntervalMs);
    // 定时器不应阻止进程退出
    (sweepTimer as { unref?: () => void }).unref?.();
  }
  // 同源治理路由（优先）：挂到 DSH Web 服务器的 /guard/…，Web GUI 面板因此与页面同源，
  // 不需要跨源请求、也不依赖额外端口。宿主没有 webServer（headless 等组合）时自动跳过。
  // 注册结果记录在 guardRouteStatus 里（GET /api/config 的 routes 字段），失败可自证原因。
  const disposeRoutes = registerGuardWebRoutes(ctx as { get?(name: string): unknown }, govConsole, governance, { actions: consoleActions, sweepIntervalMs, settings, diagnostics: () => gate.diagnostics() }) ?? (() => undefined);
  let consoleHandle: ConsoleHttpHandle | undefined;
  const consoleConfig = resolveConsoleConfig(config);
  if (consoleConfig.enabled) {
    consoleHandle = await startConsoleServer({ console: govConsole, policy: governance, actions: consoleActions, sweepIntervalMs, settings, diagnostics: () => gate.diagnostics(), host: consoleConfig.host, port: consoleConfig.port, fallbackPort: consoleConfig.fallbackPort });
    process.stderr.write(`[dsh-guard] governance console: ${consoleHandle.url} (同源入口 ${GUARD_WEB_PREFIX}/, sweep=${sweepIntervalMs}ms, routes=${JSON.stringify(guardRouteStatus)})\n`);
  }
  // 启动自检：把「接线是否真的挂上」写成一条审计，排障时先看它。
  audit.record({
    callId: "",
    rootCallId: "",
    toolName: name,
    scopeKey: "guard:apply",
    scopeDisplay: `已装载：sensitivePaths=${sensitiveConfig.enabled ? (disposeSensitiveGuard ? `on(${sensitiveRules.length} 条规则)` : "unavailable") : "off"}，accessLog=${accessLogEnabled ? "on" : "off"}，console=${consoleConfig.enabled ? "on" : "off"}，sweep=${sweepIntervalMs}ms`,
    decision: "GUARD_APPLY",
  });
  return async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    // 插件卸载/重载时窗口立即失效（fail closed），并留下关闭记录
    dnd.closeAll("plugin-dispose");
    if (disposeSensitiveGuard) disposeSensitiveGuard();
    accessLog.clear();
    if (consoleHandle) {
      await consoleHandle.close();
    }
    disposeRoutes();
    dispose();
  };
}
