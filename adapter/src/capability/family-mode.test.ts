import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { FamilyGrantStore, identifyFamilies, hasDestructiveCommand, parseCommandPrefix, parseReadOnlyCommand, splitSubcommands } from "./families.js";
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
  it("工具族：除 shell 与破坏性工具外都成族（2026-10-31 归粗）", () => {
    expect(identifyFamilies("write", { file_path: "D:\\proj\\a.ts", content: "x" }).map((item) => item.kind)).toEqual(["object", "tool"]);
    // shell 工具不能成族：否则批准一次 pwsh 等于所有命令都不再问
    expect(identifyFamilies("pwsh", { command: "Get-Date" }).some((item) => item.kind === "tool")).toBe(false);
    // 破坏性工具不成族
    expect(identifyFamilies("rm", { path: "D:\\proj\\a.ts" }).some((item) => item.kind === "tool")).toBe(false);
    // 只读工具也成族
    expect(identifyFamilies("read", { file_path: "D:\\proj\\a.ts" }).some((item) => item.kind === "tool")).toBe(true);
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
  it("复合命令：拆成子命令逐个匹配，全部有放行才允许整条脚本", () => {
    // `$p = Join-Path ...` 只是赋值，真正执行的是 Join-Path 与 New-Item 两条子命令
    expect(splitSubcommands("$p = Join-Path D:\\x a\nNew-Item $p")).toEqual(["Join-Path D:\\x a", "New-Item $p"]);
    const scriptA = identifyFamilies("pwsh", { command: "$p = Join-Path D:\\x a\nNew-Item $p" });
    const prefixes = scriptA.filter((item) => item.kind === "prefix");
    expect(prefixes).toHaveLength(2);
    const store = new FamilyGrantStore();
    // 只批准其中一条子命令 → 整条脚本仍然不能复用
    store.grant([prefixes[0]!], 60, 1_000);
    const scriptB = identifyFamilies("pwsh", { command: "$q = Join-Path D:\\y b\nNew-Item $q" });
    expect(store.match(scriptB, 1_000, ["prefix"])).toBeUndefined();
    // 两条都批准后 → 同类脚本复用
    store.grant([prefixes[1]!], 60, 1_000);
    expect(store.match(scriptB, 1_000, ["prefix"])?.kind).toBe("prefix");
  });
  it("含破坏性命令的脚本：族照常登记，但这一次仍必须人工确认", async () => {
    const stack = makeStack("same-operation");
    const first = await callTool(stack, "c1", "pwsh", { command: "$p = Join-Path D:\\x a\nRemove-Item $p -Force" });
    expect(first.human).toHaveBeenCalledTimes(1);
    const second = await callTool(stack, "c2", "pwsh", { command: "$p = Join-Path D:\\x b\nRemove-Item $p -Force" });
    // blocked=true → 即使 Join-Path 的族已登记，也不允许自动放行
    expect(second.human).toHaveBeenCalledTimes(1);
  });
  it("不含破坏性命令的同类脚本仍会自动复用（对照组）", async () => {
    const stack = makeStack("same-operation");
    await callTool(stack, "c1", "pwsh", { command: "$p = Join-Path D:\\x a\nNew-Item -Path $p -Force | Out-Null" });
    const second = await callTool(stack, "c2", "pwsh", { command: "$p = Join-Path D:\\x b\nNew-Item -Path $p -Force | Out-Null" });
    expect(second.human).not.toHaveBeenCalled();
  });
  it("【回归】脚本里的收尾表达式不应作废整条脚本的前缀（线上实测 familyGrants=0）", () => {
    const script = "$p = Join-Path $env:USERPROFILE 'Desktop\\a'\nNew-Item -ItemType Directory -Path $p -Force | Out-Null\n\"created=\" + (Test-Path $p)";
    const prefixes = identifyFamilies("pwsh", { command: script }).filter((item) => item.kind === "prefix");
    expect(prefixes.map((item) => item.label)).toEqual(["同前缀 join-path", "同前缀 new-item", "同前缀 out-null"]);
    // 混合粒度（方案 C）：有子命令语义的程序细分，cmdlet 只到程序
    const keyOf = (command: string) => identifyFamilies("pwsh", { command }).find((item) => item.kind === "prefix");
    expect(keyOf("npm run build")?.label).toBe("同前缀 npm run");
    expect(keyOf("npm run build")?.key).not.toBe(keyOf("npm install")?.key);
    expect(keyOf("git log")?.label).toBe("同前缀 git log");
    expect(keyOf("New-Item -ItemType File -Path D:\\b")?.key).toBe(keyOf("New-Item -ItemType Directory -Path D:\\a")?.key);
    // 逐条判定（2026-10-31 改定）：含破坏性命令的脚本仍有其它子命令的族，
    // 但整条命令被标记为 blocked —— 这一次调用不允许走族复用（由 gate 保证）。
    const risky = "$p = Join-Path D:\\x a\nRemove-Item $p -Force\n\"done\"";
    expect(hasDestructiveCommand(risky)).toBe(true);
    expect(identifyFamilies("pwsh", { command: risky }).some((item) => item.kind === "prefix")).toBe(true);
    // 不含破坏性命令的脚本 blocked = false
    expect(hasDestructiveCommand("New-Item -ItemType Directory -Path D:\\a")).toBe(false);
  });
  it("【安全回归】多行脚本 / 变量赋值 / 脚本内含破坏性命令 → 一律不给前缀", () => {
    // 实测缺陷：`$p = Join-Path ...` 曾被解析成前缀 `$p =`，导致所有脚本互相复用、Remove-Item 被放行
    expect(parseCommandPrefix("$p = Join-Path $env:USERPROFILE 'Desktop\\a'")).toBeUndefined();
    expect(parseCommandPrefix("New-Item -ItemType Directory -Path D:\\a\nRemove-Item D:\\b")).toBeUndefined();
    expect(parseCommandPrefix("Get-Date\nRemove-Item D:\\x")).toBeUndefined();
    // 正常单行命令仍然生成前缀
    expect(parseCommandPrefix("New-Item -ItemType Directory -Path D:\\a")?.text).toBe("new-item");
    // 高危子命令 / 破坏性程序不生成前缀
    expect(parseCommandPrefix("git push origin main")).toBeUndefined();
    expect(parseCommandPrefix("npm publish")).toBeUndefined();
    expect(parseCommandPrefix("Remove-Item D:\\a")).toBeUndefined();
  });
  it("目录族：写操作也能复用，但破坏性程序永不参与", () => {
    const a = identifyFamilies("pwsh", { command: "New-Item -ItemType Directory -Path D:\\work\\a" });
    expect(a.some((item) => item.kind === "dir")).toBe(true);
    // 「同程序」族已删除：前缀族已经覆盖它，且前缀族带目标档位
    expect(a.some((item) => item.kind === "program")).toBe(false);
    // 换目录：目录族不命中，但「同前缀」（New-Item）仍命中——比目录更宽，优先返回
    const b = identifyFamilies("pwsh", { command: "New-Item -ItemType Directory -Path D:\\other\\b" });
    const store = new FamilyGrantStore();
    store.grant(a, 60, 1_000);
    expect(store.match(b, 1_000)?.kind).toBe("prefix");
    // 破坏性程序：连目录族也没有（换参数必须重新问）
    for (const command of ["Remove-Item D:\\work\\a", "del D:\\work\\a.txt", "Move-Item D:\\work\\a D:\\work\\b"]) {
      const families = identifyFamilies("pwsh", { command });
      expect(families.some((item) => item.kind === "dir")).toBe(false);
    }
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
  it("两档合并后：只读工具族在默认档位就生效（不再需要单独的「同族」档）", async () => {
    const stack = makeStack("same-operation");
    await callTool(stack, "c1", "read", { file_path: "D:\\proj\\a.ts" });
    const second = await callTool(stack, "c2", "read", { file_path: "D:\\proj\\b.ts" });
    expect(second.human).not.toHaveBeenCalled();
  });
  it("归粗后：写类工具同一个就行（同工具族）；破坏性工具仍然每次问", async () => {
    const stack = makeStack("same-operation");
    await callTool(stack, "c1", "write", { file_path: "D:\\proj\\a.ts", content: "x" });
    const second = await callTool(stack, "c2", "write", { file_path: "D:\\proj\\b.ts", content: "y" });
    expect(second.human).not.toHaveBeenCalled();
    // 破坏性工具没有族：换一个目标仍然要问
    await callTool(stack, "c3", "rm", { path: "D:\\proj\\a.ts" });
    const destructive = await callTool(stack, "c4", "rm", { path: "D:\\proj\\b.ts" });
    expect(destructive.human).toHaveBeenCalledTimes(1);
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
