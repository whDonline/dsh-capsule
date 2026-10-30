// 作用：Governance Console 只读 HTTP 查看器 + 治理 API（规格第 24 节 Phase 4 及其治理扩展）。
// 默认只绑定 loopback；GET 提供页面与只读投影（快照 / 审计 / 策略），PATCH /api/config 是唯一写接口，
// 只允许修改「默认范围挡位」等运行期策略项（enabled / rules 属于部署配置，接口层就不可达）。
//
// 【安全约束（逐条对应代码）】
//   1. 仅接受 loopback 来源的 Host 头（拒绝 DNS rebinding：解析出的 Host 必须是 127.0.0.1/localhost/[::1]）；
//   2. 写接口必须带 `content-type: application/json` 且 `x-dsh-guard: 1` 自定义头——浏览器对跨源
//      自定义头会先发预检，而预检在此被拒绝，因此恶意页面无法用简单请求伪造写入（CSRF 防护）；
//   3. 非 GET/PATCH 一律 405；未知路径 404；任何异常 Fail Closed 返回 500（细节只写 stderr）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuditDecision } from "../audit/types.js";
import { SCOPE_MODES, DEFAULTABLE_SCOPE_MODES, isScopeMode, type ScopeMode } from "../capability/scope-modes.js";
import { CONSOLE_HTML, CONSOLE_CLIENT_JS } from "./console-ui.js";
import { GovernancePolicy, type ConsolePolicySnapshot } from "./policy.js";
import type { GovernanceConsole } from "./console-service.js";
import type { ConsoleActions, ConsoleAuditQuery } from "./types.js";
export interface ConsoleHttpOptions {
  console: GovernanceConsole;
  /** 运行期治理策略（挡位 / TTL）；未注入时写接口一律拒绝（Fail Closed） */
  policy?: GovernancePolicy;
  /** 收缩型治理动作（撤销 / 回滚档位）；未注入时相关接口返回 503 */
  actions?: ConsoleActions;
  /** 档位自动回滚节拍（毫秒，0 = 关闭）——只用于在页面上如实说明「多久内会自动回滚」 */
  sweepIntervalMs?: number;
  host?: string;
  port?: number;
  /** 端口被占用时是否回退到系统分配的随机端口（默认 true；false 时启动失败直接抛错） */
  fallbackPort?: boolean;
}
export interface ConsoleHttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}
export const DEFAULT_CONSOLE_HOST = "127.0.0.1";
export const DEFAULT_CONSOLE_PORT = 8787;
export const GUARD_WRITE_HEADER = "x-dsh-guard";
/** Guard 治理接口挂到 DSH Web 服务器上的同源前缀（面板优先走这条路径，避免跨源与额外端口）。 */
export const GUARD_WEB_PREFIX = "/guard";
/** 同源路径与路径映射表——同一份路由同时服务独立端口与 DSH 同源前缀，避免两套实现漂移。 */
const ROUTES: readonly string[] = ["/", "/index.html", "/console.js", "/api/snapshot", "/api/audit", "/api/config", "/api/revoke"];
const AUDIT_DECISIONS: readonly string[] = ["PASSTHROUGH_ALLOW", "PASSTHROUGH_DENY", "ASK", "LEASE_REUSED", "LEASE_ISSUED", "LEASE_REVOKED", "APPROVAL_REJECTED", "TOOL_SUCCESS", "TOOL_ERROR", "SANDBOX_MODE_RAISED", "SANDBOX_MODE_RESTORED", "SANDBOX_MODE_SKIPPED_USER_OVERRIDE"];
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "::1"];
/** 允许被跨源读取的来源——只放行本机页面（http://127.0.0.1:任意端口 / http://localhost:任意端口）。
 * 为什么需要：DSH Web GUI 运行在 http://127.0.0.1:<DSH 端口>，与独立 Console 端口不同源；
 * 当同源 /guard 路由不可用时（宿主未提供 webServer 或路由注册失败），面板需要跨源访问治理接口。
 * 放行范围严格限制在 loopback，且写接口另有自定义头 + JSON content-type 两道闸门（见 handleConfigPatch）。 */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
export async function startConsoleServer(options: ConsoleHttpOptions): Promise<ConsoleHttpHandle> {
  // 作用：启动 Console 服务器——host/port 配置校验（Fail Closed：port 必须为 [1, 65535] 整数
  // 或 0 表示随机端口）；listen 成功才 resolve；端口占用且 fallbackPort 为 true 时改用随机端口重试
  // （治理页面按设计可用性优先：一个查看器抢不到端口不应该让整个插件装配失败）。
  const govConsole = options.console;
  const host = options.host ?? DEFAULT_CONSOLE_HOST;
  const port = options.port ?? DEFAULT_CONSOLE_PORT;
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("GUARD_CONSOLE_INVALID: host must be a non-empty string");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("GUARD_CONSOLE_INVALID: port must be an integer in [0, 65535]");
  }
  const allowedHosts = new Set<string>([...LOOPBACK_HOSTNAMES]);
  if (host !== DEFAULT_CONSOLE_HOST) allowedHosts.add(host.toLowerCase());
  try {
    return await listen(govConsole, options, host, port, allowedHosts);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (port === 0 || options.fallbackPort === false || code !== "EADDRINUSE") throw err;
    process.stderr.write(`[dsh-guard] console port ${port} is in use; falling back to an ephemeral port\n`);
    return await listen(govConsole, options, host, 0, allowedHosts);
  }
}
function listen(govConsole: GovernanceConsole, options: ConsoleHttpOptions, host: string, port: number, allowedHosts: ReadonlySet<string>): Promise<ConsoleHttpHandle> {
  // 作用：真正监听端口——把请求交给 handleRequest，并在 listen 成功后把实际端口与访问地址一并返回
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, govConsole, options.policy, allowedHosts, "", { actions: options.actions, sweepIntervalMs: options.sweepIntervalMs });
  });
  return new Promise<ConsoleHttpHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      const displayHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        url: `http://${displayHost}:${actualPort}/`,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
async function handleRequest(req: IncomingMessage, res: ServerResponse, govConsole: GovernanceConsole, policy: GovernancePolicy | undefined, allowedHosts: ReadonlySet<string>, prefix = "", routeOptions: ConsoleRouteOptions = {}): Promise<void> {
  // 作用：请求路由——GET：/（页面）、/console.js（前端脚本）、/api/snapshot（可带 ?session=）、/api/audit、/api/config；
  // PATCH：/api/config（运行期策略）；POST：/api/revoke（收缩型治理动作）；其余方法 405、未知路径 404、异常 500
  //（不向客户端泄漏内部细节）。
  // prefix 非空表示本次请求来自 DSH Web 服务器的同源路由（/guard/…），此时 Host 检查交由 DSH 自己负责。
  try {
    // CORS 只对 loopback 来源放行（同源 /guard 路由不可用时面板需要跨源访问治理接口）；非 loopback 直接 403
    if (!applyCors(req, res)) {
      sendJson(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (prefix === "" && !isLoopbackHostHeader(req.headers.host, allowedHosts)) {
      sendJson(res, 403, { error: "HOST_NOT_ALLOWED" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://console.local");
    const pathname = normalizePath(url.pathname, prefix);
    if (pathname === undefined) {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    // 跨源预检（浏览器在带自定义头的写请求前会先发 OPTIONS）：凭证策略由上面的 applyCors 决定
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
      res.end();
      return;
    }
    // /api/revoke 只接受 POST：其他方法一律 405（不要让 GET 落到「未知路径」的 404 上，误导排障）
    if (pathname === "/api/revoke" && req.method !== "POST") {
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/index.html") {
        sendHtml(res);
        return;
      }
      if (pathname === "/console.js") {
        sendScript(res);
        return;
      }
      if (pathname === "/api/snapshot") {
        const focus = parseSnapshotQuery(url.searchParams);
        if (focus === undefined) {
          sendJson(res, 400, { error: "INVALID_QUERY" });
          return;
        }
        sendJson(res, 200, await govConsole.snapshot(focus));
        return;
      }
      if (pathname === "/api/audit") {
        const query = parseAuditQuery(url.searchParams);
        if (query === undefined) {
          sendJson(res, 400, { error: "INVALID_QUERY" });
          return;
        }
        sendJson(res, 200, govConsole.queryAudit(query));
        return;
      }
      if (pathname === "/api/config") {
        sendJson(res, 200, policyDocument(policy, routeOptions));
        return;
      }
      sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    if (req.method === "PATCH" && pathname === "/api/config") {
      await handleConfigPatch(req, res, policy);
      return;
    }
    if (req.method === "POST" && pathname === "/api/revoke") {
      await handleRevoke(req, res, routeOptions.actions);
      return;
    }
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
  } catch (err) {
    process.stderr.write(`[dsh-guard] console request failed: ${String(err)}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "CONSOLE_INTERNAL_ERROR" });
    } else {
      res.end();
    }
  }
}
function normalizePath(pathname: string, prefix: string): string | undefined {
  // 作用：把同源前缀下的路径归一到统一路由表——前缀不匹配或不在白名单内一律 undefined（404），
  // 因此 Guard 只可能响应自己声明的那几个路径，不会变成任意请求的兜底处理者
  if (prefix === "") return ROUTES.includes(pathname) ? pathname : undefined;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length) || "/";
  return ROUTES.includes(rest) ? rest : undefined;
}
/** 同源路由注册的诊断状态（只含状态与错误文本，不含任何 Secret）。
 * 为什么要有它：这条链路只在"bundle 行激活顺序 vs webServer 就绪顺序"不对时才失败，
 * 而这种失败在插件外部完全不可见（浏览器只看到 404），也无法从 stderr 取回（Desktop 进程的
 * stderr 不落盘）。把状态写进 /api/config 后，任何一次失败都能自证原因。 */
export interface GuardRouteStatus {
  /** apply() 是否调用过注册入口 */
  attempted: boolean;
  /** 宿主 ctx 是否提供 inject（cordis Context 才有） */
  hasInject: boolean;
  /** ctx.inject 是否成功登记回调 */
  injectRegistered: boolean;
  /** 回调是否被触发（= webServer 服务曾进入 active） */
  callbackFired: boolean;
  /** 回调时能否解析到 webServer 服务 */
  serviceSeen: boolean;
  /** 六个路由是否全部注册成功 */
  registered: boolean;
  /** 注册重试次数（apply 之后 webServer 才就绪时靠它补上） */
  retries: number;
  /** 失败原因（注册冲突 / inject 抛错等），成功时为 undefined */
  error?: string;
}
export const guardRouteStatus: GuardRouteStatus = {
  attempted: false,
  hasInject: false,
  injectRegistered: false,
  callbackFired: false,
  serviceSeen: false,
  registered: false,
  retries: 0,
};
/** 注册重试节奏（毫秒）——累计约 3.5 分钟，覆盖 bundle 行先于 Web 服务器就绪的启动窗口。
 * 为什么必须有重试（2026-10-15 实测）：真实启动中 webServer 既不在此插件 apply() 时可见，
 * ctx.inject 的回调在服务就绪后也没有补上（Desktop 组合下），结果 /guard 静默 404——
 * 而插件其余部分完全正常，外部只看得到 404。重试是唯一不依赖宿主内部顺序的兜底。 */
export const ROUTE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000, 60_000, 120_000];
function recordRouteError(err: unknown): void {
  // 作用：记录首个失败原因（保留第一次，后续重复失败不覆盖，便于定位根因）
  guardRouteStatus.error ??= String(err);
  process.stderr.write(`[dsh-guard] same-origin guard routes unavailable: ${String(err)}\n`);
}
/**
 * 作用：把治理接口挂到 DSH Web 服务器上（同源 /guard/…）——面板因此与页面同源，
 * 不需要跨源请求、也不依赖额外端口。
 *
 * 【注册策略：立即 + 等待，两条路都试】bundle 行的激活顺序不保证 webServer 已经就绪：
 *   ① 立即尝试一次 —— webServer 已就绪时最省事，也覆盖"宿主没有 inject"的退化情形；
 *   ② 同时用 ctx.inject(['webServer'], cb) 登记一次 —— 服务在 apply() 之后才 active 时补上。
 * 两条路都通过 guardRouteStatus / /api/config 自证，因此失败不再静默。
 */
export function registerGuardWebRoutes(hostCtx: CapsuleHostContextLike, govConsole: GovernanceConsole, policy?: GovernancePolicy, routeOptions: ConsoleRouteOptions = {}): (() => void) | undefined {
  guardRouteStatus.attempted = true;
  const inject = (hostCtx as { inject?: unknown })?.inject;
  const get = (hostCtx as { get?: unknown })?.get;
  guardRouteStatus.hasInject = typeof inject === "function";
  // 宿主既没有 get 也没有 inject：不是 cordis Context，直接放弃（调用方回落独立 Console 端口）
  if (typeof inject !== "function" && typeof get !== "function") return undefined;
  const disposers: (() => void)[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // ① 立即注册（多数情况下 webServer 已经就绪；也对没有 inject 的宿主生效）
  const immediate = registerGuardWebRoutesNow(hostCtx, govConsole, policy, routeOptions);
  if (immediate) disposers.push(immediate);
  // ② 延迟重试（最多 ROUTE_RETRY_DELAYS_MS 次）：apply() 早于 Web 服务器就绪时的兜底
  const scheduleRetry = (index: number): void => {
    if (guardRouteStatus.registered || index >= ROUTE_RETRY_DELAYS_MS.length) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (guardRouteStatus.registered) return;
      guardRouteStatus.retries += 1;
      const dispose = registerGuardWebRoutesNow(hostCtx, govConsole, policy, routeOptions);
      if (dispose) disposers.push(dispose);
      scheduleRetry(index + 1);
    }, ROUTE_RETRY_DELAYS_MS[index]);
    // 定时器不应阻止进程退出（Guard 卸载时会清理）
    (retryTimer as { unref?: () => void }).unref?.();
  };
  if (!guardRouteStatus.registered) scheduleRetry(0);
  if (typeof inject !== "function") {
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 撤销失败不影响插件卸载
        }
      }
      disposers.length = 0;
      guardRouteStatus.registered = false;
    };
  }
  // ③ 服务就绪回调（服务在 apply() 之后 active 时最及时）
  let cancelled = false;
  let injectEffect: unknown;
  try {
    injectEffect = (inject as (names: string[], callback: (serviceCtx: CapsuleHostContextLike) => void) => unknown).call(hostCtx, ["webServer"], (serviceCtx: CapsuleHostContextLike) => {
      guardRouteStatus.callbackFired = true;
      if (cancelled) return;
      if (guardRouteStatus.registered) return;
      guardRouteStatus.serviceSeen = typeof (serviceCtx as { get?: unknown })?.get === "function";
      const dispose = registerGuardWebRoutesNow(serviceCtx, govConsole, policy, routeOptions);
      if (dispose) disposers.push(dispose);
    });
    guardRouteStatus.injectRegistered = true;
  } catch (err) {
    // inject 不可用（宿主形状不同）：只保留立即注册 + 重试两条路
    recordRouteError(err);
  }
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 撤销失败不影响插件卸载
      }
    }
    disposers.length = 0;
    guardRouteStatus.registered = false;
    if (typeof injectEffect === "function") (injectEffect as () => void)();
  };
}
function registerGuardWebRoutesNow(hostCtx: CapsuleHostContextLike, govConsole: GovernanceConsole, policy?: GovernancePolicy, routeOptions: ConsoleRouteOptions = {}): (() => void) | undefined {
  // 作用：真正调用 webServer.register 注册同源前缀路由；失败时记录原因并回滚。
  //
  // 【必须方法调用而非函数引用（2026-10-15 实测缺陷）】dsh-host-webserver 的 register 是**实例方法**，
  // 内部用 `this.exact` / `this.prefixes` 两张表：
  //     register(route) { const table = route.kind === "exact" ? this.exact : this.prefixes; … }
  // 一旦写成 `const register = server.register; register(...)`，this 丢失 →
  // 抛 `TypeError: Cannot read properties of undefined (reading 'exact')`，且注册整体失败、
  // /guard 静默 404（插件其余部分完全正常）。所以这里始终保持 `server.register(...)` 的调用形态。
  //
  // 【只注册一条 prefix 路由】服务端 match() 的语义是「exact 先命中，否则在 prefix 表里取最长前缀」，
  // 且 `pathname === prefix || pathname.startsWith(prefix + "/")` 才算命中。因此一条 `/guard` 前缀
  // 同时覆盖 `/guard` 与 `/guard/**`，比原来六条 exact 更简单、也不会给同源页面的其他路径兜底
  // （非 /guard 前缀仍走 DSH 自己的 fallback）。
  const server = getHostService(hostCtx, "webServer") as { register?: unknown } | undefined;
  if (!server || typeof server.register !== "function") {
    guardRouteStatus.serviceSeen = false;
    return undefined;
  }
  guardRouteStatus.serviceSeen = true;
  const allowedHosts = new Set<string>([...LOOPBACK_HOSTNAMES]);
  try {
    const dispose = server.register({
      kind: "prefix",
      path: GUARD_WEB_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => handleRequest(req, res, govConsole, policy, allowedHosts, GUARD_WEB_PREFIX, routeOptions),
    });
    guardRouteStatus.registered = true;
    delete guardRouteStatus.error;
    process.stderr.write(`[dsh-guard] same-origin guard routes ready at ${GUARD_WEB_PREFIX}/\n`);
    return () => {
      if (typeof dispose === "function") (dispose as () => void)();
    };
  } catch (err) {
    recordRouteError(err);
    return undefined;
  }
}
export interface CapsuleHostContextLike {
  get?(name: string): unknown;
  /** cordis 的依赖注册入口：服务可用（或重新可用）时回调，返回的 effect 随宿主卸载撤销 */
  inject?(names: string[], callback: (serviceCtx: CapsuleHostContextLike) => void): unknown;
}
/** 同源路由的可选能力（未注入时对应接口按「不可用」处理，前端据此隐藏按钮） */
export interface ConsoleRouteOptions {
  actions?: ConsoleActions;
  sweepIntervalMs?: number;
}
function getHostService(hostCtx: CapsuleHostContextLike, name: string): unknown {
  // 作用：按 cordis 方式解析宿主服务（只走 ctx.get，缺失返回 undefined，绝不抛错）
  const get = hostCtx?.get;
  if (typeof get !== "function") return undefined;
  try {
    return get.call(hostCtx, name);
  } catch {
    return undefined;
  }
}
async function handleConfigPatch(req: IncomingMessage, res: ServerResponse, policy: GovernancePolicy | undefined): Promise<void> {
  // 作用：运行期策略写接口——三重闸门：① 自定义头（强制跨源预检，CSRF 防护）；
  // ② content-type 必须是 application/json；③ 策略源必须注入。任一不满足即拒绝。
  if (!policy) {
    sendJson(res, 503, { error: "POLICY_READONLY" });
    return;
  }
  if (req.headers[GUARD_WRITE_HEADER] === undefined) {
    sendJson(res, 403, { error: "WRITE_HEADER_REQUIRED" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "JSON_CONTENT_TYPE_REQUIRED" });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "INVALID_JSON" });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: "INVALID_BODY" });
    return;
  }
  const patch = body as { defaultScope?: unknown; defaultTtlSeconds?: unknown; maxTtlSeconds?: unknown };
  const allowedKeys = new Set(["defaultScope", "defaultTtlSeconds", "maxTtlSeconds"]);
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) {
      // 明确拒绝 enabled / rules 等部署配置项：治理页面无权开关 Guard，也无权新增授权规则
      sendJson(res, 400, { error: "IMMUTABLE_FIELD", field: key });
      return;
    }
  }
  if (patch.defaultScope !== undefined) {
    if (!isScopeMode(patch.defaultScope) || !DEFAULTABLE_SCOPE_MODES.includes(patch.defaultScope)) {
      sendJson(res, 400, { error: "SCOPE_MODE_NOT_DEFAULTABLE", allowed: [...DEFAULTABLE_SCOPE_MODES] });
      return;
    }
  }
  if (patch.defaultTtlSeconds !== undefined && !Number.isInteger(patch.defaultTtlSeconds)) {
    sendJson(res, 400, { error: "INVALID_TTL" });
    return;
  }
  if (patch.maxTtlSeconds !== undefined && !Number.isInteger(patch.maxTtlSeconds)) {
    sendJson(res, 400, { error: "INVALID_TTL" });
    return;
  }
  try {
    const snapshot = await policy.update({
      defaultScope: patch.defaultScope as ScopeMode | undefined,
      defaultTtlSeconds: patch.defaultTtlSeconds as number | undefined,
      maxTtlSeconds: patch.maxTtlSeconds as number | undefined,
    });
    sendJson(res, 200, { policy: snapshot, modes: modeCatalog() });
  } catch (err) {
    // 校验失败：Fail Closed，本次变更整体不生效（不做部分应用）
    sendJson(res, 409, { error: "POLICY_REJECTED", message: err instanceof Error ? err.message : String(err) });
  }
}
function policyDocument(policy: GovernancePolicy | undefined, routeOptions: ConsoleRouteOptions = {}): unknown {
  // 作用：GET /api/config 的响应——运行期策略（可写）+ 挡位目录（前后端同一事实来源）+
  // 说明「哪些项属于部署配置、只能改 profile patch」+ 同源路由注册状态（链路自证）+
  // 收缩型动作是否可用（前端据此决定是否渲染「立即收回 / 回滚档位」按钮）+
  // 档位自动回滚节拍（前端据此在「到期后」一句里写清多久内会回滚）。
  const routes = { ...guardRouteStatus };
  const actions = { revoke: routeOptions.actions !== undefined, restoreSandbox: routeOptions.actions !== undefined };
  const sweep = { intervalMs: routeOptions.sweepIntervalMs ?? 0 };
  if (!policy) {
    return { policy: undefined, modes: modeCatalog(), writable: [], immutable: ["enabled", "rules"], routes, actions, sweep };
  }
  return { policy: policy.snapshot(), modes: modeCatalog(), writable: ["defaultScope", "defaultTtlSeconds", "maxTtlSeconds"], immutable: ["enabled", "rules"], routes, actions, sweep };
}
function modeCatalog(): unknown {
  // 作用：挡位目录投影——供前端渲染下拉框；defaultable 标记哪些挡位允许作为默认值（tool 不允许）
  return SCOPE_MODES.map((mode) => ({
    id: mode.id,
    label: mode.label,
    summary: mode.summary,
    risk: mode.risk,
    defaultable: DEFAULTABLE_SCOPE_MODES.includes(mode.id),
    defaultPaths: mode.defaultPaths ?? null,
  }));
}
function isLoopbackHostHeader(header: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  // 作用：Host 头校验（DNS rebinding 防护）——只接受 loopback 主机名/地址（可带端口）；
  // 缺失 Host 头同样拒绝（HTTP/1.1 必须带 Host，缺失即异常请求）
  if (typeof header !== "string" || header.length === 0) return false;
  let hostname = header.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    if (end < 0) return false;
    hostname = hostname.slice(0, end + 1);
  } else {
    const colon = hostname.lastIndexOf(":");
    if (colon >= 0) hostname = hostname.slice(0, colon);
  }
  return allowedHosts.has(hostname);
}
function readBody(req: IncomingMessage, limitBytes = 8192): Promise<Buffer> {
  // 作用：读取请求体（带上限，防止超大请求占用内存）；超限直接以空体结束并交给上层按非法 JSON 处理
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error("GUARD_CONSOLE_INVALID: request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function parseSnapshotQuery(params: URLSearchParams): { sessionId?: string } | undefined {
  // 作用：解析快照查询参数——只接受可选的 session（聚焦会话）；空串视为未指定；
  // 超长值直接拒绝（避免把任意大字符串带进视图层）
  const sessionId = params.get("session");
  if (sessionId === null || sessionId.length === 0) return {};
  if (sessionId.length > 200) return undefined;
  return { sessionId };
}
export interface RevokeRequestBody {
  sessionId: string;
  /** revoke = 撤销该会话全部授权并回滚档位（默认）；restore-sandbox = 只回收已失效授权的档位 */
  action?: "revoke" | "restore-sandbox";
}
export function parseRevokeBody(raw: unknown): RevokeRequestBody | undefined {
  // 作用：解析并校验治理动作请求体——只认识 sessionId 与 action 两个字段，
  // 其余字段一律拒绝（Fail Closed：不猜测调用方意图，也不做任何隐式扩权）
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "sessionId" && key !== "action") return undefined;
  }
  const sessionId = record.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) return undefined;
  const action = record.action;
  if (action === undefined) return { sessionId };
  if (action !== "revoke" && action !== "restore-sandbox") return undefined;
  return { sessionId, action };
}
async function handleRevoke(req: IncomingMessage, res: ServerResponse, actions: ConsoleActions | undefined): Promise<void> {
  // 作用：收缩型治理动作入口（POST /api/revoke）——与 PATCH /api/config 同一套三道闸门：
  // ① 自定义头（强制跨源预检，CSRF 防护）；② content-type 必须是 application/json；③ 动作源必须注入。
  // 动作本身只会让权限变小，没有任何签发 / 放宽路径。
  if (!actions) {
    sendJson(res, 503, { error: "ACTIONS_UNAVAILABLE" });
    return;
  }
  if (req.headers[GUARD_WRITE_HEADER] === undefined) {
    sendJson(res, 403, { error: "WRITE_HEADER_REQUIRED" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "JSON_CONTENT_TYPE_REQUIRED" });
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "INVALID_JSON" });
    return;
  }
  const body = parseRevokeBody(raw);
  if (!body) {
    sendJson(res, 400, { error: "INVALID_BODY" });
    return;
  }
  try {
    if (body.action === "restore-sandbox") {
      const result = await actions.restoreSandbox(body.sessionId);
      sendJson(res, 200, { ok: true, action: "restore-sandbox", ...result });
      return;
    }
    const result = await actions.revokeSession(body.sessionId);
    sendJson(res, 200, { ok: true, action: "revoke", ...result });
  } catch (err) {
    // 动作失败：Fail Closed（不重试、不部分应用），错误细节只写 stderr
    process.stderr.write(`[dsh-guard] console action failed: ${String(err)}\n`);
    sendJson(res, 500, { error: "ACTION_FAILED" });
  }
}
function parseAuditQuery(params: URLSearchParams): ConsoleAuditQuery | undefined {
  // 作用：解析审计查询参数——sessionId/toolName/decision 精确匹配、limit 正整数；
  // decision 必须为合法枚举、limit 必须为正整数，任何非法值返回 undefined（上层回 400）
  const query: ConsoleAuditQuery = {};
  const sessionId = params.get("sessionId");
  const toolName = params.get("toolName");
  const decision = params.get("decision");
  const limit = params.get("limit");
  if (sessionId) query.sessionId = sessionId;
  if (toolName) query.toolName = toolName;
  if (decision) {
    if (!AUDIT_DECISIONS.includes(decision)) return undefined;
    query.decision = decision as AuditDecision;
  }
  if (limit) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    query.limit = parsed;
  }
  return query;
}
function isLoopbackOrigin(origin: unknown): boolean {
  // 作用：来源白名单判定——只接受本机 http 来源；缺失 Origin（同源请求 / 非浏览器客户端）不视为跨源
  if (typeof origin !== "string" || origin.length === 0) return false;
  return LOOPBACK_ORIGIN_PATTERN.test(origin);
}
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  // 作用：为 loopback 来源写入 CORS 响应头；返回 false 表示来源不被允许（调用方回 403）。
  // 不返回通配符 `*`：只回显被验证过的具体来源，避免任何非本机页面读取治理数据。
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  if (!isLoopbackOrigin(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, PATCH, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-dsh-guard");
  res.setHeader("access-control-max-age", "600");
  return true;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 作用：发送 JSON 响应——统一 no-store + nosniff + 严格 CSP（JSON 端点 default-src 'none'）
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(payload);
}
function sendHtml(res: ServerResponse): void {
  // 作用：发送 Console 页面外壳——CSP 允许同源脚本/样式与同源 fetch，禁其余一切外部资源
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(CONSOLE_HTML);
}
function sendScript(res: ServerResponse): void {
  // 作用：发送共享的 Console 前端脚本（DSH 面板与独立页面使用同一份渲染逻辑，避免两套视图漂移）
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(CONSOLE_CLIENT_JS);
}
export type { ConsolePolicySnapshot };
