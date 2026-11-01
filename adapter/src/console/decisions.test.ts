import { beforeEach, describe, expect, it } from "vitest";
import type { ToolAuditEvent } from "../audit/types.js";
import type { CapabilityLease, CapabilityScope } from "../capability/types.js";
import { buildDecisions, describeCapability, summarizeDecisions } from "./decisions.js";
let now = 1_000_000;
const scope: CapabilityScope = { kind: "exact-arguments", key: "abcdef123456", display: "pwsh: Get-Date → danger-full-access" };
function lease(overrides: Partial<CapabilityLease> = {}): CapabilityLease {
  // 作用：构造一条最简 Lease（默认：操作授权、300 秒、生效中）
  return {
    id: "lease-1",
    kind: "universal",
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
  it("复用来源分布：精确命中与「凭族放行」分开统计，并给出 Top 族", () => {
    const records = buildDecisions({
      leases: [lease()],
      events: [
        event("LEASE_ISSUED"),
        event("LEASE_REUSED", { timestamp: 1_010_000 }),
        event("LEASE_REUSED", { timestamp: 1_020_000, scopeDisplay: "pwsh: npm install → workspace-write · 凭族放行：同前缀 npm install" }),
        event("LEASE_REUSED", { timestamp: 1_030_000, scopeDisplay: "pwsh: npm install --save → workspace-write · 凭族放行：同前缀 npm install" }),
      ],
      now,
    });
    expect(records[0]?.familyLabel).toBe("同前缀 npm install");
    expect(summarizeDecisions(records)).toMatchObject({
      savedApprovals: 3,
      reuseByKind: { exact: 1, family: 2 },
      topFamilies: [{ label: "同前缀 npm install", count: 2 }],
    });
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
    expect(describeCapability(lease())).toContain("与上次完全一致");
    expect(describeCapability(lease({ scope: { kind: "tool", key: "tool:pwsh", display: "d" } }))).toContain("任何调用都不再询问");
    expect(describeCapability(lease({ scope: { kind: "fields", key: "fields", display: "d" } }))).toContain("相同字段范围");
    expect(describeCapability(lease())).not.toContain(scope.key);
  });
});
