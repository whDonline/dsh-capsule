import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import type { SessionGrantState } from "../capability/sandbox-grant.js";
import type { CapabilityScope } from "../capability/types.js";
import { GovernanceConsole } from "./console-service.js";
let now = 1_000_000;
const clock = () => now;
const sandboxScope: CapabilityScope = { kind: "sandbox-escalation", key: "abcdef123456", display: "tool=pwsh 沙箱升级至 danger-full-access" };
const argsScope: CapabilityScope = { kind: "exact-arguments", key: "hashdeadbeef", display: "tool=deploy args=<sha256>" };
function grantState(overrides: Partial<SessionGrantState>): SessionGrantState {
  // 作用：构造会话级沙箱状态投影（默认「没有任何授权」），逐条用例只覆盖需要变化的字段
  return { sessionId: "s1", grants: [], liveCount: 0, staleCount: 0, ...overrides };
}
function makeConsole(options: { describe?: (sessionId: string) => { label: string; source: "title" | "cwd" | "id"; cwd?: string } } = {}) {
  // 作用：构造只依赖内存授权的治理台；沙箱状态用可变数组注入，用例可在签发授权后追加
  const states: SessionGrantState[] = [];
  const audit = new AuditService();
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const gov = new GovernanceConsole({
    audit,
    leases,
    now: clock,
    sandbox: { states: () => states, lastOutcomeOf: () => undefined },
    sessions: options.describe ? { describe: options.describe } : undefined,
  });
  return { gov, leases, audit, states };
}
beforeEach(() => {
  now = 1_000_000;
});
describe("治理台会话视图：授权状态与沙箱状态必须分开", () => {
  it("档位已提升且授权仍有效 → 授权 active、沙箱 raised，并允许立即收回", async () => {
    const { gov, leases, states } = makeConsole();
    const lease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", baseline: "workspace-write", lastWritten: "danger-full-access", currentMode: "danger-full-access", status: "raised", liveCount: 1, grants: [{ leaseId: lease.id, toolName: "pwsh", requestedMode: "danger-full-access", writtenMode: "danger-full-access", raised: true, live: true }] }));
    const snap = await gov.snapshot();
    const view = snap.sessions[0];
    expect(view?.auth.state).toBe("active");
    expect(view?.sandbox.state).toBe("raised");
    expect(view?.sandbox.targetMode).toBe("danger-full-access");
    expect(view?.actions).toEqual({ canRevoke: true, canRestoreSandbox: false });
    expect(snap.focus).toEqual({ sessionId: "s1", source: "recent-activity" });
  });
  it("【核心】授权已到期但档位没回滚 → auth expired + sandbox pending-restore（两个状态不得合并）", async () => {
    const { gov, leases, states } = makeConsole();
    const lease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", baseline: "workspace-write", lastWritten: "danger-full-access", currentMode: "danger-full-access", status: "raised", staleCount: 1, grants: [{ leaseId: lease.id, toolName: "pwsh", requestedMode: "danger-full-access", writtenMode: "danger-full-access", raised: true, live: false }] }));
    now += 301_000;
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.auth.state).toBe("expired");
    expect(view?.sandbox.state).toBe("pending-restore");
    expect(view?.sandbox.currentMode).toBe("danger-full-access");
    expect(view?.actions).toEqual({ canRevoke: false, canRestoreSandbox: true });
  });
  it("用户改过档位 → sandbox user-override，且不给回滚按钮（不得覆盖用户选择）", async () => {
    const { gov, leases, states } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", baseline: "workspace-write", lastWritten: "danger-full-access", currentMode: "read-only", status: "skipped", staleCount: 1 }));
    now += 301_000;
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.sandbox.state).toBe("user-override");
    expect(view?.sandbox.note).toContain("不会覆盖");
    expect(view?.actions.canRestoreSandbox).toBe(false);
  });
  it("读不到当前档位 → sandbox unknown（绝不允许显示「已恢复」）", async () => {
    const { gov, leases, states } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", baseline: "workspace-write", lastWritten: "danger-full-access", status: "raised", liveCount: 1 }));
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.sandbox.state).toBe("unknown");
    expect(view?.sandbox.currentMode).toBeUndefined();
    expect(view?.actions.canRestoreSandbox).toBe(false);
  });
  it("已回滚 → sandbox restored，同时授权展示为已到期", async () => {
    const { gov, leases, states } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", baseline: "workspace-write", lastWritten: "workspace-write", currentMode: "workspace-write", status: "restored" }));
    now += 301_000;
    const view = (await gov.snapshot()).sessions[0];
    expect(view?.sandbox.state).toBe("restored");
    expect(view?.sandbox.currentMode).toBe("workspace-write");
    expect(view?.auth.state).toBe("expired");
  });
});
describe("治理台会话视图：聚焦、命名与降级", () => {
  it("显式指定会话时，即使它没有任何授权也返回空视图（如实回答「本会话没有授权」）", async () => {
    const { gov } = makeConsole({ describe: () => ({ label: "修复登录超时", source: "title", cwd: "D:\\gitpro\\demo" }) });
    const snap = await gov.snapshot({ sessionId: "ghost-session" });
    expect(snap.focus).toEqual({ sessionId: "ghost-session", source: "explicit" });
    expect(snap.sessions[0]).toMatchObject({ sessionId: "ghost-session", label: "修复登录超时", labelSource: "title", cwd: "D:\\gitpro\\demo" });
    expect(snap.sessions[0]?.auth.state).toBe("none");
    expect(snap.sessions[0]?.sandbox.state).toBe("not-involved");
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
  it("能力文案是人话：exact-arguments 说「与上次完全相同的参数」，沙箱授权带上目标档位", async () => {
    const { gov, leases, states } = makeConsole();
    await leases.issue({ sessionId: "s1", toolName: "deploy", scope: argsScope, ttlSeconds: 60 });
    const sandboxLease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: sandboxScope, ttlSeconds: 300, kind: "sandbox-mode" });
    states.push(grantState({ sessionId: "s1", liveCount: 1, grants: [{ leaseId: sandboxLease.id, toolName: "pwsh", requestedMode: "danger-full-access", writtenMode: "danger-full-access", raised: true, live: true }] }));
    const view = (await gov.snapshot()).sessions[0];
    const texts = view?.auth.grants.map((grant) => grant.capabilityText) ?? [];
    expect(texts.join("|")).toContain("与上次完全相同的参数");
    expect(texts.join("|")).toContain("免审批升到「完全访问」");
    // 用户可见文案里不出现内部档位标识（danger-full-access 只能出现在机器字段里）
    expect(texts.join("|")).not.toContain("danger-full-access");
    // 首屏文案里不出现 Scope 哈希原文（哈希只进技术详情的 scopeKeyShort）
    expect(texts.join("|")).not.toContain(sandboxScope.key);
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
