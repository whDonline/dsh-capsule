import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { FamilyGrantStore, identifyFamilies, parseReadOnlyCommand } from "./families.js";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { PendingRegistry } from "./pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "./policy.js";
import { GuardSettings, type GuardMode } from "./settings.js";
import { ScopeResolver } from "./scope-resolver.js";
import { UniversalGate } from "./universal-gate.js";
function makeStack(mode: GuardMode, active = true) {
  let now = 1_000;
  const clock = () => now;
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const audit = new AuditService();
  const settings = new GuardSettings({ maxTtlSeconds: 1800 });
  settings.update({ mode, enabled: active });
  const gate = new UniversalGate({
    policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    settings,
    now: clock,
  });
  return { gate, leases, audit, advance: (ms: number) => { now += ms; } };
}
async function callTool(stack: ReturnType<typeof makeStack>, callId: string, toolName: string, args: Record<string, unknown>) {
  await stack.gate.handleExecute({ callId, name: toolName, agent: { id: "s1" }, arguments: args }, async () => "ok");
  const human = vi.fn(async () => "allowed-once" as const);
  const outcome = await stack.gate.handleApprovalRequest({ callId, agent: { id: "s1" }, toolName }, human);
  return { outcome, human };
}
describe("操作族识别（② 同族模式的判据）", () => {
  it("只读工具：同一文件 + 同工具两个族；参数键名展示不含参数值", () => {
    const families = identifyFamilies("read", { file_path: "D:\\proj\\a.ts", offset: 1 });
    expect(families.map((item) => item.kind).sort()).toEqual(["object", "tool"]);
    expect(families.find((item) => item.kind === "object")?.label).toContain("a.ts");
  });
  it("写/删类工具只有对象族——绝不能有同工具族", () => {
    expect(identifyFamilies("write", { file_path: "D:\\proj\\a.ts", content: "x" }).map((item) => item.kind)).toEqual(["object"]);
    expect(identifyFamilies("rm", { path: "D:\\proj\\a.ts" }).some((item) => item.kind === "tool")).toBe(false);
  });
  it("命令族：只读程序 + 允许的子命令；写命令与未知子命令一律不给族", () => {
    expect(parseReadOnlyCommand("git status --short")).toEqual({ program: "git", sub: "status" });
    expect(parseReadOnlyCommand("git push origin main")).toBeUndefined();
    expect(parseReadOnlyCommand("rm -rf D:\\proj")).toBeUndefined();
    expect(parseReadOnlyCommand("del a.txt")).toBeUndefined();
    // 同一子命令的不同写法属于同一族（flags 不影响）
    const a = identifyFamilies("pwsh", { command: "git status" }).find((item) => item.kind === "command");
    const b = identifyFamilies("pwsh", { command: "git status --short" }).find((item) => item.kind === "command");
    expect(a?.key).toBe(b?.key);
  });
  it("目录族 / 程序族：写操作也能复用，但破坏性程序永不参与", () => {
    const a = identifyFamilies("pwsh", { command: "New-Item -ItemType Directory -Path D:\\work\\a" });
    expect(a.some((item) => item.kind === "dir")).toBe(true);
    expect(a.some((item) => item.kind === "program")).toBe(true);
    // 换目录：目录族不命中，但「同前缀」（New-Item）仍命中——比同程序更具体，优先返回
    const b = identifyFamilies("pwsh", { command: "New-Item -ItemType Directory -Path D:\\other\\b" });
    const store = new FamilyGrantStore();
    store.grant(a, 60, 1_000);
    expect(store.match(b, 1_000)?.kind).toBe("prefix");
    // 破坏性程序：连程序族与目录族都没有（换参数必须重新问）
    for (const command of ["Remove-Item D:\\work\\a", "del D:\\work\\a.txt", "Move-Item D:\\work\\a D:\\work\\b"]) {
      const families = identifyFamilies("pwsh", { command });
      expect(families.some((item) => item.kind === "dir" || item.kind === "program")).toBe(false);
    }
    // git 不参与程序族（git status 的批准不能放过 git push）
    expect(identifyFamilies("pwsh", { command: "git push origin main" }).some((item) => item.kind === "program")).toBe(false);
  });
  it("族放行表：只在 TTL 内有效，按对象族优先匹配", () => {
    const store = new FamilyGrantStore();
    const refs = identifyFamilies("read", { file_path: "D:\\a.ts" });
    store.grant(refs, 60, 1_000);
    expect(store.match(refs, 1_000)?.kind).toBe("object");
    expect(store.match(refs, 60_999)).toBeDefined();
    expect(store.match(refs, 61_001)).toBeUndefined();
  });
});
describe("② 同族模式：同一类操作不再询问", () => {
  it("批准一次 read 之后，另一个文件的 read 也免问（同工具族）", async () => {
    const stack = makeStack("same-family");
    const first = await callTool(stack, "c1", "read", { file_path: "D:\\proj\\a.ts" });
    expect(first.human).toHaveBeenCalledTimes(1);
    const second = await callTool(stack, "c2", "read", { file_path: "D:\\proj\\b.ts" });
    expect(second.human).not.toHaveBeenCalled();
  });
  it("① 同操作模式下同样的场景仍然要问（对照组）", async () => {
    const stack = makeStack("same-operation");
    await callTool(stack, "c1", "read", { file_path: "D:\\proj\\a.ts" });
    const second = await callTool(stack, "c2", "read", { file_path: "D:\\proj\\b.ts" });
    expect(second.human).toHaveBeenCalledTimes(1);
  });
  it("写类工具即使在同一族模式下，换文件也必须问（无同工具族）", async () => {
    const stack = makeStack("same-family");
    await callTool(stack, "c1", "write", { file_path: "D:\\proj\\a.ts", content: "x" });
    const second = await callTool(stack, "c2", "write", { file_path: "D:\\proj\\b.ts", content: "y" });
    expect(second.human).toHaveBeenCalledTimes(1);
  });
  it("同一文件的不同参数命中对象族（跨工具不共享）", async () => {
    const stack = makeStack("same-family");
    await callTool(stack, "c1", "read", { file_path: "D:\\proj\\a.ts", offset: 1 });
    const sameFile = await callTool(stack, "c2", "read", { file_path: "D:\\proj\\a.ts", offset: 99 });
    expect(sameFile.human).not.toHaveBeenCalled();
  });
  it("命令族：git status 的不同写法免问，git push 仍然要问", async () => {
    const stack = makeStack("same-family");
    await callTool(stack, "c1", "pwsh", { command: "git status" });
    const sameFamily = await callTool(stack, "c2", "pwsh", { command: "git status --short" });
    expect(sameFamily.human).not.toHaveBeenCalled();
    const other = await callTool(stack, "c3", "pwsh", { command: "git push origin main" });
    expect(other.human).toHaveBeenCalledTimes(1);
  });
  it("族放行过期后必须重新询问", async () => {
    const stack = makeStack("same-family");
    await callTool(stack, "c1", "read", { file_path: "D:\\proj\\a.ts" });
    stack.advance(301_000);
    const later = await callTool(stack, "c2", "read", { file_path: "D:\\proj\\b.ts" });
    expect(later.human).toHaveBeenCalledTimes(1);
  });
});
