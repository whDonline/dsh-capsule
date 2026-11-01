import { describe, expect, it } from "vitest";
import { SANDBOX_MODES, SANDBOX_MODE_LABELS, isSandboxMode, parseEscalation, sandboxModeLabel } from "./escalation.js";
describe("沙箱升级请求的确定性识别", () => {
  it("识别标准升级参数：sandbox_permissions 为闭集字面量且 justification 非空", () => {
    const parsed = parseEscalation({ sandbox_permissions: "danger-full-access", justification: "需要写入工作区外文件" });
    expect(parsed).toEqual({ requestedMode: "danger-full-access", justification: "需要写入工作区外文件" });
  });
  it("三个闭集模式都能识别", () => {
    for (const mode of SANDBOX_MODES) {
      expect(parseEscalation({ sandbox_permissions: mode, justification: "x" })?.requestedMode).toBe(mode);
    }
  });
  it("非闭集模式一律不识别（Fail Closed，不猜测）", () => {
    for (const bad of ["full-access", "DANGER-FULL-ACCESS", "workspace_write", "", "root", "danger-full-access "]) {
      expect(parseEscalation({ sandbox_permissions: bad, justification: "x" })).toBeUndefined();
    }
  });
  it("非字符串 / 非对象 / 数组 / null 一律不识别", () => {
    expect(parseEscalation(undefined)).toBeUndefined();
    expect(parseEscalation(null)).toBeUndefined();
    expect(parseEscalation([])).toBeUndefined();
    expect(parseEscalation("sandbox_permissions")).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: 1, justification: "x" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: null, justification: "x" })).toBeUndefined();
  });
  it("justification 缺失、空串或非字符串一律不识别（DSH 要求两者配对）", () => {
    expect(parseEscalation({ sandbox_permissions: "workspace-write" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: "" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: 42 })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: null })).toBeUndefined();
  });
  it("只识别 DSH 的精确键名，近似键名不识别（防止第三方工具的同名语义混淆）", () => {
    expect(parseEscalation({ sandboxPermissions: "danger-full-access", justification: "x" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permission: "danger-full-access", justification: "x" })).toBeUndefined();
    expect(parseEscalation({ mode: "danger-full-access", justification: "x" })).toBeUndefined();
  });
  it("允许携带无关参数：识别只依赖两个升级字段的存在与形状", () => {
    const parsed = parseEscalation({ command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification: "y", timeoutMs: 1000 });
    expect(parsed?.requestedMode).toBe("danger-full-access");
  });
});
describe("档位文案与闭集校验", () => {
  it("isSandboxMode 只接受闭集字面量", () => {
    expect(isSandboxMode("danger-full-access")).toBe(true);
    expect(isSandboxMode("danger-full-access ")).toBe(false);
    expect(isSandboxMode(undefined)).toBe(false);
    expect(isSandboxMode(3)).toBe(false);
  });
  it("档位中文名唯一来源：缺失时给「未知」，绝不编造", () => {
    for (const mode of SANDBOX_MODES) expect(sandboxModeLabel(mode)).toBe(SANDBOX_MODE_LABELS[mode]);
    expect(sandboxModeLabel(undefined)).toBe("未知");
  });
});
