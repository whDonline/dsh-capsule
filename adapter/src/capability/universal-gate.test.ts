import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { DndManager } from "./dnd.js";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import { PendingRegistry } from "./pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./policy.js";
import { ScopeResolver } from "./scope-resolver.js";
import { UniversalGate } from "./universal-gate.js";
let now = 1_000_000;
const clock = () => now;
beforeEach(() => {
  now = 1_000_000;
});
function makeGate(config?: UniversalPolicyConfig) {
  // 作用：组装被测 UniversalGate 及其依赖（注入可控时钟，规格 22.10 模拟时间用）。
  // reuseTtlSeconds 取 60 秒，与策略默认 TTL 对齐，让「TTL 到期」用例的时间推进可读。
  const audit = new AuditService();
  const pending = new PendingRegistry();
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const gate = new UniversalGate({
    policy: new PolicyResolver(config ?? DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending,
    audit,
    settings: { active: true, reuseTtlSeconds: 60 },
    now: clock,
  });
  return { gate, leases, pending, audit };
}
function execOf(callId: string, args: unknown, sessionId = "s1", name = "github_create_issue") {
  // 作用：构造最小 ToolExecution 测试桩
  return { callId, rootCallId: callId, name, arguments: args, agent: { id: sessionId } };
}
const ask = () => Promise.resolve({ kind: "ask" as const, reason: "need confirm" });
const allow = () => Promise.resolve({ kind: "allow" as const });
const deny = () => Promise.resolve({ kind: "deny" as const });
/** 作用：模拟真实顺序——pre-execute 决策 → tools/execute 记录操作 → 审批到达。 */
async function askAndRecord(gate: UniversalGate, callId: string, args: unknown, sessionId = "s1", name = "github_create_issue") {
  const decision = await gate.handlePreExecute(execOf(callId, args, sessionId, name), ask);
  await gate.handleExecute(execOf(callId, args, sessionId, name), async () => ({ ok: true }));
  return decision;
}
async function approveOnce(gate: UniversalGate, callId: string) {
  // 作用：模拟 DSH answerer 返回 allowed-once 的 approval/request 处理
  return await gate.handleApprovalRequest({ callId }, async () => "allowed-once" as const);
}
describe("UniversalGate tools/pre-execute（规格 22 清单）", () => {
  it("22.1 原 ALLOW 不受影响：无 Lease、无 pending、无 ASK 审计", async () => {
    const { gate, pending, audit } = makeGate();
    const out = await gate.handlePreExecute(execOf("c1", {}), allow);
    expect(out.kind).toBe("allow");
    expect(pending.size()).toBe(0);
    expect(audit.list().some((e) => e.decision === "ASK")).toBe(false);
    expect(audit.list().some((e) => e.decision === "PASSTHROUGH_ALLOW")).toBe(true);
  });
  it("22.2 原 DENY 永远不能被 Lease 覆盖：即使存在有效 Lease 仍 deny", async () => {
    const { gate } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await approveOnce(gate, "c1");
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }), deny);
    expect(out.kind).toBe("deny");
  });
  it("22.3 ASK + allowed-once 签发 Lease，且 reason 明确包含 Scope/TTL 信息（规格 4.2）", async () => {
    const { gate, leases } = makeGate();
    const askOut = await askAndRecord(gate, "c1", { repo: "a/b" });
    expect(askOut.kind).toBe("ask");
    expect(askOut.reason).toContain("need confirm");
    expect(askOut.reason).toContain("TTL=60s");
    expect(askOut.reason).toContain("repo");
    expect(askOut.reason).toContain("可主动撤销");
    await approveOnce(gate, "c1");
    const all = await leases.list();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("ACTIVE");
    expect(all[0].sessionId).toBe("s1");
    expect(all[0].sourceCallId).toBe("c1");
    expect(all[0].kind).toBe("universal");
  });
  it("22.4/22.5/22.6 rejected/cancelled/unavailable 均不签发 Lease", async () => {
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
      const { gate, leases } = makeGate();
      await askAndRecord(gate, "c1", { repo: "a/b" });
      const out = await gate.handleApprovalRequest({ callId: "c1" }, async () => outcome);
      expect(out).toBe(outcome);
      expect(await leases.list()).toHaveLength(0);
    }
  });
  it("22.7 Lease Reuse：同 Session + 同 Tool + 同 Scope + TTL 内 ask 直接转 allow", async () => {
    const { gate, audit } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await approveOnce(gate, "c1");
    const again = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }), ask);
    expect(again.kind).toBe("allow");
    expect(audit.list().some((e) => e.decision === "LEASE_REUSED")).toBe(true);
  });
  it("22.8 Session Isolation：Session A 的 Lease 不能被 Session B 复用", async () => {
    const { gate } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" }, "s1");
    await approveOnce(gate, "c1");
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }, "s2"), ask);
    expect(out.kind).toBe("ask");
  });
  it("22.9 Scope Isolation：exact args 下参数变化重新 Ask", async () => {
    const { gate } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b", title: "A" });
    await approveOnce(gate, "c1");
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b", title: "B" }), ask);
    expect(out.kind).toBe("ask");
  });
  it("22.10 TTL：模拟时间前进超过 TTL 后重新 Ask", async () => {
    const { gate } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await approveOnce(gate, "c1");
    now += 60_001;
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }), ask);
    expect(out.kind).toBe("ask");
  });
  it("22.11 Revoke：撤销后下一次重新 Ask", async () => {
    const { gate, leases } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await approveOnce(gate, "c1");
    const [lease] = await leases.list();
    await leases.revoke(lease.id, "manual");
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b" }), ask);
    expect(out.kind).toBe("ask");
  });
  it("22.12 Parallel Calls：两个并行调用按 callId 隔离，scope/lease 互不串", async () => {
    const { gate, leases, pending } = makeGate();
    const outA = await askAndRecord(gate, "c1", { command: "Get-Date" }, "s1", "pwsh");
    const outB = await askAndRecord(gate, "c2", { command: "Get-Process" }, "s1", "pwsh");
    expect(outA.kind).toBe("ask");
    expect(outB.kind).toBe("ask");
    expect(pending.size()).toBe(2);
    await approveOnce(gate, "c1");
    await approveOnce(gate, "c2");
    const all = await leases.list();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((l) => l.scope.key)).size).toBe(2);
    expect(new Set(all.map((l) => l.sourceCallId))).toEqual(new Set(["c1", "c2"]));
  });
  it("22.13 Cancellation：approval 取消后清理待办且无 Lease", async () => {
    const { gate, pending, leases } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "cancelled");
    expect(pending.size()).toBe(0);
    expect(await leases.list()).toHaveLength(0);
  });
  it("22.14 Canonical JSON：key 顺序不同的参数命中同一 Lease", async () => {
    const { gate } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b", title: "x" });
    await approveOnce(gate, "c1");
    const out = await gate.handlePreExecute(execOf("c2", { title: "x", repo: "a/b" }), ask);
    expect(out.kind).toBe("allow");
  });
  it("无 agent/session：保持原始 ask，不接管、不签发（Fail Closed，规则 6）", async () => {
    const { gate, pending, leases } = makeGate();
    const exec = { callId: "c1", rootCallId: "c1", name: "t", arguments: {} };
    const out = await gate.handlePreExecute(exec, ask);
    expect(out.kind).toBe("ask");
    expect(pending.size()).toBe(0);
    expect(await leases.list()).toHaveLength(0);
  });
  it("Approval next 不被调用场景：非 Guard 管理的 callId 透传且不签发", async () => {
    const { gate, leases } = makeGate();
    const out = await gate.handleApprovalRequest({ callId: "unknown" }, async () => "allowed-once");
    expect(out).toBe("allowed-once");
    expect(await leases.list()).toHaveLength(0);
  });
  it("tools/result：记录 TOOL_SUCCESS 并清理 pending", async () => {
    const { gate, pending, audit } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    await approveOnce(gate, "c1");
    gate.handleToolResult(execOf("c1", { repo: "a/b" }), { isError: false });
    expect(pending.size()).toBe(0);
    const success = audit.list().find((e) => e.decision === "TOOL_SUCCESS");
    expect(success).toBeDefined();
    expect(success?.leaseId).toBeTruthy();
    expect(success?.scopeKey).toBeTruthy();
  });
  it("tools/result：错误结果记录 TOOL_ERROR", async () => {
    const { gate, audit } = makeGate();
    await gate.handlePreExecute(execOf("c1", { repo: "a/b" }), ask);
    gate.handleToolResult(execOf("c1", { repo: "a/b" }), { isError: true });
    expect(audit.list().some((e) => e.decision === "TOOL_ERROR")).toBe(true);
  });
  it("AbortSignal：调用取消时 pending 立即清理（规格 6.5）", async () => {
    const { gate, pending } = makeGate();
    const controller = new AbortController();
    const exec = { callId: "c1", rootCallId: "c1", name: "t", arguments: {}, agent: { id: "s1" }, signal: controller.signal };
    await gate.handlePreExecute(exec, ask);
    expect(pending.size()).toBe(1);
    controller.abort();
    expect(pending.size()).toBe(0);
  });
  it("pending 超龄兜底 GC（MAX_PENDING_AGE_MS=10min，规格 6.5）", async () => {
    const { gate, pending } = makeGate();
    await gate.handlePreExecute(execOf("c1", { repo: "a/b" }), ask);
    expect(pending.size()).toBe(1);
    now += 10 * 60 * 1000 + 1;
    await gate.handlePreExecute(execOf("c2", { repo: "x/y" }), ask);
    expect(pending.size()).toBe(1);
  });
  it("fields 策略端到端：配置 paths 后仅指定字段参与复用", async () => {
    const { gate } = makeGate({
      ...DEFAULT_UNIVERSAL_POLICY,
      rules: [{ match: "github_create_issue", scope: { mode: "fields", paths: ["repo"] } }],
    });
    await askAndRecord(gate, "c1", { repo: "a/b", title: "A" });
    await approveOnce(gate, "c1");
    const out = await gate.handlePreExecute(execOf("c2", { repo: "a/b", title: "B" }), ask);
    expect(out.kind).toBe("allow");
    const otherRepo = await gate.handlePreExecute(execOf("c3", { repo: "other/r", title: "A" }), ask);
    expect(otherRepo.kind).toBe("ask");
  });
  it("规则 disabled 的 Tool：ask 原样透传不接管", async () => {
    const { gate, pending } = makeGate({
      ...DEFAULT_UNIVERSAL_POLICY,
      rules: [{ match: "github_create_issue", enabled: false }],
    });
    const out = await gate.handlePreExecute(execOf("c1", { repo: "a/b" }), ask);
    expect(out.kind).toBe("ask");
    expect(out.reason).toBe("need confirm");
    expect(pending.size()).toBe(0);
  });
  it("P0-3 不变量：approval/request 处理器只观察、绝不合成 outcome——sentinel 必须原样（同一引用）返回", async () => {
    const { gate, leases, pending } = makeGate();
    await askAndRecord(gate, "c1", { repo: "a/b" });
    const sentinel = Object.freeze({ decision: "allowed-once" });
    const spy = vi.fn(async () => sentinel);
    const out = await gate.handleApprovalRequest({ callId: "c1" }, spy);
    expect(out).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await leases.list()).toHaveLength(1);
    expect(pending.get("c1")?.decision).toBe("APPROVED");
  });
  it("P0-3 不变量：rejected / cancelled / unavailable / allowed-once 四种下游结果全部原样引用返回", async () => {
    for (const decision of ["allowed-once", "rejected", "cancelled", "unavailable"]) {
      const { gate } = makeGate();
      await askAndRecord(gate, "c1", { repo: "a/b" });
      const sentinel = Object.freeze({ decision });
      const out = (await gate.handleApprovalRequest({ callId: "c1" }, async () => sentinel)) as unknown as object;
      expect(out).toBe(sentinel);
    }
  });
  it("P0-3 不变量：无记录（Guard 未接管）的 callId 必须原样透传下游结果且不签发 Lease", async () => {
    const { gate, leases } = makeGate();
    const sentinel = Object.freeze({ decision: "allowed-once" });
    const out = await gate.handleApprovalRequest({ callId: "unmanaged" }, async () => sentinel);
    expect(out).toBe(sentinel);
    expect(await leases.list()).toHaveLength(0);
  });
  it("P0-3 不变量：签发失败也不得改写下游 outcome（Fail Closed）", async () => {
    const { gate } = makeGate();
    const deps = (gate as unknown as { deps: { leases: LeaseManager } }).deps;
    await askAndRecord(gate, "c1", { repo: "a/b" });
    const originalIssue = deps.leases.issue.bind(deps.leases);
    deps.leases.issue = async () => {
      throw new Error("LEASE_TTL_INVALID: forged for test");
    };
    const sentinel = Object.freeze({ decision: "allowed-once" });
    const out = (await gate.handleApprovalRequest({ callId: "c1" }, async () => sentinel)) as unknown as object;
    expect(out).toBe(sentinel);
    deps.leases.issue = originalIssue;
  });
  it("install：注册四个 hook（前三个 prepend，含 tools/execute）且 dispose 正常", () => {
    const { gate, pending } = makeGate();
    const registrations: { event: string; options?: { prepend?: boolean } }[] = [];
    const disposers: (() => void)[] = [];
    const bus = {
      on: (event: string, _handler: unknown, options?: { prepend?: boolean }) => {
        registrations.push({ event, options });
        const disposer = () => {};
        disposers.push(disposer);
        return disposer;
      },
    };
    const dispose = gate.install(bus as never);
    expect(registrations.map((r) => r.event)).toEqual(["tools/pre-execute", "tools/execute", "approval/request", "tools/result"]);
    expect(registrations[0].options).toEqual({ prepend: true });
    expect(registrations[1].options).toEqual({ prepend: true });
    expect(registrations[2].options).toEqual({ prepend: true });
    expect(registrations[3].options).toBeUndefined();
    expect(disposers).toHaveLength(4);
    expect(() => dispose()).not.toThrow();
    expect(pending.size()).toBe(0);
  });
});
// 作用：免打扰窗口（2026-11-01 定稿）的 Gate 接线——窗口内只自动放行带 requestedMode 的升级。
describe("UniversalGate 免打扰窗口（限时完全访问的审批放行层）", () => {
  function makeDndGate() {
    const audit = new AuditService();
    const pending = new PendingRegistry();
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const dnd = new DndManager({
      audit,
      modeOf: () => "workspace-write",
      maxWindowMs: () => 1_800_000,
      now: clock,
    });
    const gate = new UniversalGate({
      policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
      scopes: new ScopeResolver(),
      leases,
      pending,
      audit,
      settings: { active: true, reuseTtlSeconds: 1800 },
      dnd,
      now: clock,
    });
    return { gate, dnd, audit, leases };
  }
  const escalationArgs = { command: "npm install -g foo", sandbox_permissions: "danger-full-access", justification: "需要写工作区外的全局目录" };
  it("窗口内：带 requestedMode 的升级自动 allowed-once，不调用人类答话器、不签发 Lease", async () => {
    const { gate, dnd, audit, leases } = makeDndGate();
    await gate.handleExecute(execOf("c1", escalationArgs, "s1", "pwsh"), async () => ({}));
    dnd.start("s1", 900);
    const next = vi.fn(async () => "rejected" as const);
    const out = await gate.handleApprovalRequest({ callId: "c1", toolName: "pwsh", agent: { id: "s1" } }, next);
    expect(out).toBe("allowed-once");
    expect(next).not.toHaveBeenCalled();
    expect(await leases.list()).toHaveLength(0);
    expect(audit.list().some((event) => event.decision === "DND_ALLOWED" && event.sessionId === "s1")).toBe(true);
  });
  it("没有窗口时：照旧交还人类，allowed-once 后签发短期授权", async () => {
    const { gate, leases } = makeDndGate();
    await gate.handleExecute(execOf("c1", escalationArgs, "s1", "pwsh"), async () => ({}));
    const next = vi.fn(async () => "allowed-once" as const);
    const out = await gate.handleApprovalRequest({ callId: "c1", toolName: "pwsh", agent: { id: "s1" } }, next);
    expect(out).toBe("allowed-once");
    expect(next).toHaveBeenCalledTimes(1);
    expect(await leases.list()).toHaveLength(1);
  });
  it("窗口内：没有 requestedMode 的审批不被接管（免打扰只放行沙箱升级）", async () => {
    const { gate, dnd, audit } = makeDndGate();
    await gate.handleExecute(execOf("c1", { command: "dir" }, "s1", "pwsh"), async () => ({}));
    dnd.start("s1", 900);
    const next = vi.fn(async () => "rejected" as const);
    const out = await gate.handleApprovalRequest({ callId: "c1", toolName: "pwsh", agent: { id: "s1" } }, next);
    expect(out).toBe("rejected");
    expect(next).toHaveBeenCalledTimes(1);
    expect(audit.list().some((event) => event.decision === "DND_ALLOWED")).toBe(false);
  });
  it("窗口到期后：恢复委派", async () => {
    const { gate, dnd } = makeDndGate();
    await gate.handleExecute(execOf("c1", escalationArgs, "s1", "pwsh"), async () => ({}));
    dnd.start("s1", 60);
    now += 60_000;
    const next = vi.fn(async () => "rejected" as const);
    const out = await gate.handleApprovalRequest({ callId: "c1", toolName: "pwsh", agent: { id: "s1" } }, next);
    expect(out).toBe("rejected");
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("窗口只作用于本会话：别的会话仍然委派", async () => {
    const { gate, dnd } = makeDndGate();
    await gate.handleExecute(execOf("c1", escalationArgs, "s1", "pwsh"), async () => ({}));
    dnd.start("s2", 900);
    const next = vi.fn(async () => "rejected" as const);
    const out = await gate.handleApprovalRequest({ callId: "c1", toolName: "pwsh", agent: { id: "s1" } }, next);
    expect(out).toBe("rejected");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
