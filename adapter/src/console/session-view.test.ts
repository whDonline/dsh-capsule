import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import type { SandboxMode } from "../capability/escalation.js";
import type { CapabilityScope } from "../capability/types.js";
import { GovernanceConsole } from "./console-service.js";
let now = 1_000_000;
const clock = () => now;
const argsScope: CapabilityScope = { kind: "exact-arguments", key: "hashdeadbeef", display: "tool=deploy args=<sha256>" };
function makeConsole(options: { describe?: (sessionId: string) => { label: string; source: "title" | "cwd" | "id"; cwd?: string }; mode?: (sessionId: string) => SandboxMode | undefined } = {}) {
  // 作用：构造只依赖内存授权的治理台；沙箱档位用只读函数注入（模拟宿主实时读数）
  const audit = new AuditService();
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const gov = new GovernanceConsole({
    audit,
    leases,
    now: clock,
    currentMode: options.mode,
    sessions: options.describe ? { describe: options.describe } : undefined,
  });
  return { gov, leases, audit };
}
beforeEach(() => {
  now = 1_000_000;
});
describe("治理台会话视图：授权状态与宿主档位分开", () => {
  it("授权生效中 → auth active、canRevoke；档位只是宿主读数", async () => {
    const { gov, leases } = makeConsole({ mode: () => "danger-full-access" });
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: argsScope, ttlSeconds: 300 });
    const snap = await gov.snapshot();
    const view = snap.sessions[0];
    expect(view?.auth.state).toBe("active");
    expect(view?.actions).toEqual({ canRevoke: true });
    expect(view?.sandbox).toMatchObject({ currentMode: "danger-full-access", currentModeText: "完全访问" });
    expect(snap.focus).toEqual({ sessionId: "s1", source: "recent-activity" });
  });
  it("授权到期后：auth expired、canRevoke=false；宿主档位不受影响（Guard 从不改写它）", async () => {
    const { gov, leases } = makeConsole({ mode: () => "read-only" });
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: argsScope, ttlSeconds: 300 });
    now += 301_000;
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.auth.state).toBe("expired");
    expect(view?.actions).toEqual({ canRevoke: false });
    expect(view?.sandbox.currentMode).toBe("read-only");
  });
  it("读不到宿主档位 → currentMode 缺失，页面显示「未知」而不是编造", async () => {
    const { gov, leases } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: argsScope, ttlSeconds: 300 });
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.sandbox.currentMode).toBeUndefined();
    expect(view?.sandbox.currentModeText).toBeUndefined();
    expect(typeof view?.sandbox.checkedAt).toBe("number");
  });
});
describe("治理台会话视图：聚焦、命名与降级", () => {
  it("显式指定会话时，即使它没有任何授权也返回空视图（如实回答「本会话没有授权」）", async () => {
    const { gov } = makeConsole({ describe: () => ({ label: "修复登录超时", source: "title", cwd: "D:\\gitpro\\demo" }) });
    const snap = await gov.snapshot({ sessionId: "ghost-session" });
    expect(snap.focus).toEqual({ sessionId: "ghost-session", source: "explicit" });
    expect(snap.sessions[0]).toMatchObject({ sessionId: "ghost-session", label: "修复登录超时", labelSource: "title", cwd: "D:\\gitpro\\demo" });
    expect(snap.sessions[0]?.auth.state).toBe("none");
    expect(snap.sessions[0]?.sandbox.currentMode).toBeUndefined();
  });
  it("会话名解析抛错时降级为短 ID，且不影响快照生成", async () => {
    const { gov, leases } = makeConsole({
      describe: () => {
        throw new Error("boom");
      },
    });
    await leases.issue({ sessionId: "sess-broken", toolName: "t", scope: argsScope, ttlSeconds: 60 });
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.labelSource).toBe("id");
    expect(view?.label).toContain("sess-bro");
  });
  it("默认聚焦最近有活动的会话，较早的会话排在后面", async () => {
    const { gov, leases } = makeConsole();
    await leases.issue({ sessionId: "older", toolName: "t", scope: argsScope, ttlSeconds: 60 });
    now += 1_000;
    await leases.issue({ sessionId: "newer", toolName: "t", scope: argsScope, ttlSeconds: 60 });
    const snap = await gov.snapshot();
    expect(snap.focus.sessionId).toBe("newer");
    expect(snap.sessions.map((view) => view.sessionId)).toEqual(["newer", "older"]);
  });
  it("能力文案是人话：不出现内部标识，也不出现 Scope 哈希原文", async () => {
    const { gov, leases } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "deploy", scope: argsScope, ttlSeconds: 60 });
    const view = (await gov.snapshot()).sessions[0];
    const texts = view?.auth.grants.map((grant) => grant.capabilityText) ?? [];
    expect(texts.join("|")).toContain("与上次完全一致");
    expect(texts.join("|")).not.toContain("exact-arguments");
    expect(texts.join("|")).not.toContain(argsScope.key);
  });
  it("会话统计：复用事件折算成「少点的批准次数」，并随快照返回", async () => {
    const { gov, leases, audit } = makeConsole();
    const lease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: argsScope, ttlSeconds: 300 });
    for (const callId of ["c1", "c2", "c3"]) {
      audit.record({ sessionId: "s1", callId, rootCallId: callId, toolName: "pwsh", leaseId: lease.id, decision: "LEASE_REUSED" });
    }
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.stats.savedApprovals).toBe(3);
    expect(view?.stats.total).toBe(1);
    expect(view?.stats.active).toBe(1);
    // decisions() 与快照口径一致：机器可读的决策日志
    const decisions = await gov.decisions({ sessionId: "s1" });
    expect(decisions.summary.savedApprovals).toBe(3);
    expect(decisions.records[0]).toMatchObject({ leaseId: lease.id, uses: 3, outcome: "active" });
  });
  it("授权剩余时间进入最后 30 秒时状态为 expiring", async () => {
    const { gov, leases } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "t", scope: argsScope, ttlSeconds: 60 });
    now += 45_000;
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.auth.state).toBe("expiring");
    expect(view?.auth.remainingMs).toBe(15_000);
  });
});
