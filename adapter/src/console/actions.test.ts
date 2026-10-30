import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { SandboxGrantManager, type SandboxContext } from "../capability/sandbox-grant.js";
import type { SandboxMode } from "../capability/escalation.js";
import type { CapabilityScope } from "../capability/types.js";
import { GuardActions } from "./actions.js";
let now = 1_000_000;
const clock = () => now;
const scope: CapabilityScope = { kind: "sandbox-escalation", key: "k1", display: "tool=pwsh 沙箱升级至 danger-full-access" };
function makeHost(initial: SandboxMode = "workspace-write") {
  // 作用：沙箱宿主替身——记录模式写入；用 sessionId 字符串充当 session 对象
  const modes = new Map<string, SandboxMode>();
  const writes: { sessionId: string; mode: SandboxMode }[] = [];
  const host: SandboxContext = {
    sessionSandboxMode: (session) => modes.get(session as string) ?? initial,
    setSessionSandboxMode: (session, mode) => {
      modes.set(session as string, mode);
      writes.push({ sessionId: session as string, mode });
    },
  };
  return { host, writes, modes, modeOf: (sessionId: string) => modes.get(sessionId) ?? initial };
}
function makeActions() {
  // 作用：组装「授权 + 沙箱 + 审计」三者，返回被测的收缩型动作与断言所需的句柄
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const audit = new AuditService();
  const { host, writes, modeOf, modes } = makeHost();
  const grants = new SandboxGrantManager(host, leases, clock);
  const actions = new GuardActions({ leases, sandbox: grants, audit, now: clock });
  return { leases, audit, grants, actions, writes, modeOf, modes };
}
beforeEach(() => {
  now = 1_000_000;
});
describe("治理台收缩型动作：立即收回", () => {
  it("撤销该会话全部授权并把档位收回，审计可归属到会话与授权", async () => {
    const { leases, audit, grants, actions, modeOf } = makeActions();
    const lease = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope, ttlSeconds: 300, kind: "sandbox-mode" });
    await grants.applyGrant({ leaseId: lease.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(modeOf("s1")).toBe("danger-full-access");
    const result = await actions.revokeSession("s1");
    expect(result.revoked).toBe(1);
    expect(result.results).toEqual([{ outcome: "RESTORED", mode: "workspace-write" }]);
    expect((await leases.list())[0]?.status).toBe("REVOKED");
    expect((await leases.list())[0]?.revokeReason).toContain("用户提前收回");
    expect(modeOf("s1")).toBe("workspace-write");
    const revokedEvent = audit.list().find((event) => event.decision === "LEASE_REVOKED");
    expect(revokedEvent).toMatchObject({ sessionId: "s1", leaseId: lease.id, toolName: "pwsh" });
    // 回滚事件必须能归属到会话（历史缺陷：这两条事件 sessionId 为空，治理台无法对照两个状态）
    const restoredEvent = audit.list().find((event) => event.decision === "SANDBOX_MODE_RESTORED");
    expect(restoredEvent?.sessionId).toBe("s1");
  });
  it("幂等：没有可撤销的授权时不报错，只做结算", async () => {
    const { actions, leases } = makeActions();
    await leases.issue({ sessionId: "s2", toolName: "t", scope: { kind: "exact-arguments", key: "h", display: "d" }, ttlSeconds: 60 });
    const result = await actions.revokeSession("s2");
    expect(result.revoked).toBe(1);
    const again = await actions.revokeSession("s2");
    expect(again.revoked).toBe(0);
    expect(again.results).toEqual([]);
  });
  it("非法 sessionId：Fail Closed 直接拒绝", async () => {
    const { actions } = makeActions();
    await expect(actions.revokeSession("")).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    await expect(actions.restoreSandbox("")).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
  });
});
describe("治理台收缩型动作：立即回滚档位（独立于撤销授权）", () => {
  it("只结算已失效的授权，仍有效的授权与档位不动", async () => {
    const { leases, grants, actions, modeOf } = makeActions();
    const expired = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope, ttlSeconds: 60, kind: "sandbox-mode" });
    await grants.applyGrant({ leaseId: expired.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "danger-full-access" });
    const live = await leases.issue({ sessionId: "s1", toolName: "pwsh", scope: { kind: "sandbox-escalation", key: "k2", display: "tool=pwsh 沙箱升级至 workspace-write" }, ttlSeconds: 600, kind: "sandbox-mode" });
    await grants.applyGrant({ leaseId: live.id, sessionId: "s1", session: "s1", toolName: "pwsh", requestedMode: "workspace-write" });
    expect(modeOf("s1")).toBe("danger-full-access");
    now += 61_000;
    const result = await actions.restoreSandbox("s1");
    expect(result.results).toEqual([{ outcome: "RESTORED", mode: "workspace-write" }]);
    expect(modeOf("s1")).toBe("workspace-write");
    // 仍有效的授权必须原样保留（这是「回滚档位」与「撤销授权」的区别）
    const after = await leases.list();
    expect(after.find((lease) => lease.id === live.id)?.status).toBe("ACTIVE");
    const again = await actions.restoreSandbox("s1");
    expect(again.results).toEqual([]);
  });
});
