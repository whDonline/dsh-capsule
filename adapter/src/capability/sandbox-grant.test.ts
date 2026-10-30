import { beforeEach, describe, expect, it } from "vitest";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { SandboxGrantManager, type SandboxContext } from "./sandbox-grant.js";
import type { SandboxMode } from "./escalation.js";
import type { CapabilityScope } from "./types.js";
let now = 1_000_000;
const clock = () => now;
// 作用：测试用宿主桩——记录每次模式写入，保证「何时写、写了什么、写了几次」都可断言。
// 真实实现接收 Session 对象，这里用 sessionId 字符串本身充当对象，断言即可按 id 直接查表。
function makeSandboxHost(initial: SandboxMode = "workspace-write") {
  const modes = new Map<string, SandboxMode>();
  const writes: { sessionId: string; mode: SandboxMode }[] = [];
  const host: SandboxContext = {
    sessionSandboxMode: (session) => modes.get(session as string) ?? initial,
    setSessionSandboxMode: (session, mode) => {
      modes.set(session as string, mode);
      writes.push({ sessionId: session as string, mode });
    },
  };
  return { host, writes, modes, modeOf: (sessionId: string) => modes.get(sessionId) };
}
const scope: CapabilityScope = { kind: "sandbox-escalation", key: "k", display: "d" };
async function seedLease(leases: LeaseManager, sessionId: string, ttlSeconds = 60) {
  return await leases.issue({ sessionId, toolName: "pwsh", scope, ttlSeconds, kind: "sandbox-mode", sourceCallId: "c1" });
}
beforeEach(() => {
  now = 1_000_000;
});
describe("SandboxGrantManager 提升（P0-2）", () => {
  it("批准后提升会话模式，并记录 baseline（提升前的模式）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    const result = await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(result).toEqual({ outcome: "RAISED", mode: "danger-full-access", baselineMode: "workspace-write" });
    expect(writes).toEqual([{ sessionId: "s1", mode: "danger-full-access" }]);
    expect(modeOf("s1")).toBe("danger-full-access");
  });
  it("同一 Lease 重复提升是幂等的：只写一次 session log", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    const second = await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(second.outcome).toBe("UNCHANGED");
    expect(writes).toHaveLength(1);
  });
  it("当前模式已足够宽时不写 session log（避免无意义的模式抖动）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes } = makeSandboxHost("danger-full-access");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    const result = await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(result.outcome).toBe("UNCHANGED");
    expect(writes).toHaveLength(0);
  });
  it("窄目标不降级宽模式：read-only 请求在 workspace-write 会话里保持原模式", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    const result = await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "read-only" });
    expect(result.outcome).toBe("UNCHANGED");
    expect(writes).toHaveLength(0);
  });
  it("多条授权并存：新授权不会把已放宽的模式降级（取最宽需求）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes, modeOf } = makeSandboxHost("read-only");
    const grants = new SandboxGrantManager(host, leases);
    const wide = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: wide.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    const narrow = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: narrow.id, sessionId: "s1", session: "s1", toolName: "write", requestedMode: "workspace-write" });
    expect(modeOf("s1")).toBe("danger-full-access");
    expect(writes).toEqual([{ sessionId: "s1", mode: "danger-full-access" }]);
  });
});
describe("SandboxGrantManager 回滚（P0-2）", () => {
  it("撤销 Lease 后回滚到 baseline", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    await leases.revoke(lease.id, "test");
    const result = await grants.releaseGrant(lease.id);
    expect(result).toEqual({ outcome: "RESTORED", mode: "workspace-write" });
    expect(modeOf("s1")).toBe("workspace-write");
    expect(writes.map((w) => w.mode)).toEqual(["danger-full-access", "workspace-write"]);
  });
  it("TTL 到期后回滚到 baseline", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1", 60);
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    now += 61_000;
    const result = await grants.releaseGrant(lease.id);
    expect(result?.outcome).toBe("RESTORED");
    expect(modeOf("s1")).toBe("workspace-write");
  });
  it("【红线 2】用户手动改过模式 → 跳过回滚并报告 SKIPPED_USER_OVERRIDE", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes, modes, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    modes.set("s1", "read-only");
    const writesBefore = writes.length;
    const result = await grants.releaseGrant(lease.id);
    expect(result).toEqual({ outcome: "SKIPPED_USER_OVERRIDE", mode: "read-only" });
    expect(modeOf("s1")).toBe("read-only");
    expect(writes).toHaveLength(writesBefore);
  });
  it("【红线 2】用户放宽了模式（≥ Guard 写入值）同样视为用户选择，不强制回滚", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modes } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    modes.set("s1", "workspace-write");
    const result = await grants.releaseGrant(lease.id);
    expect(result).toEqual({ outcome: "SKIPPED_USER_OVERRIDE", mode: "workspace-write" });
  });
  it("部分回滚 + 冲突检测基准：窄授权（未真正提升）释放时不得把 Guard 自己的写入误判为用户改动", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("read-only");
    const grants = new SandboxGrantManager(host, leases);
    const wide = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: wide.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    const narrow = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: narrow.id, sessionId: "s1", session: "s1", toolName: "write", requestedMode: "workspace-write" });
    expect(modeOf("s1")).toBe("danger-full-access");
    const narrowResult = await grants.releaseGrant(narrow.id);
    expect(narrowResult?.outcome).toBe("UNCHANGED");
    expect(modeOf("s1")).toBe("danger-full-access");
    const wideResult = await grants.releaseGrant(wide.id);
    expect(wideResult).toEqual({ outcome: "RESTORED", mode: "read-only" });
    expect(modeOf("s1")).toBe("read-only");
  });
  it("已有授权期间用户抢改模式 → 后续提升请求被跳过（不覆盖用户选择）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modes, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const first = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: first.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    modes.set("s1", "read-only");
    const second = await seedLease(leases, "s1");
    const result = await grants.applyGrant({ leaseId: second.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(result).toEqual({ outcome: "SKIPPED_USER_OVERRIDE", mode: "read-only" });
    expect(modeOf("s1")).toBe("read-only");
  });
  it("从未真正提升过的 Lease 释放时无事发生（不写 session log）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, writes } = makeSandboxHost("danger-full-access");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    const result = await grants.releaseGrant(lease.id);
    expect(result?.outcome).toBe("UNCHANGED");
    expect(writes).toHaveLength(0);
  });
  it("无授权记录的 leaseId 释放返回 undefined", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host } = makeSandboxHost();
    const grants = new SandboxGrantManager(host, leases);
    expect(await grants.releaseGrant("never-seen")).toBeUndefined();
  });
});
describe("SandboxGrantManager 结算（P0-2）", () => {
  it("lease 已过期时 settle 回收模式", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1", 60);
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    now += 61_000;
    const results = await grants.settle();
    expect(results).toEqual([{ outcome: "RESTORED", mode: "workspace-write" }]);
    expect(modeOf("s1")).toBe("workspace-write");
    expect(grants.activeGrants()).toHaveLength(0);
  });
  it("lease 被撤销时 settle 回收模式", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("read-only");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "workspace-write" });
    await leases.revokeSession("s1", "user revoke");
    expect((await grants.settle()).map((r) => r.outcome)).toEqual(["RESTORED"]);
    expect(modeOf("s1")).toBe("read-only");
  });
  it("仍然有效的 Lease 不被 settle 回收（授权保持生效）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1", 600);
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(await grants.settle()).toEqual([]);
    expect(modeOf("s1")).toBe("danger-full-access");
    expect(grants.activeGrants()).toHaveLength(1);
  });
  it("releaseSession 一次性回收该 session 全部授权，且不受其他 session 影响", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host, modeOf } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const a = await seedLease(leases, "s1");
    const b = await seedLease(leases, "s1");
    const c = await seedLease(leases, "s2");
    await grants.applyGrant({ leaseId: a.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "workspace-write" });
    await grants.applyGrant({ leaseId: b.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    await grants.applyGrant({ leaseId: c.id, sessionId: "s2", session: "s2", toolName: "pwsh", requestedMode: "danger-full-access" });
    await grants.releaseSession("s1");
    expect(grants.activeGrants().map((g) => g.sessionId)).toEqual(["s2"]);
    // s1 回落到 Guard 介入前的 workspace-write；s2 的授权不受影响
    expect(modeOf("s1")).toBe("workspace-write");
    expect(modeOf("s2")).toBe("danger-full-access");
  });
  it("activeGrants 是安全只读投影：不含 session/baseline/raised 等内部字段", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const { host } = makeSandboxHost("workspace-write");
    const grants = new SandboxGrantManager(host, leases);
    const lease = await seedLease(leases, "s1");
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(grants.activeGrants()).toEqual([{ leaseId: lease.id, sessionId: "s1", toolName: "pwsh", requestedMode: "danger-full-access", writtenMode: "danger-full-access" }]);
  });
});
