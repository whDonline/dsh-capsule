import { AuditService } from "./audit/audit-service.js";
import { sha256Scope } from "./capability/canonical.js";
import { LeaseManager } from "./capability/lease-manager.js";
import { MemoryLeaseStore } from "./capability/lease-store.js";
import { PendingRegistry } from "./capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./capability/policy.js";
import { ScopeResolver } from "./capability/scope-resolver.js";
import { SandboxGrantManager, type SandboxContext } from "./capability/sandbox-grant.js";
import type { SandboxMode } from "./capability/escalation.js";
import { DEFAULTABLE_SCOPE_MODES, SCOPE_MODES, isScopeMode, type ScopeMode } from "./capability/scope-modes.js";
import { UniversalGate } from "./capability/universal-gate.js";
import { GovernanceConsole } from "./console/console-service.js";
import { GovernancePolicy } from "./console/policy.js";
import { registerGuardWebRoutes, startConsoleServer, DEFAULT_CONSOLE_HOST, DEFAULT_CONSOLE_PORT, GUARD_WEB_PREFIX, ROUTE_RETRY_DELAYS_MS, guardRouteStatus, type GuardRouteStatus, type ConsoleHttpHandle } from "./console/http-server.js";
import type { ConsoleHttpConfig } from "./console/types.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
// 作用：P0-2 宿主适配器——把 DSH 的会话沙箱模式读写能力收敛成 SandboxContext 最小接口。
// 【cordis API 事实（2026-09-14 由插件装载测试发现）】服务必须用 `ctx.get(name)` 读取：
//   inject 声明的是**硬依赖**，而未经 inject 的服务用属性访问（`ctx.sessionProjections`）会被
//   cordis 代理直接抛 `cannot get property "…" without inject`。`ctx.get()` 在服务缺失时返回
//   undefined，正是"缺失即降级"所需的语义，因此本适配器只依赖 `ctx.get` 与 `ctx.on` 两个方法。
// 读取：ctx.get("sessionProjections").stateOf(session, "sandboxMode")
// 写入：session.append("sandbox/mode", { mode })（与 dsh-sandbox-policy 的 setSandboxMode 同源）
// 任一依赖缺失时：读返回保守默认 workspace-write，写静默忽略 → Guard 无法收紧或放宽沙箱，
// 只会回到 DSH 原生审批语义（用户多被问一次，不会越权）。
export function buildSandboxContext(ctx: CapsuleHostContext, fallbackMode: SandboxMode = "workspace-write"): SandboxContext {
  const readMode = (session: unknown): SandboxMode => {
    const projections = getService(ctx, "sessionProjections") as { stateOf?: unknown } | undefined;
    if (!projections || typeof projections.stateOf !== "function") return fallbackMode;
    try {
      const state = (projections.stateOf as (session: unknown, key: string) => unknown)(session, "sandboxMode");
      if (state === "read-only" || state === "workspace-write" || state === "danger-full-access") return state;
    } catch {
      // 投影读取异常：按缺失处理（保守默认），绝不猜测
    }
    return fallbackMode;
  };
  const writeMode = (session: unknown, mode: SandboxMode): void => {
    const append = session && typeof session === "object" ? (session as { append?: unknown }).append : undefined;
    if (typeof append !== "function") return;
    const id = session && typeof session === "object" ? (session as { id?: unknown }).id : undefined;
    if (typeof id !== "string" && typeof id !== "number") return;
    (append as (type: string, data: { mode: SandboxMode }) => unknown).call(session, "sandbox/mode", { mode });
  };
  return { sessionSandboxMode: readMode, setSessionSandboxMode: writeMode };
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
export { AuditService, GovernanceConsole, GovernancePolicy, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, SandboxGrantManager, ScopeResolver, UniversalGate, registerGuardWebRoutes, startConsoleServer, DEFAULT_UNIVERSAL_POLICY, DEFAULT_CONSOLE_HOST, DEFAULT_CONSOLE_PORT, DEFAULTABLE_SCOPE_MODES, GUARD_WEB_PREFIX, ROUTE_RETRY_DELAYS_MS, SCOPE_MODES, guardRouteStatus, isScopeMode, sha256Scope };
export type { UniversalPolicyConfig, ConsoleHttpConfig, ScopeMode, ConsoleHttpHandle, GuardRouteStatus };
// 作用：Guard 插件完整配置——策略项（Partial<UniversalPolicyConfig>）+ Phase 4 Governance Console
// 查看器开关（默认开启；提供授权剩余时间、审计与范围挡位配置）。
export interface GuardPluginConfig extends Partial<UniversalPolicyConfig> {
  console?: ConsoleHttpConfig;
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
// 作用：DSH Guard 插件入口（重构规格第 16 节）——纯 TypeScript 挂载 Universal Gate 四个 hook；
// 不 spawn Python、不依赖 Docker / Unix Domain Socket（Legacy Isolated Runtime 已按项目决策移除）。
export const name = "dsh-capability-guard";
export const inject = ["tools", "approval"];
export async function apply(ctx: CapsuleHostContext, config?: GuardPluginConfig): Promise<DisposeHook> {
  // 作用：组装 Guard 并安装到 DSH——策略来自插件配置（缺省 DEFAULT_UNIVERSAL_POLICY：默认 TTL 60s、
  // 上限 1800s、默认 exact-arguments scope）；任何安装失败立即抛错（Fail Closed，绝不静默降级）。
  // 治理台聚合授权、工具调用与审计；不注册凭证服务或代理执行工具。
  const deployment = {
    enabled: config?.enabled ?? DEFAULT_UNIVERSAL_POLICY.enabled,
    rules: config?.rules ?? DEFAULT_UNIVERSAL_POLICY.rules,
    defaultScopePaths: config?.defaultScopePaths ?? DEFAULT_UNIVERSAL_POLICY.defaultScopePaths,
  };
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
  const leases = new LeaseManager(new MemoryLeaseStore());
  const audit = new AuditService();
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    // P0-2：沙箱模式有界授权。宿主服务缺失时该链路自动失效（Fail Closed：不提升 = 不越权），
    // 其余 Universal Mode 行为完全不受影响
    sandboxGrants: new SandboxGrantManager(buildSandboxContext(ctx), leases),
  });
  const govConsole = new GovernanceConsole({ audit, leases, guardName: name });
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  // 同源治理路由（优先）：挂到 DSH Web 服务器的 /guard/…，Web GUI 面板因此与页面同源，
  // 不需要跨源请求、也不依赖额外端口。宿主没有 webServer（headless 等组合）时自动跳过。
  // 注册结果记录在 guardRouteStatus 里（GET /api/config 的 routes 字段），失败可自证原因。
  const disposeRoutes = registerGuardWebRoutes(ctx as { get?(name: string): unknown }, govConsole, governance) ?? (() => undefined);
  let consoleHandle: ConsoleHttpHandle | undefined;
  const consoleConfig = resolveConsoleConfig(config);
  if (consoleConfig.enabled) {
    consoleHandle = await startConsoleServer({ console: govConsole, policy: governance, host: consoleConfig.host, port: consoleConfig.port, fallbackPort: consoleConfig.fallbackPort });
    process.stderr.write(`[dsh-guard] governance console: ${consoleHandle.url} (同源入口 ${GUARD_WEB_PREFIX}/, routes=${JSON.stringify(guardRouteStatus)})\n`);
  }
  return async () => {
    if (consoleHandle) {
      await consoleHandle.close();
    }
    disposeRoutes();
    dispose();
  };
}
