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
import type { ConsoleAuditQuery } from "./types.js";
export interface ConsoleHttpOptions {
  console: GovernanceConsole;
  /** 运行期治理策略（挡位 / TTL）；未注入时写接口一律拒绝（Fail Closed） */
  policy?: GovernancePolicy;
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
const ROUTES: readonly string[] = ["/", "/index.html", "/console.js", "/api/snapshot", "/api/audit", "/api/config"];
const AUDIT_DECISIONS: readonly string[] = ["PASSTHROUGH_ALLOW", "PASSTHROUGH_DENY", "ASK", "LEASE_REUSED", "LEASE_ISSUED", "APPROVAL_REJECTED", "TOOL_SUCCESS", "TOOL_ERROR", "SANDBOX_MODE_RAISED", "SANDBOX_MODE_RESTORED", "SANDBOX_MODE_SKIPPED_USER_OVERRIDE"];
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
    void handleRequest(req, res, govConsole, options.policy, allowedHosts);
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
async function handleRequest(req: IncomingMessage, res: ServerResponse, govConsole: GovernanceConsole, policy: GovernancePolicy | undefined, allowedHosts: ReadonlySet<string>, prefix = ""): Promise<void> {
  // 作用：请求路由——GET：/（页面）、/console.js（前端脚本）、/api/snapshot、/api/audit、/api/config；
  // PATCH：/api/config（运行期策略）；其余方法 405、未知路径 404、异常 500（不向客户端泄漏内部细节）。
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
        sendJson(res, 200, await govConsole.snapshot());
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
        sendJson(res, 200, policyDocument(policy));
        return;
      }
      sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    if (req.method === "PATCH" && pathname === "/api/config") {
      await handleConfigPatch(req, res, policy);
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
/**
 * 作用：把治理接口挂到 DSH Web 服务器上（同源 /guard/…）——面板因此与页面同源，
 * 不需要跨源请求、也不依赖额外端口。
 *
 * 【为什么用 ctx.inject 而不是直接 ctx.get】bundle 行的激活顺序不保证 webServer 已经就绪，
 * 直接解析可能拿到 undefined（此时若只回落独立端口，同源入口就会静默缺失）。ctx.inject 会在
 * 服务真正可用（或重新可用）时回调，因此路由注册与服务生命周期对齐，并在服务消失时自动撤销。
 * 宿主没有 webServer（headless 等组合）时回调永不触发，等于零副作用。
 */
export function registerGuardWebRoutes(hostCtx: CapsuleHostContextLike, govConsole: GovernanceConsole, policy?: GovernancePolicy): (() => void) | undefined {
  const inject = (hostCtx as { inject?: unknown })?.inject;
  const get = (hostCtx as { get?: unknown })?.get;
  // 宿主既没有 get 也没有 inject：不是 cordis Context，直接放弃（调用方回落独立 Console 端口）
  if (typeof inject !== "function" && typeof get !== "function") return undefined;
  if (typeof inject !== "function") return registerGuardWebRoutesNow(hostCtx, govConsole, policy) ?? (() => undefined);
  let activeDispose: (() => void) | undefined;
  let cancelled = false;
  let injectEffect: unknown;
  try {
    injectEffect = (inject as (names: string[], callback: (serviceCtx: CapsuleHostContextLike) => void) => unknown).call(hostCtx, ["webServer"], (serviceCtx: CapsuleHostContextLike) => {
      if (cancelled) return;
      activeDispose = registerGuardWebRoutesNow(serviceCtx, govConsole, policy);
    });
  } catch (err) {
    // inject 不可用（宿主形状不同）：退回立即注册一次，仍失败就完全跳过（不影响独立 Console 端口）
    process.stderr.write(`[dsh-guard] ctx.inject unavailable for webServer: ${String(err)}\n`);
    return registerGuardWebRoutesNow(hostCtx, govConsole, policy) ?? (() => undefined);
  }
  return () => {
    cancelled = true;
    if (activeDispose) {
      activeDispose();
      activeDispose = undefined;
    }
    if (typeof injectEffect === "function") (injectEffect as () => void)();
  };
}
function registerGuardWebRoutesNow(hostCtx: CapsuleHostContextLike, govConsole: GovernanceConsole, policy?: GovernancePolicy): (() => void) | undefined {
  const server = getHostService(hostCtx, "webServer") as { register?: unknown } | undefined;
  if (!server || typeof server.register !== "function") return undefined;
  const register = server.register as (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => unknown;
  const allowedHosts = new Set<string>([...LOOPBACK_HOSTNAMES]);
  const disposers: unknown[] = [];
  try {
    for (const path of ROUTES) {
      disposers.push(
        register({
          kind: "exact",
          path: `${GUARD_WEB_PREFIX}${path === "/" ? "" : path}`,
          handler: (req, res) => handleRequest(req, res, govConsole, policy, allowedHosts, GUARD_WEB_PREFIX),
        }),
      );
    }
  } catch (err) {
    // 注册失败（路径冲突 / 宿主未就绪）：回滚已注册的路由，返回 undefined 由调用方回落独立端口
    for (const disposer of disposers) {
      if (typeof disposer === "function") (disposer as () => void)();
    }
    process.stderr.write(`[dsh-guard] same-origin guard routes unavailable: ${String(err)}\n`);
    return undefined;
  }
  process.stderr.write(`[dsh-guard] same-origin guard routes ready at ${GUARD_WEB_PREFIX}/\n`);
  return () => {
    for (const disposer of disposers) {
      if (typeof disposer === "function") (disposer as () => void)();
    }
  };
}
export interface CapsuleHostContextLike {
  get?(name: string): unknown;
  /** cordis 的依赖注册入口：服务可用（或重新可用）时回调，返回的 effect 随宿主卸载撤销 */
  inject?(names: string[], callback: (serviceCtx: CapsuleHostContextLike) => void): unknown;
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
function policyDocument(policy: GovernancePolicy | undefined): unknown {
  // 作用：GET /api/config 的响应——运行期策略（可写）+ 挡位目录（前后端同一事实来源）+
  // 说明「哪些项属于部署配置、只能改 profile patch」，避免用户在页面上找不到开关
  if (!policy) {
    return { policy: undefined, modes: modeCatalog(), writable: [], immutable: ["enabled", "rules"] };
  }
  return { policy: policy.snapshot(), modes: modeCatalog(), writable: ["defaultScope", "defaultTtlSeconds", "maxTtlSeconds"], immutable: ["enabled", "rules"] };
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
