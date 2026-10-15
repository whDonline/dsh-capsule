import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AuditService } from "../audit/audit-service.js";
import type { AuditDecision, ToolAuditEvent } from "../audit/types.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { apply, resolveConsoleConfig, type CapsuleHostContext, type DisposeHook } from "../index.js";
import { CapabilityService } from "../service/capability-service.js";
import { PolicyResolver } from "../capability/policy.js";
import { GovernanceConsole } from "./console-service.js";
import { CONSOLE_CLIENT_JS } from "./console-ui.js";
import { DEFAULT_CONSOLE_PORT, registerGuardWebRoutes, startConsoleServer, type CapsuleHostContextLike, type ConsoleHttpHandle } from "./http-server.js";
import { GovernancePolicy } from "./policy.js";
import type { ConsoleProviderSource } from "./types.js";
// 作用：测试用 Provider 白名单投影源——与真实 ProviderRegistry.list() 的投影形状一致，
// credentialRef 是 resolve 引用名而非 Secret（规格 11.3）
const fakeProviders: ConsoleProviderSource = {
  list: () => [{ id: "github", credentialRef: "github-token", allowedActions: ["issues.read", "issues.create"] }],
};
function makeCapabilities(leases: LeaseManager): CapabilityService {
  // 作用：构造注册了一条 managed 定义的 CapabilityService——resource 函数确定性返回，供投影断言
  const service = new CapabilityService(new Context(), { leases, defaultTtlSeconds: 60, maxTtlSeconds: 1800 });
  service.register({ toolName: "github.create_issue", provider: "github", action: "issues.create", resource: () => "repo:o/r", ttlSeconds: 300 });
  return service;
}
function recordEvent(audit: AuditService, event: { callId: string; toolName: string; decision: AuditDecision; sessionId?: string; leaseId?: string }): ToolAuditEvent {
  // 作用：写入一条最简形状的审计事件（rootCallId 缺省与 callId 相同）
  return audit.record({ rootCallId: event.callId, ...event });
}
function rawGet(port: number, path: string, hostHeader: string): Promise<number> {
  // 作用：绕过 WHATWG fetch 的 Host 头限制，显式以给定 Host 头发起 GET，返回状态码
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: hostHeader } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
function makePolicyForRoutes(): GovernancePolicy {
  // 作用：同源路由测试用的最小策略源
  return new GovernancePolicy({ initial: { defaultScope: "exact-arguments", defaultTtlSeconds: 60, maxTtlSeconds: 1800 } });
}
function callRoute(
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>,
  path: string,
): Promise<{ status: number; body: string }> {
  // 作用：直接以最小 req/res 替身调用已注册的同源 handler（不启动真实 HTTP 服务器）
  // 作用：真实 Web 服务器按最长前缀匹配把 /guard/** 交给已注册的某个 exact 路由；这里用
  // /guard/api/snapshot 的 handler 代表该前缀下的入口，再由 handler 内部按路径白名单决定 200/404。
  const pathname = path.split("?")[0];
  const handler = routes.get(pathname) ?? routes.get("/guard/api/snapshot");
  if (!handler) return Promise.resolve({ status: 0, body: "" });
  return new Promise((resolve) => {
    const req = { url: path, method: "GET", headers: { host: "127.0.0.1:19387" } } as unknown as IncomingMessage;
    const res = {
      headersSent: false,
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
      end(body?: string) {
        resolve({ status: this.statusCode, body: body ?? "" });
      },
    } as unknown as ServerResponse;
    void handler(req, res);
  });
}
interface ConsoleFixture {
  gov: GovernanceConsole;
  audit: AuditService;
  leases: LeaseManager;
  capabilities: CapabilityService;
  advance: (ms: number) => void;
}
async function makeConsole(): Promise<ConsoleFixture> {
  // 作用：构造可注入假时钟的完整 Console 依赖——audit 填一条调用链（ASK→LEASE_ISSUED→TOOL_SUCCESS）
  // + 一次复用 + 一次透传 deny；leases 签发一条 60s 的 ACTIVE Lease
  let now = 10_000;
  const audit = new AuditService();
  const leases = new LeaseManager(new MemoryLeaseStore(), () => now);
  const capabilities = makeCapabilities(leases);
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "ASK", sessionId: "sess-1" });
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "LEASE_ISSUED", sessionId: "sess-1", leaseId: "lease-1" });
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "TOOL_SUCCESS", sessionId: "sess-1" });
  recordEvent(audit, { callId: "call-2", toolName: "github.create_issue", decision: "LEASE_REUSED", sessionId: "sess-1", leaseId: "lease-1" });
  recordEvent(audit, { callId: "call-3", toolName: "fs.write", decision: "PASSTHROUGH_DENY" });
  await leases.issue({ sessionId: "sess-1", toolName: "github.create_issue", scope: { kind: "exact-arguments", key: "hash-1", display: "tool=github.create_issue args=<sha256>" }, ttlSeconds: 60 });
  return { gov: new GovernanceConsole({ audit, leases, capabilities, providers: fakeProviders, now: () => now }), audit, leases, capabilities, advance: (ms) => { now += ms; } };
}
async function makeGov(): Promise<GovernanceConsole> {
  // 作用：仅取聚合实例（HTTP 只读查询用）
  return (await makeConsole()).gov;
}
describe("GovernanceConsole 聚合（规格第 24 节 Phase 4）", () => {
  it("snapshot 聚合五维视图：summary 计数、plugins 白名单投影、capabilities 投影、activity 最新在前", async () => {
    const { gov } = await makeConsole();
    const snap = await gov.snapshot();
    expect(snap.guardName).toBe("dsh-capability-guard");
    expect(snap.summary).toMatchObject({ leasesTotal: 1, leasesActive: 1, leasesRevoked: 0, leasesExpired: 0, managedCapabilities: 1, providers: 1, auditedEvents: 5 });
    expect(snap.plugins).toEqual([
      { id: "dsh-capability-guard", kind: "guard" },
      { id: "github", kind: "provider", credentialRef: "github-token", allowedActions: ["issues.read", "issues.create"] },
    ]);
    expect(snap.capabilities).toEqual([{ toolName: "github.create_issue", provider: "github", action: "issues.create", ttlSeconds: 300 }]);
    expect(snap.activity.map((event) => event.decision)).toEqual(["PASSTHROUGH_DENY", "LEASE_REUSED", "TOOL_SUCCESS", "LEASE_ISSUED", "ASK"]);
  });
  it("activityLimit 截断最近活动，非法值构造 Fail Closed 抛错", async () => {
    let now = 10_000;
    const audit = new AuditService();
    const leases = new LeaseManager(new MemoryLeaseStore(), () => now);
    for (let i = 0; i < 8; i += 1) {
      recordEvent(audit, { callId: `call-${i}`, toolName: "t", decision: "ASK" });
    }
    const gov = new GovernanceConsole({ audit, leases, capabilities: { listCapabilities: () => [] }, providers: { list: () => [] }, activityLimit: 3, now: () => now });
    const snap = await gov.snapshot();
    expect(snap.activity).toHaveLength(3);
    expect(snap.activity[0].callId).toBe("call-7");
    expect(() => new GovernanceConsole({ audit, leases, capabilities: { listCapabilities: () => [] }, providers: { list: () => [] }, activityLimit: 0 })).toThrow(/GUARD_CONSOLE_INVALID/);
  });
  it("Tool 统计按 callId 去重：调用链多事件只计 1 次 invocations，各决策计数正确", async () => {
    const { gov } = await makeConsole();
    const snap = await gov.snapshot();
    const tool = snap.tools.find((stat) => stat.toolName === "github.create_issue");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ invocations: 2, ask: 1, leaseIssued: 1, leaseReused: 1, approvalRejected: 0, passthroughAllow: 0, passthroughDeny: 0, toolSuccess: 1, toolError: 0 });
    const fs = snap.tools.find((stat) => stat.toolName === "fs.write");
    expect(fs).toMatchObject({ invocations: 1, passthroughDeny: 1 });
    expect(tool?.lastActivityAt).toBeGreaterThan(0);
  });
  it("Lease 视图实时投影：剩余毫秒正确，已过期未标记的 ACTIVE 在视图层修正为 EXPIRED", async () => {
    const { gov, leases, advance } = await makeConsole();
    const scope = { kind: "exact-arguments" as const, key: "hash-2", display: "d2" };
    const revocable = await leases.issue({ sessionId: "sess-2", toolName: "t2", scope, ttlSeconds: 60 });
    await leases.revoke(revocable.id, "manual");
    await leases.issue({ sessionId: "sess-3", toolName: "t3", scope, ttlSeconds: 10 });
    advance(20_000);
    const snap = await gov.snapshot();
    const views = new Map(snap.leases.map((lease) => [lease.id, lease]));
    expect(views.get(revocable.id)).toMatchObject({ status: "REVOKED", revokeReason: "manual" });
    const active = snap.leases.find((lease) => lease.status === "ACTIVE");
    expect(active?.remainingMs).toBe(40_000);
    const expired = snap.leases.find((lease) => lease.sessionId === "sess-3");
    expect(expired).toMatchObject({ status: "EXPIRED", remainingMs: 0 });
    expect(snap.summary.leasesTotal).toBe(3);
  });
  it("queryAudit 按 sessionId/toolName/decision 过滤（最新在前）并支持 limit；非法 limit Fail Closed", async () => {
    const { gov } = await makeConsole();
    expect(gov.queryAudit({ toolName: "github.create_issue" })).toHaveLength(4);
    expect(gov.queryAudit({ sessionId: "sess-1", decision: "TOOL_SUCCESS" }).map((event) => event.callId)).toEqual(["call-1"]);
    expect(gov.queryAudit({ limit: 2 }).map((event) => event.decision)).toEqual(["PASSTHROUGH_DENY", "LEASE_REUSED"]);
    expect(() => gov.queryAudit({ limit: 0 })).toThrow(/GUARD_CONSOLE_INVALID/);
    expect(gov.queryAudit({})).toHaveLength(5);
  });
  it("CapabilityService.listCapabilities 返回安全投影：不含 resource 函数字段", () => {
    const leases = new LeaseManager(new MemoryLeaseStore());
    const capabilities = makeCapabilities(leases);
    const list = capabilities.listCapabilities();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["action", "provider", "toolName", "ttlSeconds"]);
  });
});
describe("HTTP 只读查看器（规格 Phase 4）", () => {
  it("GET /api/snapshot 返回快照 JSON 与安全响应头", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const res = await fetch(`${handle.url}api/snapshot`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await res.json()) as { summary: Record<string, number> };
      expect(body.summary.auditedEvents).toBe(5);
    } finally {
      await handle.close();
    }
  });
  it("GET /api/audit 支持 toolName/decision/limit 过滤，非法 decision/limit 返回 400", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const filtered = await (await fetch(`${handle.url}api/audit?toolName=github.create_issue&decision=TOOL_SUCCESS&limit=5`)).json();
      expect(filtered).toHaveLength(1);
      const invalidDecision = await fetch(`${handle.url}api/audit?decision=NOT_A_DECISION`);
      expect(invalidDecision.status).toBe(400);
      const invalidLimit = await fetch(`${handle.url}api/audit?limit=abc`);
      expect(invalidLimit.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
  it("非 GET 一律 405，未知路径 404（只读 Fail Closed）", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const post = await fetch(`${handle.url}api/snapshot`, { method: "POST" });
      expect(post.status).toBe(405);
      const unknown = await fetch(`${handle.url}api/revoke`);
      expect(unknown.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
  it("GET / 返回内嵌 HTML 页面（含标题与 CSP）", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const res = await fetch(handle.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const html = await res.text();
      expect(html).toContain("DSH Capability Guard Console");
    } finally {
      await handle.close();
    }
  });
  it("close() 后端口释放，连接被拒绝；非法 host/port Fail Closed 抛错", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    await handle.close();
    await expect(fetch(handle.url)).rejects.toThrow();
    await expect(startConsoleServer({ console: await makeGov(), port: 99999 })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    await expect(startConsoleServer({ console: await makeGov(), host: "" })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
  });
  it("端口被占用时回退到随机端口（治理页面可用性优先，不阻断插件装配）", async () => {
    const first = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const second = await startConsoleServer({ console: await makeGov(), port: first.port });
      try {
        expect(second.port).not.toBe(first.port);
        expect((await fetch(`${second.url}api/snapshot`)).status).toBe(200);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
  it("Host 头非 loopback 一律 403（DNS rebinding 防护）", async () => {
    // 说明：WHATWG fetch 禁止覆写 Host 头，因此这里用 node:http 原生请求显式发送恶意 Host
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const status = await rawGet(handle.port, "/api/snapshot", "evil.example.com");
      expect(status).toBe(403);
      const okStatus = await rawGet(handle.port, "/api/snapshot", "127.0.0.1");
      expect(okStatus).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
describe("治理策略写接口（默认范围挡位与 TTL）", () => {
  function makePolicy(): GovernancePolicy {
    return new GovernancePolicy({ initial: { defaultScope: "exact-arguments", defaultTtlSeconds: 60, maxTtlSeconds: 1800 } });
  }
  function patch(handle: ConsoleHttpHandle, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${handle.url}api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-dsh-guard": "1", ...headers },
      body: JSON.stringify(body),
    });
  }
  it("GovernancePolicy：挡位/TTL 校验 Fail Closed，变更递增 revision 且不做部分应用", async () => {
    const policy = makePolicy();
    expect(policy.snapshot().revision).toBe(1);
    const updated = await policy.update({ defaultScope: "sandbox-escalation", defaultTtlSeconds: 300 });
    expect(updated.defaultScope).toBe("sandbox-escalation");
    expect(updated.defaultTtlSeconds).toBe(300);
    expect(updated.revision).toBe(2);
    // 未知挡位 / 非法 TTL / default>max 一律拒绝，且状态保持不变（整体拒绝，不部分生效）
    await expect(policy.update({ defaultScope: "whatever" as never })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    await expect(policy.update({ defaultTtlSeconds: 0 })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    await expect(policy.update({ defaultTtlSeconds: 3600 })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    expect(policy.snapshot()).toMatchObject({ defaultScope: "sandbox-escalation", defaultTtlSeconds: 300, revision: 2 });
  });
  it("挡位切换即时影响 PolicyResolver 解析结果（无需重启，且不放大已签发授权）", () => {
    const policy = makePolicy();
    const resolver = new PolicyResolver(() => policy.config);
    expect(resolver.resolve("pwsh").scope).toEqual({ mode: "exact-arguments" });
    void policy.update({ defaultScope: "tool" });
    expect(resolver.resolve("pwsh").scope).toEqual({ mode: "tool" });
  });
  it("PATCH 生效并返回挡位目录；缺少自定义头 / 非 JSON / 未知字段 / 不可默认挡位全部拒绝", async () => {
    const policy = makePolicy();
    const handle = await startConsoleServer({ console: await makeGov(), policy, port: 0 });
    try {
      const ok = await patch(handle, { defaultScope: "sandbox-escalation" });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { policy: { defaultScope: string }; modes: { id: string; defaultable: boolean }[] };
      expect(body.policy.defaultScope).toBe("sandbox-escalation");
      expect(body.modes.find((mode) => mode.id === "tool")?.defaultable).toBe(false);
      // CSRF 防护：缺少自定义头 → 403
      const noHeader = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
      expect(noHeader.status).toBe(403);
      // 非 JSON content-type → 415
      const badType = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: { "x-dsh-guard": "1", "content-type": "text/plain" }, body: "{}" });
      expect(badType.status).toBe(415);
      // 部署配置字段不可改 → 400
      expect((await patch(handle, { enabled: false })).status).toBe(400);
      expect((await patch(handle, { rules: [] })).status).toBe(400);
      // tool 挡位禁止作为默认值（规格第 7 条）→ 400
      expect((await patch(handle, { defaultScope: "tool" })).status).toBe(400);
      // 非法值 → 409（策略层 Fail Closed）
      expect((await patch(handle, { defaultTtlSeconds: 99999 })).status).toBe(409);
      // 未做任何成功变更之外的状态改动
      expect(policy.snapshot().defaultScope).toBe("sandbox-escalation");
    } finally {
      await handle.close();
    }
  });
  it("GET /api/config 暴露运行期策略与不可写字段说明；未注入策略源时写接口 503", async () => {
    const policy = makePolicy();
    const handle = await startConsoleServer({ console: await makeGov(), policy, port: 0 });
    try {
      const body = (await (await fetch(`${handle.url}api/config`)).json()) as { writable: string[]; immutable: string[]; policy: { defaultScope: string } };
      expect(body.policy.defaultScope).toBe("exact-arguments");
      expect(body.writable).toContain("defaultScope");
      expect(body.immutable).toEqual(["enabled", "rules"]);
      expect((await fetch(`${handle.url}console.js`)).status).toBe(200);
    } finally {
      await handle.close();
    }
    const readOnly = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const res = await fetch(`${readOnly.url}api/config`, { method: "PATCH", headers: { "content-type": "application/json", "x-dsh-guard": "1" }, body: "{}" });
      expect(res.status).toBe(503);
    } finally {
      await readOnly.close();
    }
  });
});
describe("治理面板前端资源（浏览器可直接打开，也被 DSH 面板复用）", () => {
  it("CONSOLE_CLIENT_JS 是语法合法的 UMD 脚本，且不触碰 document.body", () => {
    // 作用：前端脚本只在真实浏览器里执行，Node 测试无法渲染；这里用 new Function 做语法校验
    // （语法错误会让整个面板在 DSH 里静默不渲染），并断言不写 DOM 到面板容器之外。
    expect(() => new Function(CONSOLE_CLIENT_JS)).not.toThrow();
    expect(CONSOLE_CLIENT_JS).toContain("DshGuardConsole");
    expect(CONSOLE_CLIENT_JS).not.toContain("document.body");
  });
  it("GET /console.js 返回可执行脚本，GET / 的内嵌页面引用同一份脚本（避免两套视图漂移）", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const script = await fetch(`${handle.url}console.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("javascript");
      const body = await script.text();
      expect(body).toBe(CONSOLE_CLIENT_JS);
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain("/console.js");
      expect(html).toContain("DshGuardConsole.mount");
    } finally {
      await handle.close();
    }
  });
  it("静态资源可被页面内联脚本按 CSP 加载：script-src 'self' 且不放开 connect-src", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const csp = (await fetch(handle.url)).headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("default-src 'none'");
    } finally {
      await handle.close();
    }
  });
});
describe("同源路由（挂到 DSH Web 服务器的 /guard/…）", () => {
  function makeFakeWebServer(): { routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>; host: CapsuleHostContextLike } {
    // 作用：模拟 DSH 的 ctx.webServer——只保留 register(route)，用一个 Map 记录路径到 handler
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
    return {
      routes,
      host: {
        get: (name: string) =>
          name === "webServer"
            ? {
                register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
                  routes.set(route.path, route.handler);
                  return () => routes.delete(route.path);
                },
              }
            : undefined,
      },
    };
  }
  it("注册 /guard/ 下的全部治理路径；前缀外的路径不响应（404，不做兜底）", async () => {
    const { routes, host } = makeFakeWebServer();
    const dispose = registerGuardWebRoutes(host, await makeGov(), makePolicyForRoutes());
    expect(dispose).toBeTypeOf("function");
    expect([...routes.keys()].sort()).toEqual(["/guard", "/guard/api/audit", "/guard/api/config", "/guard/api/snapshot", "/guard/console.js", "/guard/index.html"]);
    const snapshot = await callRoute(routes, "/guard/api/snapshot");
    expect(snapshot.status).toBe(200);
    expect(JSON.parse(snapshot.body)).toHaveProperty("summary");
    const outside = await callRoute(routes, "/guard/api/secret");
    expect(outside.status).toBe(404);
    const unknown = await callRoute(routes, "/other/api/snapshot");
    expect(unknown.status).toBe(404);
    dispose?.();
    expect(routes.size).toBe(0);
  });
  it("宿主没有 webServer 时返回 undefined（调用方回落独立端口，不抛错）", () => {
    expect(registerGuardWebRoutes({ get: () => undefined }, {} as unknown as GovernanceConsole)).toBeUndefined();
    expect(registerGuardWebRoutes({}, {} as unknown as GovernanceConsole)).toBeUndefined();
  });
});
describe("插件装配（index.ts apply + console 配置）", () => {
  it("console.enabled 启动只读查看器，dispose 后端口释放且 capabilities 服务仍可解析", async () => {
    const ctx = new Context() as unknown as CapsuleHostContext & { get(name: string): unknown };
    (ctx as { on?: unknown }).on = () => () => undefined;
    const dispose: DisposeHook = await apply(ctx, { console: { enabled: true, port: 0 } });
    expect(typeof ctx.get("capabilities")).toBe("object");
    await dispose();
  });
  it("默认启用 console（治理页面是主要入口），可用 enabled:false 显式关闭", async () => {
    expect(resolveConsoleConfig(undefined)).toMatchObject({ enabled: true, host: "127.0.0.1", port: DEFAULT_CONSOLE_PORT });
    expect(resolveConsoleConfig({ console: { enabled: false } }).enabled).toBe(false);
    const ctx = new Context() as unknown as CapsuleHostContext & { get(name: string): unknown };
    (ctx as { on?: unknown }).on = () => () => undefined;
    const dispose = await apply(ctx, { console: { enabled: false } });
    expect(typeof ctx.get("capabilities")).toBe("object");
    await dispose();
  });
});
