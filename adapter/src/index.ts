import { AuditService } from "./audit/audit-service.js";
import { sha256Scope } from "./capability/canonical.js";
import { LeaseManager } from "./capability/lease-manager.js";
import { MemoryLeaseStore } from "./capability/lease-store.js";
import { PendingRegistry } from "./capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./capability/policy.js";
import { ScopeResolver } from "./capability/scope-resolver.js";
import { SandboxGrantManager, type SandboxContext } from "./capability/sandbox-grant.js";
import { isSandboxMode, type SandboxMode } from "./capability/escalation.js";
import { DEFAULTABLE_SCOPE_MODES, SCOPE_MODES, isScopeMode, type ScopeMode } from "./capability/scope-modes.js";
import { UniversalGate } from "./capability/universal-gate.js";
import { GuardActions } from "./console/actions.js";
import { GovernanceConsole } from "./console/console-service.js";
import { GovernancePolicy } from "./console/policy.js";
import { createHostSessionDirectory } from "./console/session-directory.js";
import { DEFAULT_GUARD_SETTINGS, GuardSettings, isGuardMode, type GuardMode } from "./capability/settings.js";
import { AuditJournal } from "./audit/journal.js";
import type { ToolAuditEvent } from "./audit/types.js";
import type { CapabilityLease } from "./capability/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
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
export { AuditService, GovernanceConsole, GovernancePolicy, GuardActions, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, SandboxGrantManager, ScopeResolver, UniversalGate, createHostSessionDirectory, registerGuardWebRoutes, startConsoleServer, DEFAULT_UNIVERSAL_POLICY, DEFAULT_CONSOLE_HOST, DEFAULT_CONSOLE_PORT, DEFAULTABLE_SCOPE_MODES, GUARD_WEB_PREFIX, ROUTE_RETRY_DELAYS_MS, SCOPE_MODES, guardRouteStatus, isScopeMode, sha256Scope };
export type { UniversalPolicyConfig } from "./capability/policy.js";
export type { ScopeMode } from "./capability/scope-modes.js";
export type { ConsoleHttpConfig } from "./console/types.js";
export type { ConsoleHttpHandle, GuardRouteStatus } from "./console/http-server.js";
export type { GuardMode, GuardSettingsSnapshot } from "./capability/settings.js";
// 作用：Guard 插件完整配置——策略项（Partial<UniversalPolicyConfig>）+ Phase 4 Governance Console
// 查看器开关（默认开启；提供授权剩余时间、审计与范围挡位配置）+ 沙箱档位低频回滚节拍。
export interface GuardPluginConfig extends Partial<UniversalPolicyConfig> {
  console?: ConsoleHttpConfig;
  /** 低频结算节拍（毫秒）：默认 30000；0 表示关闭（关闭后档位只在下次工具调用 / 用户点按钮时回收）。
   * 【不是安全机制】授权是否有效始终在读写时实时判定，本定时器只负责让「到期后档位回收」更及时。 */
  sweepIntervalMs?: number;
  /** 用户开关的初始值（默认 true）。运行期可在「能力授权」页切换，不落盘。 */
  modeEnabled?: boolean;
  /** 三档范围模式的初始值：same-operation（默认）/ same-family / do-not-disturb */
  mode?: GuardMode;
  /** ①② 复用时长（秒）；缺省沿用 defaultTtlSeconds */
  reuseTtlSeconds?: number;
  /** ③ 免打扰的目标档位与时长（秒） */
  dndTargetMode?: SandboxMode;
  dndDurationSeconds?: number;
  /** 审计持久化（默认开启）：事件与授权追加写入本地 NDJSON，重启后可重放 */
  persistAudit?: boolean;
  /** 审计日志路径（默认 <用户目录>/.dsh/capability-guard/audit.ndjson） */
  auditFile?: string;
}
/** 作用：默认审计日志路径——放用户目录而不是 workspace，避免被误提交进仓库。 */
export function defaultAuditFile(): string {
  return join(homedir(), ".dsh", "capability-guard", "audit.ndjson");
}
/** 默认低频结算节拍——多快把「已失效授权的会话宽档位」收回去（治理台会显示「待回滚」直到收回）。 */
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
  // 用户可见的三档设置（开关 / 同操作 / 同族 / 免打扰）。与部署策略相互独立：
  // 部署 enabled=false 表示"不装配"，这里的 enabled=false 表示"装好了但用户关掉了"。
  const settings = new GuardSettings({
    initial: {
      enabled: config?.modeEnabled ?? DEFAULT_GUARD_SETTINGS.enabled,
      mode: isGuardMode(config?.mode) ? config.mode : DEFAULT_GUARD_SETTINGS.mode,
      reuseTtlSeconds: config?.reuseTtlSeconds ?? governance.current.defaultTtlSeconds,
      dndTargetMode: isSandboxMode(config?.dndTargetMode) ? config.dndTargetMode : DEFAULT_GUARD_SETTINGS.dndTargetMode,
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
    // 重放：同一 Lease 的多条记录只保留最后一条状态（签发 → 撤销/过期），避免重复入库
    const events: ToolAuditEvent[] = [];
    const latestLeases = new Map<string, CapabilityLease>();
    for (const record of journal.load()) {
      if (record.type === "event") events.push(record.event);
      else latestLeases.set(record.lease.id, record.lease);
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
  // P0-2：沙箱模式有界授权。宿主服务缺失时该链路自动失效（Fail Closed：不提升 = 不越权），
  // 其余 Universal Mode 行为完全不受影响。实例在此保留引用：治理台要读它的档位状态，
  // 收缩型动作要经它回滚档位（此前只注入 Gate，导致治理台完全看不到沙箱状态）。
  const sandboxGrants = new SandboxGrantManager(buildSandboxContext(ctx), leases);
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    sandboxGrants,
    // 用户开关关闭时所有 hook 直接透传（不签发、不提升、不改写任何状态）
    settings,
  });
  const govConsole = new GovernanceConsole({
    audit,
    leases,
    guardName: name,
    // 治理台的两个状态来源：授权来自 LeaseManager，档位来自 SandboxGrantManager 的实时投影
    sandbox: { states: () => sandboxGrants.grantStates(), lastOutcomeOf: (sessionId: string) => sandboxGrants.lastOutcomeOf(sessionId) },
    // 会话显示名（可选能力：读不到标题就降级为 cwd / 短 ID）
    sessions: createHostSessionDirectory(ctx),
  });
  // 收缩型治理动作：撤销授权 / 回滚档位。二者都只会让权限变小（见 console/actions.ts 注释）
  const actions = new GuardActions({
    leases,
    sandbox: sandboxGrants,
    audit,
    // 免打扰窗口要真正生效必须提升会话档位：这里按 cordis 的方式解析 Session（缺失时动作层拒绝开窗，Fail Closed）
    resolveSession: (sessionId: string) => {
      const sessions = getService(ctx, "sessions") as { get?: (id: string) => unknown } | undefined;
      if (!sessions || typeof sessions.get !== "function") return undefined;
      try {
        return sessions.get(sessionId);
      } catch {
        return undefined;
      }
    },
    maxTtlSeconds: () => governance.config.maxTtlSeconds,
    // 只允许给「配置里真的走沙箱升级链路」的工具开窗（防止把窗口变成任意工具的放宽通道）
    allowTool: (toolName: string) => {
      try {
        const resolved = new PolicyResolver(policyConfig).resolve(toolName);
        return resolved.enabled && resolved.scope.mode === "sandbox-escalation";
      } catch {
        return false;
      }
    },
  });
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  // 低频结算：把「授权已失效但档位还没收回」的会话宽模式及时收回去。
  // 正确性不依赖它（安全性由 LeaseManager 实时判定），关闭它只会让回滚推迟到下次工具调用。
  const sweepIntervalMs = resolveSweepInterval(config);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      void gate.settleNow().catch((err: unknown) => {
        process.stderr.write(`[dsh-guard] sandbox sweep failed: ${String(err)}\n`);
      });
    }, sweepIntervalMs);
    // 定时器不应阻止进程退出
    (sweepTimer as { unref?: () => void }).unref?.();
  }
  // 同源治理路由（优先）：挂到 DSH Web 服务器的 /guard/…，Web GUI 面板因此与页面同源，
  // 不需要跨源请求、也不依赖额外端口。宿主没有 webServer（headless 等组合）时自动跳过。
  // 注册结果记录在 guardRouteStatus 里（GET /api/config 的 routes 字段），失败可自证原因。
  const disposeRoutes = registerGuardWebRoutes(ctx as { get?(name: string): unknown }, govConsole, governance, { actions, sweepIntervalMs, settings }) ?? (() => undefined);
  let consoleHandle: ConsoleHttpHandle | undefined;
  const consoleConfig = resolveConsoleConfig(config);
  if (consoleConfig.enabled) {
    consoleHandle = await startConsoleServer({ console: govConsole, policy: governance, actions, sweepIntervalMs, settings, host: consoleConfig.host, port: consoleConfig.port, fallbackPort: consoleConfig.fallbackPort });
    process.stderr.write(`[dsh-guard] governance console: ${consoleHandle.url} (同源入口 ${GUARD_WEB_PREFIX}/, sweep=${sweepIntervalMs}ms, routes=${JSON.stringify(guardRouteStatus)})\n`);
  }
  return async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    if (consoleHandle) {
      await consoleHandle.close();
    }
    disposeRoutes();
    dispose();
  };
}
