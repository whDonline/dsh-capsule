import { describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { PendingRegistry } from "./pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "./policy.js";
import { ScopeResolver } from "./scope-resolver.js";
import { UniversalGate } from "./universal-gate.js";
function makeGate(active: boolean) {
  // 作用：最小 Gate——只验证「用户开关」这一条分支，其余依赖用真实实现（无沙箱授权链路）
  const leases = new LeaseManager(new MemoryLeaseStore());
  const audit = new AuditService();
  const pending = new PendingRegistry();
  const gate = new UniversalGate({
    policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending,
    audit,
    settings: { active, mode: "same-operation" },
  });
  return { gate, leases, audit };
}
describe("用户开关（settings.active）", () => {
  it("关闭：所有 hook 直接透传，不记 pending、不签发授权、不写审计", async () => {
    const { gate, leases, audit } = makeGate(false);
    const ask = { callId: "c1", name: "pwsh", agent: { id: "s1" }, arguments: { command: "Get-Date" } };
    const decision = await gate.handlePreExecute(ask, async () => ({ kind: "ask", reason: "原生审批" }));
    // 原样返回下游决策，Guard 不改写理由、不加自己的提示
    expect(decision).toEqual({ kind: "ask", reason: "原生审批" });
    const outcome = await gate.handleApprovalRequest({ callId: "c1", agent: { id: "s1" }, toolName: "pwsh" }, async () => "allowed-once");
    expect(outcome).toBe("allowed-once");
    expect(await leases.list()).toHaveLength(0);
    expect(audit.list()).toHaveLength(0);
  });
  it("开启：同样的调用链会签发授权——对照组，证明关闭分支不是「永远不签发」", async () => {
    const { gate, leases } = makeGate(true);
    // 新语义：签发依赖 tools/execute 阶段记录的操作指纹（审批载荷本身没有 arguments）
    await gate.handleExecute({ callId: "c2", name: "pwsh", agent: { id: "s1" }, arguments: { command: "Get-Date" } }, async () => "ok");
    const outcome = await gate.handleApprovalRequest({ callId: "c2", agent: { id: "s1" }, toolName: "pwsh" }, async () => "allowed-once");
    expect(outcome).toBe("allowed-once");
    expect(await leases.list()).toHaveLength(1);
  });
});
