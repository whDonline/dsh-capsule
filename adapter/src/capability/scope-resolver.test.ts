import { describe, expect, it } from "vitest";
import { ScopeResolver } from "./scope-resolver.js";
import type { ResolvedToolPolicy } from "./policy.js";
const resolver = new ScopeResolver();
const policyOf = (scope: ResolvedToolPolicy["scope"]): ResolvedToolPolicy => ({ enabled: true, ttlSeconds: 60, scope });
describe("ScopeResolver", () => {
  it("exact-arguments：key 顺序无关，参数变化即新 scope（规格 22.9 基础）", () => {
    const policy = policyOf({ mode: "exact-arguments" });
    const a = resolver.resolve({ toolName: "t", arguments: { repo: "a/b", title: "x" } }, policy);
    const b = resolver.resolve({ toolName: "t", arguments: { title: "x", repo: "a/b" } }, policy);
    const c = resolver.resolve({ toolName: "t", arguments: { repo: "a/b", title: "y" } }, policy);
    expect(a.kind).toBe("exact-arguments");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
  it("exact-arguments 的展示串不输出参数值（隐私），也不出现敏感原文", () => {
    const policy = policyOf({ mode: "exact-arguments" });
    const scope = resolver.resolve({ toolName: "t", arguments: { token: "ghp_secret_value", repo: "a/b" } }, policy);
    expect(scope.display).toContain("token");
    expect(scope.display).not.toContain("ghp_secret_value");
    expect(scope.display).not.toContain("a/b");
    // shell 类工具展示脱敏后的命令文本（便于审计看出批准的是哪条命令）
    const command = resolver.resolve({ toolName: "pwsh", arguments: { command: "gh auth login --with-token ghp_secret_value" } }, policy);
    expect(command.display).toContain("pwsh");
    expect(command.display).not.toContain("ghp_secret_value");
  });
  it("exact-arguments 把目标沙箱档位纳入 key：同一条命令升不同档位是两条操作", () => {
    const policy = policyOf({ mode: "exact-arguments" });
    const args = { command: "Set-Content C:\\x", sandbox_permissions: "workspace-write", justification: "第一次" };
    const a = resolver.resolve({ toolName: "pwsh", arguments: args }, policy);
    const b = resolver.resolve({ toolName: "pwsh", arguments: { ...args, justification: "换个措辞" } }, policy);
    const c = resolver.resolve({ toolName: "pwsh", arguments: { ...args, sandbox_permissions: "danger-full-access" } }, policy);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
  it("fields：指定字段相同即同 scope，其余字段可变（规格 5.4.2）", () => {
    const policy = policyOf({ mode: "fields", paths: ["repo"] });
    const a = resolver.resolve({ toolName: "t", arguments: { repo: "a/b", title: "x" } }, policy);
    const b = resolver.resolve({ toolName: "t", arguments: { repo: "a/b", title: "y" } }, policy);
    const c = resolver.resolve({ toolName: "t", arguments: { repo: "other/r", title: "x" } }, policy);
    expect(a.kind).toBe("fields");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
  it("fields：指定字段缺失抛错（Fail Closed）", () => {
    const policy = policyOf({ mode: "fields", paths: ["repo"] });
    expect(() => resolver.resolve({ toolName: "t", arguments: { title: "x" } }, policy)).toThrow("LEASE_SCOPE_INVALID");
  });
  it("fields：非对象参数抛错（Fail Closed）", () => {
    const policy = policyOf({ mode: "fields", paths: ["repo"] });
    expect(() => resolver.resolve({ toolName: "t", arguments: ["a"] }, policy)).toThrow("LEASE_SCOPE_INVALID");
  });
  it("tool 模式：key 稳定且与参数无关（规格 5.4.3）", () => {
    const policy = policyOf({ mode: "tool" });
    const a = resolver.resolve({ toolName: "t", arguments: { x: 1 } }, policy);
    const b = resolver.resolve({ toolName: "t", arguments: { x: 2 } }, policy);
    expect(a.kind).toBe("tool");
    expect(a.key).toBe("tool:t");
    expect(a.key).toBe(b.key);
  });
  it("参数含非法 JSON 值抛错（Fail Closed）", () => {
    const policy = policyOf({ mode: "exact-arguments" });
    expect(() => resolver.resolve({ toolName: "t", arguments: { bad: 10n } }, policy)).toThrow("LEASE_SCOPE_INVALID");
  });
});
