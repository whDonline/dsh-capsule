import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { buildSandboxModeReader } from "../index.js";
// 作用：固化一条【外部依赖行为】——`ctx.get(name)` 在服务缺失时返回 undefined 而不是抛错。
// Guard 的整个降级契约（服务缺失 → 读不到档位 → 免打扰的「完全访问不可开启」判断退化为不拦截，
// 但不涉及任何权限放宽）就建立在这条语义上：若未来 cordis 改为抛错，降级会变成"抛错打断调用链"，
// 属安全方向退化，必须由测试立刻拦住。
describe("cordis ctx.get 语义（Guard 降级契约的外部前提）", () => {
  it("服务未注册：ctx.get 返回 undefined，不抛错", () => {
    const root = new Context();
    expect(root.get("definitely-not-registered")).toBeUndefined();
  });
  it("服务已注册：ctx.get 返回实例；子上下文继承可见", () => {
    const root = new Context();
    root.provide("probeService", { hello: "world" } as never);
    expect(root.get("probeService")).toEqual({ hello: "world" });
    expect(root.extend().get("probeService")).toEqual({ hello: "world" });
  });
  it("缺少 sessionProjections 服务时读取器完整降级：返回保守默认且不抛错", () => {
    const root = new Context();
    const reader = buildSandboxModeReader(root as unknown as Record<string, unknown>);
    expect(reader.sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
  it("非 cordis 宿主（完全没有 ctx.get）：同样降级且不抛错", () => {
    const reader = buildSandboxModeReader({ on: () => () => undefined });
    expect(reader.sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
});
