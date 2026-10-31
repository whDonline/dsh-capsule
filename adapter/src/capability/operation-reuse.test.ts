import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { operationFingerprint } from "./operation.js";
import { PendingRegistry } from "./pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "./policy.js";
import { GuardSettings } from "./settings.js";
import { ScopeResolver } from "./scope-resolver.js";
import { UniversalGate } from "./universal-gate.js";
interface Stack {
  gate: UniversalGate;
  leases: LeaseManager;
  audit: AuditService;
  advance: (ms: number) => void;
}
function makeStack(options: { active?: boolean; applyGrant?: ReturnType<typeof vi.fn> } = {}): Stack {
  // 作用：新版语义的最小 Gate——注入 settings 即启用「按操作复用」，且不注入沙箱升级链路
  let now = 1_000;
  const clock = () => now;
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const audit = new AuditService();
  const settings = new GuardSettings({ maxTtlSeconds: 1800 });
  if (options.active === false) settings.update({ enabled: false });
  const gate = new UniversalGate({
    policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    settings,
    // 沙箱升级管理器：新语义下【不允许】被用来提升档位（applyGrant 必须是 0 次调用）
    sandboxGrants: options.applyGrant ? ({ applyGrant: options.applyGrant, grantStates: () => [], lastOutcomeOf: () => undefined, settle: async () => [], restoreSession: async () => [] } as never) : undefined,
    now: clock,
  });
  return { gate, leases, audit, advance: (ms: number) => { now += ms; } };
}
/** 模拟一次工具调用：execute 阶段（Guard 记录指纹）→ 审批阶段（人类/自动） */
async function callTool(stack: Stack, callId: string, args: Record<string, unknown>, approve: () => Promise<"allowed-once" | "rejected"> = async () => "allowed-once") {
  await stack.gate.handleExecute({ callId, name: "pwsh", agent: { id: "s1" }, arguments: args }, async () => "tool-result");
  const human = vi.fn(approve);
  const outcome = await stack.gate.handleApprovalRequest({ callId, agent: { id: "s1" }, toolName: "pwsh" }, human);
  return { outcome, human };
}
describe("① 同操作模式：批准一次，同一条操作不再询问", () => {
  it("第一次批准签发授权；第二次同参数【不调用人类】并记一条复用", async () => {
    const stack = makeStack();
    const first = await callTool(stack, "c1", { command: "Get-Date", sandbox_permissions: "danger-full-access" });
    expect(first.outcome).toBe("allowed-once");
    expect(first.human).toHaveBeenCalledTimes(1);
    expect(await stack.leases.list()).toHaveLength(1);
    const second = await callTool(stack, "c2", { command: "Get-Date", sandbox_permissions: "danger-full-access" });
    expect(second.outcome).toBe("allowed-once");
    // 关键断言：第二次【完全没有惊动人类答话器】
    expect(second.human).not.toHaveBeenCalled();
    expect(stack.audit.list().filter((event) => event.decision === "LEASE_REUSED")).toHaveLength(1);
  });
  it("justification 措辞变化不影响命中（模型每次理由都不一样）", async () => {
    const stack = makeStack();
    await callTool(stack, "c1", { command: "Get-Date", sandbox_permissions: "danger-full-access", justification: "需要看时间" });
    const second = await callTool(stack, "c2", { command: "Get-Date", sandbox_permissions: "danger-full-access", justification: "读一下当前时间" });
    expect(second.human).not.toHaveBeenCalled();
  });
  it("参数不同（换命令 / 换目标档位）必须重新询问", async () => {
    const stack = makeStack();
    await callTool(stack, "c1", { command: "Get-Date", sandbox_permissions: "danger-full-access" });
    const other = await callTool(stack, "c2", { command: "Get-Process", sandbox_permissions: "danger-full-access" });
    expect(other.human).toHaveBeenCalledTimes(1);
    const otherMode = await callTool(stack, "c3", { command: "Get-Date", sandbox_permissions: "workspace-write" });
    expect(otherMode.human).toHaveBeenCalledTimes(1);
  });
  it("授权过期 / 被撤销后必须重新询问", async () => {
    const stack = makeStack();
    await callTool(stack, "c1", { command: "Get-Date" });
    expect((await stack.leases.list())[0]).toMatchObject({ status: "ACTIVE", expiresAt: 301_000 });
    stack.advance(400_000);
    const expired = await callTool(stack, "c2", { command: "Get-Date" });
    expect(expired.human).toHaveBeenCalledTimes(1);
    // 过期那次会重新签发一条新授权：撤销【所有仍有效的】再验证
    for (const active of (await stack.leases.list()).filter((item) => item.status === "ACTIVE")) {
      await stack.leases.revoke(active.id, "用户收回");
    }
    const revoked = await callTool(stack, "c3", { command: "Get-Date" });
    expect(revoked.human).toHaveBeenCalledTimes(1);
  });
  it("会话不一致 / 没有 execute 记录时必须交给人类", async () => {
    const stack = makeStack();
    await callTool(stack, "c1", { command: "Get-Date" });
    // 会话不一致
    await stack.gate.handleExecute({ callId: "c9", name: "pwsh", agent: { id: "s1" }, arguments: { command: "Get-Date" } }, async () => "ok");
    const otherSession = vi.fn(async () => "allowed-once" as const);
    await stack.gate.handleApprovalRequest({ callId: "c9", agent: { id: "s2" }, toolName: "pwsh" }, otherSession);
    expect(otherSession).toHaveBeenCalledTimes(1);
    // 完全没有 execute 记录（别的插件在 pre-execute 就 ask）
    const noRecord = vi.fn(async () => "allowed-once" as const);
    await stack.gate.handleApprovalRequest({ callId: "c-unknown", agent: { id: "s1" }, toolName: "pwsh" }, noRecord);
    expect(noRecord).toHaveBeenCalledTimes(1);
  });
  it("人类拒绝后不签发、也不复用", async () => {
    const stack = makeStack();
    const rejected = await callTool(stack, "c1", { command: "Get-Date" }, async () => "rejected");
    expect(rejected.outcome).toBe("rejected");
    expect(await stack.leases.list()).toHaveLength(0);
    const nextTime = await callTool(stack, "c2", { command: "Get-Date" });
    expect(nextTime.human).toHaveBeenCalledTimes(1);
  });
  it("【安全】新语义绝不提升会话档位（applyGrant 一次都不调用）", async () => {
    const applyGrant = vi.fn(async () => ({ outcome: "RAISED" }));
    const stack = makeStack({ applyGrant });
    await callTool(stack, "c1", { command: "Get-Date", sandbox_permissions: "danger-full-access" });
    await callTool(stack, "c2", { command: "Get-Date", sandbox_permissions: "danger-full-access" });
    expect(applyGrant).not.toHaveBeenCalled();
    // 签发的授权是「操作授权」而不是「沙箱授权」
    expect((await stack.leases.list())[0].kind).toBe("universal");
  });
  it("用户关闭开关：不记录、不签发、审批照常交给人", async () => {
    const stack = makeStack({ active: false });
    const first = await callTool(stack, "c1", { command: "Get-Date" });
    expect(first.human).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe("allowed-once");
    expect(await stack.leases.list()).toHaveLength(0);
    expect(stack.audit.list()).toHaveLength(0);
  });
  it("操作指纹：参数键序无关、justification 被剔除、目标档位参与", () => {
    const a = operationFingerprint("pwsh", { command: "x", justification: "理由一" });
    const b = operationFingerprint("pwsh", { justification: "理由二", command: "x" });
    expect(a.key).toBe(b.key);
    const withMode = operationFingerprint("pwsh", { command: "x" }, "danger-full-access");
    expect(withMode.key).not.toBe(a.key);
    // 展示串只有参数键名，不含参数值
    expect(a.display).toContain("pwsh");
    expect(a.display).not.toContain("理由一");
  });
});
