import { describe, expect, it } from "vitest";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "./policy.js";
import { DEFAULTABLE_SCOPE_MODES } from "./scope-modes.js";
describe("默认挡位白名单（DEFAULTABLE_SCOPE_MODES）", () => {
  it("只有 exact-arguments 能作为默认挡位：fields 需要显式字段，tool 范围过宽", () => {
    expect([...DEFAULTABLE_SCOPE_MODES]).toEqual(["exact-arguments"]);
    expect(DEFAULTABLE_SCOPE_MODES).not.toContain("fields");
    expect(DEFAULTABLE_SCOPE_MODES).not.toContain("tool");
  });
});
describe("PolicyResolver", () => {
  it("默认策略：enabled、TTL 60s、exact-arguments（规格 7.1）", () => {
    expect(new PolicyResolver(DEFAULT_UNIVERSAL_POLICY).resolve("any_tool")).toEqual({
      enabled: true,
      ttlSeconds: 60,
      scope: { mode: "exact-arguments" },
    });
  });
  it("精确匹配规则覆盖 TTL 与 scope，未匹配 Tool 用默认", () => {
    const resolver = new PolicyResolver({
      ...DEFAULT_UNIVERSAL_POLICY,
      rules: [{ match: "github_create_issue", ttlSeconds: 120, scope: { mode: "fields", paths: ["repo"] } }],
    });
    expect(resolver.resolve("github_create_issue")).toEqual({ enabled: true, ttlSeconds: 120, scope: { mode: "fields", paths: ["repo"] } });
    expect(resolver.resolve("other_tool")).toEqual({ enabled: true, ttlSeconds: 60, scope: { mode: "exact-arguments" } });
  });
  it("规则 disabled 时该 Tool 不被 Guard 接管", () => {
    const resolver = new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "x", enabled: false }] });
    expect(resolver.resolve("x").enabled).toBe(false);
    expect(resolver.resolve("y").enabled).toBe(true);
  });
  it("全局 enabled=false 时全部不接管", () => {
    const resolver = new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, enabled: false });
    expect(resolver.resolve("x").enabled).toBe(false);
  });
  it("规则 TTL 超上限抛错（Fail Closed，禁止静默 clamp）（规格 19）", () => {
    const resolver = new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "x", ttlSeconds: 9999 }] });
    expect(() => resolver.resolve("x")).toThrow("LEASE_TTL_INVALID");
  });
  it("默认 TTL 非法在构造时抛错", () => {
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, defaultTtlSeconds: 0 })).toThrow("LEASE_TTL_INVALID");
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, defaultTtlSeconds: 9999 })).toThrow("LEASE_TTL_INVALID");
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, maxTtlSeconds: 0 })).toThrow("LEASE_TTL_INVALID");
  });
  it("规则自身非法（TTL/paths/match）在构造时抛错", () => {
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "x", ttlSeconds: -5 }] })).toThrow("LEASE_POLICY_INVALID");
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "", }] })).toThrow("LEASE_POLICY_INVALID");
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "x", scope: { mode: "fields", paths: [] } }] })).toThrow("LEASE_POLICY_INVALID");
    expect(() => new PolicyResolver({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "x", scope: { mode: "fields", paths: [""] } }] })).toThrow("LEASE_POLICY_INVALID");
  });
});
