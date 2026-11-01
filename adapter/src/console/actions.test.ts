import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import type { CapabilityScope } from "../capability/types.js";
import { GuardActions } from "./actions.js";
let now = 1_000_000;
const clock = () => now;
const scope: CapabilityScope = { kind: "exact-arguments", key: "k1", display: "pwsh: Get-Date → danger-full-access" };
function makeActions() {
  // 作用：组装「授权 + 审计」——2026-11-01 起动作层只剩撤销授权（不再有档位回滚 / 开窗）
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const audit = new AuditService();
  const actions = new GuardActions({ leases, audit });
  return { leases, audit, actions };
}
beforeEach(() => {
  now = 1_000_000;
});
describe("治理台收缩型动作：立即收回", () => {
  it("撤销该会话全部授权，审计可归属到会话与授权", async () => {
    const { leases, audit, actions } = makeActions();
    const lease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope, ttlSeconds: 300 });
    const result = await actions.revokeSession("s1");
    expect(result.revoked).toBe(1);
    expect((await leases.list())[0]?.status).toBe("REVOKED");
    expect((await leases.list())[0]?.revokeReason).toContain("用户提前收回");
    const revokedEvent = audit.list().find((event) => event.decision === "LEASE_REVOKED");
    expect(revokedEvent).toMatchObject({ sessionId: "s1", leaseId: lease.id, toolName: "pwsh" });
  });
  it("幂等：没有可撤销的授权时不报错", async () => {
    const { actions, leases } = makeActions();
    await leases.issue({ sessionId: "s2", toolName: "t", scope: { kind: "exact-arguments", key: "h", display: "d" }, ttlSeconds: 60 });
    const result = await actions.revokeSession("s2");
    expect(result.revoked).toBe(1);
    const again = await actions.revokeSession("s2");
    expect(again.revoked).toBe(0);
  });
  it("只撤销本会话的授权，别的会话不受影响", async () => {
    const { leases, actions } = makeActions();
    const mine = await leases.issue({ sessionId: "s1", toolName: "t", scope, ttlSeconds: 60 });
    const other = await leases.issue({ sessionId: "s2", toolName: "t", scope, ttlSeconds: 60 });
    await actions.revokeSession("s1");
    const all = await leases.list();
    expect(all.find((lease) => lease.id === mine.id)?.status).toBe("REVOKED");
    expect(all.find((lease) => lease.id === other.id)?.status).toBe("ACTIVE");
  });
  it("非法 sessionId：Fail Closed 直接拒绝", async () => {
    const { actions } = makeActions();
    await expect(actions.revokeSession("")).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
  });
});
