import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { apply, buildSandboxModeReader, type CapsuleHostContext } from "./index.js";
function makeBus(host: CapsuleHostContext) {
  // 作用：为任意宿主 ctx 挂上事件总线（Guard 的 install 需要 on）；宿主本身可以是真实 cordis Context
  (host as { on?: unknown }).on = () => () => {};
  return host;
}
function makeCtx(): CapsuleHostContext {
  return makeBus({});
}
describe("Guard 插件入口（仅短期授权）", () => {
  it("真实 cordis 宿主：不注册 Managed 服务、不读取凭证服务", async () => {
    const ctx = makeBus(new Context());
    const get = (ctx as unknown as Context).get.bind(ctx);
    const accessed: string[] = [];
    ctx.get = (name: string) => {
      accessed.push(name);
      return get(name);
    };
    const dispose = await apply(ctx, { console: { enabled: false } });
    expect(get("capabilities")).toBeUndefined();
    expect(accessed).not.toContain("credentials");
    expect(accessed).not.toContain("subprocess");
    await dispose();
  });
  it("带策略配置：仅安装四个授权 hook，卸载时全部注销", async () => {
    const registered: string[] = [];
    const removed: string[] = [];
    const ctx = { on: (event: string) => { registered.push(event); return () => { removed.push(event); }; } };
    const dispose = await apply(ctx, { defaultTtlSeconds: 120, console: { enabled: false } });
    expect(registered).toEqual(["tools/pre-execute", "tools/execute", "approval/request", "tools/result"]);
    await dispose();
    expect(removed).toEqual(registered);
  });
  it("最小宿主无需 Managed 服务也能装配和卸载", async () => {
    const ctx = makeCtx();
    const dispose = await apply(ctx, { console: { enabled: false } });
    await dispose();
    expect(ctx.capabilities).toBeUndefined();
  });
});
describe("buildSandboxModeReader（宿主只读适配器）", () => {
  it("读取 DSH 会话投影中的 sandboxMode", () => {
    const ctx = { get: (name: string) => (name === "sessionProjections" ? { stateOf: () => "read-only" } : undefined) };
    expect(buildSandboxModeReader(ctx).sessionSandboxMode({ id: "s1" })).toBe("read-only");
  });
  it("投影缺失 / 返回非法值：读返回保守默认，绝不猜测", () => {
    expect(buildSandboxModeReader({}).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
    expect(buildSandboxModeReader({ get: () => ({ stateOf: () => "full-access" }) }).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
    expect(buildSandboxModeReader({ get: () => ({ stateOf: () => undefined }) }).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
  it("投影读取抛错：仍返回保守默认（不向外抛，避免打断执行链）", () => {
    const ctx = {
      get: () => ({
        stateOf: () => {
          throw new Error("boom");
        },
      }),
    };
    expect(buildSandboxModeReader(ctx).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
  it("ctx.get 本身抛错：同样返回保守默认", () => {
    const ctx = {
      get: () => {
        throw new Error("no inject");
      },
    };
    expect(buildSandboxModeReader(ctx).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
});
