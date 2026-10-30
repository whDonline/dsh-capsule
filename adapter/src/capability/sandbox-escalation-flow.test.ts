import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { PendingRegistry } from "./pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./policy.js";
import { SandboxGrantManager, type SandboxContext } from "./sandbox-grant.js";
import { ScopeResolver } from "./scope-resolver.js";
import { UniversalGate } from "./universal-gate.js";
import type { SandboxMode } from "./escalation.js";
import type { PreToolDecision } from "./types.js";
let now = 1_000_000;
const clock = () => now;
const ESCALATION_ARGS = (justification: string) => ({ command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification });
// 作用：P0-2 配置——只对 pwsh 启用沙箱升级 Scope（这是"不配置就不接管"的显式启用形态）
function sandboxPolicy(overrides: Partial<UniversalPolicyConfig> = {}): UniversalPolicyConfig {
  return {
    ...DEFAULT_UNIVERSAL_POLICY,
    ...overrides,
    rules: overrides.rules ?? [{ match: "pwsh", scope: { mode: "sandbox-escalation" }, ttlSeconds: 300 }],
  };
}
function makeHost(initial: SandboxMode = "workspace-write") {
  // 作用：以【session 对象】为键记录模式——真实实现正是如此（Session 对象即身份）。
  // 测试里用 sessionId 字符串本身充当 session 对象，因此断言走 modeOf / setModeFor
  const modes = new Map<unknown, SandboxMode>();
  const writes: SandboxMode[] = [];
  const sessionFor = (sessionId: string) => sessionId;
  const host: SandboxContext = {
    sessionSandboxMode: (session) => modes.get(session) ?? initial,
    setSessionSandboxMode: (session, mode) => {
      modes.set(session, mode);
      writes.push(mode);
    },
  };
  return { host, writes, sessionFor, modeOf: (sessionId: string) => modes.get(sessionFor(sessionId)), setModeFor: (sessionId: string, mode: SandboxMode) => modes.set(sessionFor(sessionId), mode) };
}
function makeStack(config: UniversalPolicyConfig = sandboxPolicy(), initial: SandboxMode = "workspace-write") {
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const pending = new PendingRegistry();
  const audit = new AuditService();
  const { host, writes, sessionFor, modeOf, setModeFor } = makeHost(initial);
  const sandboxGrants = new SandboxGrantManager(host, leases);
  const gate = new UniversalGate({ policy: new PolicyResolver(config), scopes: new ScopeResolver(), leases, pending, audit, sandboxGrants, now: clock });
  return { gate, leases, pending, audit, sandboxGrants, writes, sessionFor, modeOf, setModeFor };
}
const execOf = (callId: string, args: unknown, sessionId = "s1", name = "pwsh") => ({ callId, rootCallId: callId, name, arguments: args, agent: { id: sessionId, session: sessionId } });
const echo = () => Promise.resolve("tool-result");
const approveOnce = () => Promise.resolve("allowed-once" as const);
beforeEach(() => {
  now = 1_000_000;
});
describe("P0-2 沙箱升级主链路（tools/execute → approval/request → 模式提升）", () => {
  it("批准一次后签发 sandbox-mode Lease 且提升会话模式", async () => {
    const { gate, leases, modeOf } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("需要写入工作区外文件")), echo);
    const outcome = await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(outcome).toBe("allowed-once");
    const all = await leases.list();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("sandbox-mode");
    expect(all[0].scope.kind).toBe("sandbox-escalation");
    // TTL 由策略规则决定（300s）——Lease 本身只存 issuedAt/expiresAt
    expect(all[0].expiresAt - all[0].issuedAt).toBe(300_000);
    expect(modeOf("s1")).toBe("danger-full-access");
  });
  it("【核心价值】第二次同类升级（参数与理由都不同）不再签发新 Lease，复用同一授权", async () => {
    const { gate, leases, modeOf, writes } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("第一次理由")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(modeOf("s1")).toBe("danger-full-access");
    expect(writes).toEqual(["danger-full-access"]);
    // 参数与理由都与第一次不同，但 Scope 只按 (toolName, 目标模式) 取键 → 命中同一 Lease
    expect(await gate.handleExecute(execOf("c2", ESCALATION_ARGS("完全不同的第二次理由")), echo)).toBe("tool-result");
    const all = await leases.list();
    expect(all).toHaveLength(1);
    expect(all[0].sourceCallId).toBe("c1");
    // 第二次调用无需审批，且模式已在目标档位 → 不再写 session log
    expect(writes).toEqual(["danger-full-access"]);
  });
  it("会话模式被降回后，命中 Lease 会重新提升（自愈，无需再问用户）", async () => {
    const { gate, leases, modeOf, writes, sandboxGrants } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    // 清理 Guard 的记录（模拟会话内模式被收回），但 Lease 仍在有效期内
    await sandboxGrants.releaseSession("s1");
    expect(modeOf("s1")).toBe("workspace-write");
    expect((await leases.list())[0].status).toBe("ACTIVE");
    await gate.handleExecute(execOf("c3", ESCALATION_ARGS("再次需要")), echo);
    expect(modeOf("s1")).toBe("danger-full-access");
    expect(writes).toEqual(["danger-full-access", "workspace-write", "danger-full-access"]);
    expect((await leases.list()).length).toBe(1);
  });
  it("rejected / cancelled / unavailable 三种非批准结果：不签发 Lease、不提升模式", async () => {
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
      now = 1_000_000;
      const { gate, leases, modeOf, writes } = makeStack();
      await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
      const returned = await gate.handleApprovalRequest({ callId: "c1" }, async () => outcome);
      expect(returned).toBe(outcome);
      expect(await leases.list()).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(modeOf("s1")).toBeUndefined();
    }
  });
  it("未命中沙箱升级 Scope 策略的工具：不记录、不签发、原样透传", async () => {
    const { gate, leases, writes } = makeStack(sandboxPolicy({ rules: [{ match: "write", scope: { mode: "sandbox-escalation" } }] }));
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    const outcome = await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(outcome).toBe("allowed-once");
    expect(await leases.list()).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
  it("全局 enabled=false：完全不动沙箱（不记录、不提升）", async () => {
    const { gate, leases, writes } = makeStack(sandboxPolicy({ enabled: false }));
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
  it("普通调用（无升级参数）不产生任何授权副作用，且结果原样返回", async () => {
    const { gate, leases, writes, audit } = makeStack();
    expect(await gate.handleExecute(execOf("c1", { command: "Get-Date" }), echo)).toBe("tool-result");
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(audit.list().some((e) => e.decision === "SANDBOX_MODE_RAISED")).toBe(false);
  });
  it("Lease 签发失败：不提升模式（提升与签发是同一原子语义，Fail Closed）", async () => {
    const { gate, leases, writes } = makeStack();
    const issue = vi.spyOn(leases, "issue").mockRejectedValue(new Error("LEASE_TTL_INVALID: forged"));
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    const outcome = await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(outcome).toBe("allowed-once");
    expect(writes).toHaveLength(0);
    issue.mockRestore();
  });
  it("会话模式已足够宽时不再写 session log（不产生无意义的模式事件）", async () => {
    const { gate, leases, writes } = makeStack(sandboxPolicy(), "danger-full-access");
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });
  it("tools/result 清理待批准上下文，但已签发的会话级 Lease 不随单次调用回收", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    gate.handleToolResult(execOf("c1", ESCALATION_ARGS("x")), {});
    expect(await leases.list()).toHaveLength(1);
  });
  it("tools/result 后的迟到批准仍在宽限期内生效（真实时序：result 可能早于 approval）", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    gate.handleToolResult(execOf("c1", ESCALATION_ARGS("x")), { isError: true });
    // 实测存在 tools/result 早于 approval/request 到达的时序，因此不能立刻丢弃上下文；
    // 用户确实批准了这次请求，签发其专属（toolName × 目标模式）授权符合其意图
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
  });
  it("上下文被结算回收后，迟到很久的批准不再签发任何授权", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    gate.handleToolResult(execOf("c1", ESCALATION_ARGS("x")), {});
    now += 301_000; // 超过 TTL：下一次 tools/execute 触发结算，回收该升级上下文
    await gate.handleExecute(execOf("c2", { command: "Get-Date" }), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(0);
  });
  it("【P0-5】审批发起者 session 与上下文不一致：拒绝接管，不签发任何授权", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x"), "s1"), echo);
    const outcome = await gate.handleApprovalRequest({ callId: "c1", agent: { id: "s2" } }, approveOnce);
    expect(outcome).toBe("allowed-once"); // outcome 仍原样透传（不变量）
    expect(await leases.list()).toHaveLength(0); // 但绝不为 s1 的上下文签发给 s2 的批准
  });
  it("【P0-5】审批发起者与上下文一致时正常签发", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x"), "s1"), echo);
    await gate.handleApprovalRequest({ callId: "c1", agent: { id: "s1" } }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
  });
  it("【P0-5】载荷 agent 形状不可判定（缺失/非对象）时按不校验处理，正常签发", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x"), "s1"), echo);
    await gate.handleApprovalRequest({ callId: "c1", agent: "not-an-agent" }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
  });
  it("【P0-5】已消费的升级上下文不可被同一 callId 重放签发第二条 Lease", async () => {
    const { gate, leases } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
  });
});
describe("P0-2 授权回收（settle 与回滚）", () => {
  it("Lease 到期后，下一次 tools/execute 回收模式（不依赖任何定时器）", async () => {
    const { gate, leases, modeOf } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(modeOf("s1")).toBe("danger-full-access");
    now += 301_000;
    await gate.handleExecute(execOf("c2", { command: "Get-Date" }), echo);
    expect(modeOf("s1")).toBe("workspace-write");
    expect((await leases.list())[0].status).toBe("EXPIRED");
  });
  it("revoke 后下一次 tools/execute 回收模式", async () => {
    const { gate, leases, modeOf } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    await leases.revoke((await leases.list())[0].id, "user revoke");
    await gate.handleExecute(execOf("c2", { command: "Get-Date" }), echo);
    expect(modeOf("s1")).toBe("workspace-write");
  });
  it("【红线 2】用户手动改动模式后，回收路径跳过回滚并留审计", async () => {
    const { gate, leases, modeOf, setModeFor, audit } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    setModeFor("s1", "read-only");
    for (const lease of (await leases.list()).filter((item) => item.status === "ACTIVE")) await leases.revoke(lease.id, "user revoke");
    await gate.handleExecute(execOf("c2", { command: "Get-Date" }), echo);
    expect(modeOf("s1")).toBe("read-only");
    expect(audit.list().some((e) => e.decision === "SANDBOX_MODE_SKIPPED_USER_OVERRIDE")).toBe(true);
  });
  it("提升与回滚都写审计（可回答「权限何时放宽、放宽到哪一档、何时收回」）", async () => {
    const { gate, leases, audit } = makeStack();
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    const raised = audit.list().filter((e) => e.decision === "SANDBOX_MODE_RAISED");
    expect(raised).toHaveLength(1);
    expect(raised[0].scopeDisplay).toContain("danger-full-access");
    now += 301_000;
    await gate.handleExecute(execOf("c2", { command: "Get-Date" }), echo);
    expect(audit.list().some((e) => e.decision === "SANDBOX_MODE_RESTORED")).toBe(true);
    expect((await leases.list())[0].status).toBe("EXPIRED");
  });
});
describe("P0-2 接线不破坏既有语义", () => {
  it("【跨路径一致性】pre-execute 与 tools/execute 对同一次升级推导出同一个 Scope key", async () => {
    // 两条路径必须一致，否则：hook 插件在 pre-execute 让用户批准并签发 Lease 后，
    // 工具体内再次发起沙箱升级时 tools/execute 会因 key 不匹配而找不到 Lease —— 授权静默失效。
    const { gate, leases } = makeStack();
    const args = ESCALATION_ARGS("同一次升级");
    const ask = (): Promise<PreToolDecision> => Promise.resolve({ kind: "ask" as const, reason: "需确认" });
    const pre = await gate.handlePreExecute(execOf("c1", args), ask);
    expect(pre.kind).toBe("ask");
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    const all = await leases.list();
    expect(all).toHaveLength(1);
    // 工具体内再次升级：命中同一 Lease（不再签发新的），说明两条路径的 key 完全一致
    await gate.handleExecute(execOf("c2", args), echo);
    const after = await leases.list();
    expect(after).toHaveLength(1);
    expect(after[0].scope.kind).toBe("sandbox-escalation");
  });

  it("tools/execute 始终原样返回下游结果（不否决、不改写）", async () => {
    const { gate } = makeStack();
    const sentinel = Object.freeze({ ok: true });
    expect(await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), async () => sentinel)).toBe(sentinel);
    expect(await gate.handleExecute(execOf("c2", { command: "x" }), async () => sentinel)).toBe(sentinel);
  });
  it("未注入 sandboxGrants 时完全关闭沙箱链路（等价旧行为）", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const gate = new UniversalGate({ policy: new PolicyResolver(sandboxPolicy()), scopes: new ScopeResolver(), leases, pending: new PendingRegistry(), audit: new AuditService(), now: clock });
    await gate.handleExecute(execOf("c1", ESCALATION_ARGS("x")), echo);
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(0);
  });
  it("原 pre-execute ask 路径不受影响（Lease 签发与复用仍然工作）", async () => {
    const { gate, leases } = makeStack(sandboxPolicy({ rules: [] }));
    const ask = (): Promise<PreToolDecision> => Promise.resolve({ kind: "ask" as const, reason: "need confirm" });
    const first = await gate.handlePreExecute(execOf("c1", { repo: "a/b" }), ask);
    expect(first.kind).toBe("ask");
    await gate.handleApprovalRequest({ callId: "c1" }, approveOnce);
    expect(await leases.list()).toHaveLength(1);
    const second = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }), ask);
    expect(second.kind).toBe("allow");
  });
});
