import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { apply, inject, name } from "../index.js";
/** 供插件 inject 满足的最小服务桩；Guard 不应再注册任何凭证代理工具。 */
const toolsStub = { register: () => { throw new Error("短期授权插件不应注册代理工具"); } };
const approvalStub = { request: async () => "unavailable" };
function provideStubs(root: Context): void {
  root.provide("tools", toolsStub as never);
  root.provide("approval", approvalStub as never);
}
describe("插件装载形态（P1-3）", () => {
  it("导出符合 cordis 插件契约：name / inject / apply", () => {
    expect(name).toBe("dsh-capability-guard");
    expect(inject).toEqual(["tools", "approval"]);
    expect(typeof apply).toBe("function");
  });
  it("经 cordis 装载后：不注册代理服务，四个授权 hook 在真实 waterfall 上生效", async () => {
    const root = new Context();
    provideStubs(root);
    await root.plugin({ name, inject, apply: apply as never });
    expect(root.get("capabilities")).toBeUndefined();
    // 四个 hook 的存在性用行为证明（事件名注册无法从外部枚举，行为可验证）：
    // ① pre-execute：allow 透传
    const exec = { callId: "c1", rootCallId: "c1", name: "pwsh", arguments: { command: "Get-Date" }, agent: { id: "s1" } };
    expect(await root.waterfall(root, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" as const }))).toEqual({ kind: "allow" });
    // ② tools/execute：原样返回下游结果
    const sentinel = Object.freeze({ ok: true });
    expect(await root.waterfall(root, "tools/execute", exec, () => Promise.resolve(sentinel))).toBe(sentinel);
    // ③ approval/request：落底值原样透传（无人认领时必须是 unavailable）
    expect(await root.waterfall(root, "approval/request", { callId: "c1" }, () => Promise.resolve("unavailable" as const))).toBe("unavailable");
    // ④ tools/result：观察者，不抛错、不改结果
    expect(() => root.emit(root, "tools/result", exec, { isError: false })).not.toThrow();
  });
  it("装载后的 hook 挂在真实 waterfall 上：pre-execute 落底 allow 语义不被打扰", async () => {
    const root = new Context();
    provideStubs(root);
    await root.plugin({ name, inject, apply: apply as never });
    const exec = { callId: "c1", rootCallId: "c1", name: "pwsh", arguments: { command: "Get-Date" }, agent: { id: "s1" } };
    const decision = await root.waterfall(root, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" as const }));
    expect(decision).toEqual({ kind: "allow" });
  });
  it("默认配置（无 rules）下，带沙箱升级参数的调用不产生任何授权副作用", async () => {
    const root = new Context();
    provideStubs(root);
    await root.plugin({ name, inject, apply: apply as never });
    const exec = { callId: "c1", rootCallId: "c1", name: "pwsh", arguments: { command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification: "j" }, agent: { id: "s1" } };
    const result = await root.waterfall(root, "tools/execute", exec, () => Promise.resolve("tool-ok"));
    expect(result).toBe("tool-ok");
    // 默认零规则 → Guard 完全不接管；此处只验证不抛错、不改变结果
    const approval = await root.waterfall(root, "approval/request", { callId: "c1" }, () => Promise.resolve("unavailable" as const));
    expect(approval).toBe("unavailable");
  });
});
