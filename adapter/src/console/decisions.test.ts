import { beforeEach, describe, expect, it } from "vitest";
import type { ToolAuditEvent } from "../audit/types.js";
import type { SessionGrantState } from "../capability/sandbox-grant.js";
import type { CapabilityLease, CapabilityScope } from "../capability/types.js";
import { buildDecisions, describeCapability, summarizeDecisions } from "./decisions.js";
let now = 1_000_000;
const scope: CapabilityScope = { kind: "sandbox-escalation", key: "abcdef123456", display: "tool=pwsh 沙箱升级至 danger-full-access" };
function lease(overrides: Partial<CapabilityLease> = {}): CapabilityLease {
  // 作用：构造一条最简 Lease（默认：沙箱授权、300 秒、生效中）
  return {
    id: "lease-1",
    kind: "sandbox-mode",
    sessionId: "s1",
    toolName: "pwsh",
    scope,
    issuedAt: 1_000_000,
    expiresAt: 1_300_000,
    status: "ACTIVE",
    ...overrides,
  };
}
function event(decision: ToolAuditEvent["decision"], overrides: Partial<ToolAuditEvent> = {}): ToolAuditEvent {
  // 作用：构造一条审计事件（默认：同一会话/工具/授权）
  return { id: `${decision}-${Math.random()}`, timestamp: 1_000_000, sessionId: "s1", callId: "c1", rootCallId: "c1", toolName: "pwsh", leaseId: "lease-1", decision, ...overrides };
}
beforeEach(() => {
  now = 1_100_000;
});
describe("授权决策日志（把事件流折叠成一条授权一份记录）", () => {
  it("复用次数被聚合成一个数字：3 条 LEASE_REUSED → uses=3，且计入「少点的批准次数」", () => {
    const records = buildDecisions({
      leases: [lease()],
      events: [event("LEASE_ISSUED"), event("LEASE_REUSED", { timestamp: 1_010_000 }), event("LEASE_REUSED", { timestamp: 1_020_000 }), event("LEASE_REUSED", { timestamp: 1_030_000 })],
      now,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.uses).toBe(3);
    expect(records[0]?.lastUsedAt).toBe(1_030_000);
    expect(records[0]?.outcome).toBe("active");
    expect(summarizeDecisions(records)).toMatchObject({ total: 1, active: 1, savedApprovals: 3 });
  });
  it("被提前收回：outcome=revoked、结束时间取撤销时间、窗口时长按实际放开时间算", () => {
    const revoked = lease({ status: "REVOKED", revokedAt: 1_050_000, revokeReason: "用户提前收回" });
    const records = buildDecisions({ leases: [revoked], events: [event("LEASE_ISSUED"), event("LEASE_REVOKED")], now });
    expect(records[0]).toMatchObject({ outcome: "revoked", endedAt: 1_050_000, windowMs: 50_000, revokedReason: "用户提前收回" });
  });
  it("自然到期：outcome=expired、结束时间取到期时间", () => {
    const expired = lease({ status: "EXPIRED" });
    now = 1_400_000;
    const records = buildDecisions({ leases: [expired], events: [event("LEASE_ISSUED")], now });
    expect(records[0]).toMatchObject({ outcome: "expired", endedAt: 1_300_000, windowMs: 300_000 });
  });
  it("权限级别效果：提升→恢复串起来；用户改过时标记 skipped；结束但没恢复计入待收回", () => {
    const grantState: SessionGrantState = {
      sessionId: "s1",
      baseline: "workspace-write",
      lastWritten: "danger-full-access",
      currentMode: "workspace-write",
      status: "restored",
      liveCount: 0,
      staleCount: 0,
      grants: [{ leaseId: "lease-1", toolName: "pwsh", requestedMode: "danger-full-access", writtenMode: "danger-full-access", raised: true, live: false }],
    };
    const restored = buildDecisions({
      leases: [lease({ status: "EXPIRED" })],
      events: [event("LEASE_ISSUED"), event("SANDBOX_MODE_RAISED"), event("SANDBOX_MODE_RESTORED", { scopeDisplay: "沙箱模式回滚至 workspace-write" })],
      grantStates: [grantState],
      now: 1_400_000,
    });
    expect(restored[0]?.sandbox).toMatchObject({ requestedMode: "danger-full-access", raisedTo: "danger-full-access", restoredTo: "workspace-write" });
    expect(summarizeDecisions(restored).pendingRestore).toBe(0);
    // 没有任何恢复/跳过记录 → 视为「该收回但还没收回」
    const pending = buildDecisions({ leases: [lease({ status: "EXPIRED" })], events: [event("LEASE_ISSUED"), event("SANDBOX_MODE_RAISED")], grantStates: [grantState], now: 1_400_000 });
    expect(summarizeDecisions(pending).pendingRestore).toBe(1);
  });
  it("按会话 / 工具过滤，并限制条数（最新批准在前）", () => {
    const older = lease({ id: "lease-old", issuedAt: 900_000, expiresAt: 1_200_000, sessionId: "s2" });
    const newer = lease({ id: "lease-new", toolName: "bash", issuedAt: 1_050_000, expiresAt: 1_350_000, sessionId: "s1" });
    const all = buildDecisions({ leases: [older, newer], events: [], now });
    expect(all.map((record) => record.leaseId)).toEqual(["lease-new", "lease-old"]);
    expect(buildDecisions({ leases: [older, newer], events: [], now, sessionId: "s2" }).map((record) => record.leaseId)).toEqual(["lease-old"]);
    expect(buildDecisions({ leases: [older, newer], events: [], now, toolName: "bash" }).map((record) => record.leaseId)).toEqual(["lease-new"]);
    expect(buildDecisions({ leases: [older, newer], events: [], now, limit: 1 })).toHaveLength(1);
  });
  it("能力文案是人话，且不泄露 Scope 哈希", () => {
    expect(describeCapability(lease(), "danger-full-access")).toBe("pwsh 可以免审批升到「完全访问」");
    expect(describeCapability(lease({ kind: "universal", scope: { kind: "exact-arguments", key: "hash", display: "d" } }))).toContain("完全一致");
    expect(describeCapability(lease(), "danger-full-access")).not.toContain(scope.key);
  });
});
