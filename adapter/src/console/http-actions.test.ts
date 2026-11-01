import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { GuardSettings } from "../capability/settings.js";
import { GovernanceConsole } from "./console-service.js";
import { startConsoleServer, type ConsoleHttpHandle } from "./http-server.js";
function makeConsole(): GovernanceConsole {
  // 作用：最小治理台（空数据）——HTTP 闸门用例只关心路由与校验，不关心视图内容
  return new GovernanceConsole({ audit: new AuditService(), leases: new LeaseManager(new MemoryLeaseStore()) });
}
function makeActions() {
  // 作用：治理动作替身——记录被调用参数，返回值形状与真实 GuardActions 一致
  const revokeSession = vi.fn(async (sessionId: string) => ({ sessionId, revoked: 2 }));
  const startDnd = vi.fn((sessionId: string, ttlSeconds: number) => ({ sessionId, expiresAt: Date.now() + ttlSeconds * 1000 }));
  const stopDnd = vi.fn(() => true);
  const extendDnd = vi.fn((sessionId: string, addSeconds: number) => ({ sessionId, expiresAt: Date.now() + addSeconds * 1000 }));
  return { revokeSession, startDnd, stopDnd, extendDnd };
}
async function withServer(actions: ReturnType<typeof makeActions> | undefined, run: (handle: ConsoleHttpHandle) => Promise<void>, settings?: GuardSettings): Promise<void> {
  const handle = await startConsoleServer({ console: makeConsole(), actions, port: 0, settings });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}
const JSON_HEADERS = { "content-type": "application/json", "x-dsh-guard": "1" };
describe("用户可见的三档设置（GET/PATCH /api/config 的 settings）", () => {
  it("GET 返回 settings 与挡位目录（含中文名，前端不再自己映射）", async () => {
    await withServer(undefined, async (handle) => {
      const body = (await (await fetch(`${handle.url}api/config`)).json()) as { settings: { enabled: boolean; reuseTtlSeconds: number; dndDurationSeconds: number }; catalog: { guardModes: { id: string; label: string }[] } };
      expect(body.settings).toMatchObject({ enabled: true, reuseTtlSeconds: 1800, dndDurationSeconds: 900 });
      expect(body.catalog.guardModes.map((item) => item.id)).toEqual(["off", "same-operation", "do-not-disturb"]);
    }, new GuardSettings({ maxTtlSeconds: 1800 }));
  });
  it("PATCH settings 生效；非法值 → 409 且不改动；mode 已不再接受（免打扰是窗口不是设置）", async () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    await withServer(undefined, async (handle) => {
      const ok = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ settings: { reuseTtlSeconds: 120 } }) });
      expect(ok.status).toBe(200);
      expect(settings.snapshot()).toMatchObject({ reuseTtlSeconds: 120 });
      const removedMode = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ settings: { mode: "same-operation" } }) });
      expect(removedMode.status).toBe(400);
      const bad = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ settings: { reuseTtlSeconds: 1801 } }) });
      expect(bad.status).toBe(409);
      expect(settings.snapshot().reuseTtlSeconds).toBe(120);
      const unknown = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ settings: { rules: [] } }) });
      expect(unknown.status).toBe(400);
    }, settings);
  });
  it("没有注入 settings 时 PATCH 返回 503（Fail Closed）", async () => {
    await withServer(undefined, async (handle) => {
      const res = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ settings: { enabled: false } }) });
      expect(res.status).toBe(503);
    });
  });
});
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
  it("未知字段一律拒绝 → 400（Fail Closed，不猜测调用方意图）", async () => {
    await withServer(makeActions(), async (handle) => {
      const unknownField = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", scope: "tool" }) });
      expect(unknownField.status).toBe(400);
      const removedAction = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", action: "restore-sandbox" }) });
      expect(removedAction.status).toBe(400);
    });
  });
  it("撤销会话授权：返回 revoked", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/revoke`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, action: "revoke", revoked: 2 });
      expect(actions.revokeSession).toHaveBeenCalledWith("s1");
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
      expect(body.schemaVersion).toBe(4);
      expect(body.focus).toEqual({ sessionId: "sess-x", source: "explicit" });
      expect(body.sessions[0]?.sessionId).toBe("sess-x");
    });
  });
  it("/api/config 返回收缩动作与免打扰结算节拍（前端据此决定是否渲染按钮）", async () => {
    await withServer(makeActions(), async (handle) => {
      const body = (await (await fetch(`${handle.url}api/config`)).json()) as { actions: { revoke: boolean }; sweep: { intervalMs: number } };
      expect(body.actions.revoke).toBe(true);
      expect(body.sweep.intervalMs).toBe(0);
    });
  });
});
describe("免打扰窗口接口（POST /api/dnd、/api/dnd/stop、/api/dnd/extend）", () => {
  it("开启：合法请求交给动作层（sessionId + ttlSeconds），返回 expiresAt", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 900 }) });
      expect(res.status).toBe(200);
      expect(actions.startDnd).toHaveBeenCalledWith("s1", 900);
      expect(await res.json()).toMatchObject({ ok: true, sessionId: "s1" });
    });
  });
  it("开启：缺少自定义头 403、非 JSON 415、多余字段 400、非法 TTL 400", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      expect((await fetch(`${handle.url}api/dnd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 900 }) })).status).toBe(403);
      expect((await fetch(`${handle.url}api/dnd`, { method: "POST", headers: { "content-type": "text/plain", "x-dsh-guard": "1" }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${handle.url}api/dnd`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 900, ceiling: "full" }) })).status).toBe(400);
      expect((await fetch(`${handle.url}api/dnd`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 0 }) })).status).toBe(400);
      expect(actions.startDnd).not.toHaveBeenCalled();
      expect((await fetch(`${handle.url}api/dnd`)).status).toBe(405);
    });
  });
  it("开启：完全访问等不适用场景 → 409；参数/状态非法 → 400", async () => {
    const actions = makeActions();
    actions.startDnd.mockImplementationOnce(() => {
      throw new Error("GUARD_DND_NOT_APPLICABLE: 当前已是完全访问挡位");
    });
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 900 }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "DND_NOT_APPLICABLE" });
    });
    actions.startDnd.mockImplementationOnce(() => {
      throw new Error("GUARD_DND_INVALID: ttlSeconds must be <= 1800");
    });
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", ttlSeconds: 900 }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "DND_INVALID" });
    });
  });
  it("结束：调用 stopDnd 并回 stopped；未注入动作时 503", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd/stop`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(200);
      expect(actions.stopDnd).toHaveBeenCalledWith("s1");
      expect(await res.json()).toMatchObject({ ok: true, stopped: true });
    });
    await withServer(undefined, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd/stop`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1" }) });
      expect(res.status).toBe(503);
    });
  });
  it("延长：调用 extendDnd(addSeconds)；非法 addSeconds 400", async () => {
    const actions = makeActions();
    await withServer(actions, async (handle) => {
      const res = await fetch(`${handle.url}api/dnd/extend`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", addSeconds: 600 }) });
      expect(res.status).toBe(200);
      expect(actions.extendDnd).toHaveBeenCalledWith("s1", 600);
      expect((await fetch(`${handle.url}api/dnd/extend`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: "s1", addSeconds: 0 }) })).status).toBe(400);
    });
  });
});
