import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { GovernanceConsole } from "./console-service.js";
import { startConsoleServer, type ConsoleHttpHandle } from "./http-server.js";
function makeConsole(): GovernanceConsole {
  // 作用：最小治理台（空数据）——HTTP 闸门用例只关心路由与校验，不关心视图内容
  return new GovernanceConsole({ audit: new AuditService(), leases: new LeaseManager(new MemoryLeaseStore()) });
}
function makeActions() {
  // 作用：治理动作替身——记录被调用参数，返回值形状与真实 GuardActions 一致
  const revokeSession = vi.fn(async (sessionId: string) => ({ sessionId, revoked: 2, results: [{ outcome: "RESTORED", mode: "workspace-write" as const }] }));
  const restoreSandbox = vi.fn(async (sessionId: string) => ({ sessionId, results: [{ outcome: "RESTORED", mode: "workspace-write" as const }] }));
  const openWindow = vi.fn(async (request: { sessionId: string; toolName: string; mode: "danger-full-access"; ttlSeconds: number }) => ({
    sessionId: request.sessionId,
    leaseId: "lease-window",
    mode: request.mode,
    outcome: "RAISED",
    expiresAt: Date.now() + request.ttlSeconds * 1000,
  }));
  return { revokeSession, restoreSandbox, openWindow };
}
async function withServer(actions: ReturnType<typeof makeActions> | undefined, run: (handle: ConsoleHttpHandle) => Promise<void>): Promise<void> {
  const handle = await startConsoleServer({ console: makeConsole(), actions, port: 0 });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}
const JSON_HEADERS = { "content-type": "application/json", "x-dsh-guard": "1" };
describe("治理台收缩型动作 HTTP 接口（POST /api/revoke）", () => {
  it("缺少自定义头 → 403（跨源预检闸门，防止 CSRF）", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "WRITE_HEADER_REQUIRED" });
      expect(actions.revokeSession).not.toHaveBeenCalled();
    });
  });
  it("content-type 不是 JSON → 415", async () => {
    await withServer(makeActions(), async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: { "content-type": "text/plain", "x-dsh-guard": "1" }, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(415);
    });
  });
  it("未知字段 / 非法 action → 400（Fail Closed，不猜测调用方意图）", async () => {
    await withServer(makeActions(), async (handle) => {
      const unknownField = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", scope: "tool" }) });
      expect(unknownField.status).toBe(400);
      const badAction = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", action: "grant" }) });
      expect(badAction.status).toBe(400);
    });
  });
  it("默认动作是撤销会话授权，返回 revoked 与档位结果", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, action: "revoke", revoked: 2 });
      expect(actions.revokeSession).toHaveBeenCalledWith("s1");
    });
  });
  it("action=restore-sandbox 只回滚档位，不撤销授权", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", action: "restore-sandbox" }) });
      expect(res.status).toBe(200);
      expect(actions.restoreSandbox).toHaveBeenCalledWith("s1");
      expect(actions.revokeSession).not.toHaveBeenCalled();
    });
  });
  it("GET /api/revoke 不允许（405）；未注入动作时 503", async () => {
    await withServer(makeActions(), async (handle) => {
      expect((await fetch(`${handle.url}api/revoke`)).status).toBe(405);
    });
    await withServer(undefined, async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "ACTIONS_UNAVAILABLE" });
    });
  });
  it("非 loopback 来源 → 403（写接口同样受来源白名单约束）", async () => {
    await withServer(makeActions(), async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example.com" }, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(403);
    });
  });
});
describe("免打扰窗口接口（POST /api/window）", () => {
  it("缺少自定义头 / 非 JSON / 非法字段 / 非法档位 → 逐项拒绝，且不会调用动作", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const noHeader = await fetch(`${handle.url}api/window`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s1", toolName: "pwsh", mode: "danger-full-access", ttlSeconds: 60 }) });
      expect(noHeader.status).toBe(403);
      const notJson = await fetch(`${handle.url}api/window`, { method: "POST", headers: { "content-type": "text/plain", "x-dsh-guard": "1" }, body: "{}" });
      expect(notJson.status).toBe(415);
      const badMode = await fetch(`${handle.url}api/window`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", toolName: "pwsh", mode: "root", ttlSeconds: 60 }) });
      expect(badMode.status).toBe(400);
      const extraField = await fetch(`${handle.url}api/window`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", toolName: "pwsh", mode: "danger-full-access", ttlSeconds: 60, scope: "tool" }) });
      expect(extraField.status).toBe(400);
      expect(actions.openWindow).not.toHaveBeenCalled();
      // GET 不允许
      expect((await fetch(`${handle.url}api/window`)).status).toBe(405);
    });
  });
  it("合法请求 → 200，并把四个参数原样交给动作层", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/window`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", toolName: "pwsh", mode: "danger-full-access", ttlSeconds: 900 }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, leaseId: "lease-window", mode: "danger-full-access" });
      expect(actions.openWindow).toHaveBeenCalledWith({ sessionId: "s1", toolName: "pwsh", mode: "danger-full-access", ttlSeconds: 900 });
    });
  });
});
describe("授权决策日志接口（GET /api/decisions）", () => {
  it("返回 summary + records；非法 limit 回 400", async () => {
    await withServer(undefined, async (handle) => {
      const res = await fetch(`${handle.url}api/decisions?sessionId=sess-x&limit=10`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { summary: { total: number }; records: unknown[] };
      expect(body.summary.total).toBe(0);
      expect(body.records).toEqual([]);
      expect((await fetch(`${handle.url}api/decisions?limit=0`)).status).toBe(400);
      expect((await fetch(`${handle.url}api/decisions?limit=abc`)).status).toBe(400);
    });
  });
});
describe("治理台快照查询参数", () => {
  it("?session= 显式聚焦该会话（即使它没有任何授权）", async () => {
    await withServer(undefined, async (handle) => {
      const res = await fetch(`${handle.url}api/snapshot?session=sess-x`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { schemaVersion: number; focus: { sessionId?: string; source: string }; sessions: { sessionId: string }[] };
      expect(body.schemaVersion).toBe(2);
      expect(body.focus).toEqual({ sessionId: "sess-x", source: "explicit" });
      expect(body.sessions[0]?.sessionId).toBe("sess-x");
    });
  });
  it("//api/config 返回收缩动作与自动回滚节拍（前端据此决定是否渲染按钮）", async () => {
    await withServer(makeActions(), async (handle) => {
      const body = (await (await fetch(`${handle.url}api/config`)).json()) as { actions: { revoke: boolean }; sweep: { intervalMs: number } };
      expect(body.actions.revoke).toBe(true);
      expect(body.sweep.intervalMs).toBe(0);
    });
  });
});
