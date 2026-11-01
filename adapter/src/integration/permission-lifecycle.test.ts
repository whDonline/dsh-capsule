import { beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { PendingRegistry } from "../capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "../capability/policy.js";
import { GuardSettings } from "../capability/settings.js";
import { ScopeResolver } from "../capability/scope-resolver.js";
import { UniversalGate } from "../capability/universal-gate.js";
import type { ApprovalOutcome, PreToolDecision } from "../capability/types.js";
import { GovernanceConsole } from "../console/console-service.js";
import { startConsoleServer } from "../console/http-server.js";
import { GovernancePolicy } from "../console/policy.js";
// 作用：Phase 1/4 端到端集成测试——在【真 cordis 总线】上把「通用场景的权限生命周期」整条跑通：
//   ask → allowed-once → 签发 Lease → 复用（不再询问）→ TTL 到期 / 主动撤销 → 重新询问，
// 外加治理接口在真实状态上的投影。
// 为什么必须是真 cordis：hook 时序、prepend 遮蔽、服务解析三处历史缺陷只有这一层能发现
// （单元测试的假 bus 会掩盖它们）；因此本文件的断言全部打在真实 Context 的 waterfall/emit 上。
// 2026-11-01：沙箱档位提升/回滚链路已删除，这里不再有任何 setSandboxMode 替身；「宿主档位」只作为
// 治理台的只读读数出现（currentMode），与授权状态互不覆盖。
let now = 1_000_000;
const clock = () => now;
const SESSION = { id: "session-lifecycle" };
interface Host {
  root: Context;
  leases: LeaseManager;
  audit: AuditService;
  policy: GovernancePolicy;
  settings: GuardSettings;
  gate: UniversalGate;
  /** 真实的人类/机器答话器（被 Guard 观察到的那一个）——用于断言「有没有惊动人类」 */
  human: ReturnType<typeof vi.fn>;
}
/** 组装真实 cordis 总线 + 忠实模拟 DSH 工具管线的宿主。
 * answerer 代表 DSH 自带的人类/机器答话器：它必须以「非 prepend」注册，才能排在 Guard 的 prepend
 * 之后被 Guard 观察到（真实验证见 cordis-pipeline.test.ts 的 prepend 遮蔽用例）。 */
function makeHost(config: UniversalPolicyConfig, answerer?: () => Promise<ApprovalOutcome>): Host {
  const root = new Context();
  const human = vi.fn(answerer ?? (() => Promise.resolve("unavailable" as ApprovalOutcome)));
  root.on("approval/request", () => human());
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const audit = new AuditService();
  const policy = new GovernancePolicy({ initial: { defaultScope: config.defaultScope, defaultTtlSeconds: config.defaultTtlSeconds, maxTtlSeconds: config.maxTtlSeconds }, deployment: { enabled: config.enabled, rules: config.rules } });
  const settings = new GuardSettings({ maxTtlSeconds: config.maxTtlSeconds, initial: { reuseTtlSeconds: Math.min(60, config.maxTtlSeconds) } });
  const gate = new UniversalGate({
    policy: new PolicyResolver(() => policy.config),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    settings,
    now: clock,
  });
  gate.install(root as never);
  // 模拟 DSH 注册的单调守卫（位于 Guard 之后，只透传）
  root.on("tools/pre-execute", (_exec: unknown, next: () => Promise<PreToolDecision>) => next());
  return { root, leases, audit, policy, settings, gate, human };
}
interface ExecLike {
  callId: string;
  rootCallId: string;
  name: string;
  arguments: unknown;
  agent: { id: string };
}
/** 按 DSH 真实顺序驱动一次工具调用；pre 决策非 allow 时不产生 tools/result（与 DSH 行为一致）。 */
async function runTool(host: Host, exec: ExecLike, options: { pre?: () => Promise<PreToolDecision>; body?: () => Promise<unknown> } = {}) {
  const pre = await host.root.waterfall(host.root, "tools/pre-execute", exec, options.pre ?? (() => Promise.resolve({ kind: "allow" as const })));
  if (pre.kind !== "allow") return { pre, result: undefined as unknown };
  const result = await host.root.waterfall(host.root, "tools/execute", exec, options.body ?? (() => Promise.resolve("tool-ok")));
  host.root.emit(host.root, "tools/result", exec, { isError: false });
  return { pre, result };
}
/** 发起一次审批（落底 unavailable；answerer 已在 makeHost 注册）。 */
async function askApproval(host: Host, callId: string, toolName = "pwsh") {
  return await host.root.waterfall(host.root, "approval/request", { callId, toolName, agent: { id: SESSION.id }, reason: "需要人工确认" }, () => Promise.resolve("unavailable" as const));
}
const plainExec = (callId: string, command = "Get-Date"): ExecLike => ({ callId, rootCallId: callId, name: "pwsh", arguments: { command }, agent: { id: SESSION.id } });
const escalateExec = (callId: string, justification = "需要写入工作区外"): ExecLike => ({ callId, rootCallId: callId, name: "pwsh", arguments: { command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification }, agent: { id: SESSION.id } });
const askDownstream = () => Promise.resolve({ kind: "ask" as const, reason: "原生策略要求确认" });
const ALWAYS_ASK: UniversalPolicyConfig = { ...DEFAULT_UNIVERSAL_POLICY, rules: [], defaultTtlSeconds: 60, maxTtlSeconds: 1800 };
beforeEach(() => {
  now = 1_000_000;
});
describe("通用场景权限生命周期（真 cordis 端到端）", () => {
  it("ask → allowed-once 签发 Lease → 同参数复用；TTL 到期后重新询问", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    // ① 首次询问：Guard 必须把「批准将签发什么 Scope、多长 TTL」写进 reason
    const first = await runTool(host, plainExec("c1"), { pre: askDownstream });
    expect(first.pre.kind).toBe("ask");
    expect(first.pre.reason).toContain("TTL=60s");
    expect(first.pre.reason).toContain("Scope");
    expect(await host.leases.list()).toHaveLength(0);
    // ② 批准一次 → 签发 Lease
    expect(await askApproval(host, "c1")).toBe("allowed-once");
    const leases = await host.leases.list();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ sessionId: SESSION.id, toolName: "pwsh", status: "ACTIVE", kind: "universal" });
    expect(leases[0].scope.kind).toBe("exact-arguments");
    // ③ 同参数第二次：下游仍然 ask，但 Guard 命中 Lease → allow（复用，不再打扰用户）
    const second = await runTool(host, plainExec("c2"), { pre: askDownstream });
    expect(second.pre.kind).toBe("allow");
    expect(host.audit.list().some((event) => event.decision === "LEASE_REUSED")).toBe(true);
    // ④ 参数不同 → Scope 不同 → 仍然询问（默认 exact-arguments 不允许跨参数复用）
    const other = await runTool(host, plainExec("c3", "Get-Process"), { pre: askDownstream });
    expect(other.pre.kind).toBe("ask");
    // ⑤ TTL 到期 → 同一调用重新询问，且 Lease 被惰性标记为 EXPIRED
    now += 61_000;
    const expired = await runTool(host, plainExec("c4"), { pre: askDownstream });
    expect(expired.pre.kind).toBe("ask");
    expect((await host.leases.list())[0].status).toBe("EXPIRED");
  });
  it("rejected / cancelled / unavailable 一律不签发 Lease（Fail Closed）", async () => {
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
      const host = makeHost(ALWAYS_ASK, () => Promise.resolve(outcome));
      await runTool(host, plainExec("c1"), { pre: askDownstream });
      expect(await askApproval(host, "c1")).toBe(outcome);
      expect(await host.leases.list()).toHaveLength(0);
      expect(host.audit.list().some((event) => event.decision === "APPROVAL_REJECTED")).toBe(true);
    }
  });
  it("原始 deny 永远透传：既不询问也不签发（Lease 不得覆盖拒绝）", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    const decided = await runTool(host, plainExec("c1"), { pre: () => Promise.resolve({ kind: "deny" as const, reason: "policy" }) });
    expect(decided.pre).toEqual({ kind: "deny", reason: "policy" });
    expect(await host.leases.list()).toHaveLength(0);
    expect(host.audit.list().some((event) => event.decision === "PASSTHROUGH_DENY")).toBe(true);
  });
  it("逐条撤销后立即重新询问；其他会话不受影响", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    await runTool(host, plainExec("c1"), { pre: askDownstream });
    await askApproval(host, "c1");
    expect((await runTool(host, plainExec("c2"), { pre: askDownstream })).pre.kind).toBe("allow");
    for (const lease of await host.leases.list()) await host.leases.revoke(lease.id, "用户主动收回");
    expect((await runTool(host, plainExec("c3"), { pre: askDownstream })).pre.kind).toBe("ask");
    expect((await host.leases.list())[0].status).toBe("REVOKED");
  });
  it("运行时切换默认范围挡位立即生效，且不会让旧授权越权复用", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    await runTool(host, plainExec("c1", "Get-Date"), { pre: askDownstream });
    await askApproval(host, "c1");
    // 旧授权是 exact-arguments：换了参数的调用仍然要问
    expect((await runTool(host, plainExec("c2", "Get-Process"), { pre: askDownstream })).pre.kind).toBe("ask");
    // 让旧授权自然过期，再切到 tool 挡位
    now += 61_000;
    await host.policy.update({ defaultScope: "tool" });
    expect((await runTool(host, plainExec("c3", "Get-Process"), { pre: askDownstream })).pre.kind).toBe("ask");
    await askApproval(host, "c3");
    // 新签发的授权按「整个工具」取键：换任何参数都能复用
    expect((await host.leases.list()).some((lease) => lease.scope.kind === "tool" && lease.toolName === "pwsh")).toBe(true);
    expect((await runTool(host, plainExec("c4", "Get-Process"), { pre: askDownstream })).pre.kind).toBe("allow");
    expect((await runTool(host, plainExec("c5", "Get-Service"), { pre: askDownstream })).pre.kind).toBe("allow");
    // 切换挡位不会让旧授权复活：tool 挡位授权到期后，任何参数都重新询问
    now += 61_000;
    expect((await runTool(host, plainExec("c6", "Get-Service"), { pre: askDownstream })).pre.kind).toBe("ask");
  });
  it("并行调用按 callId 隔离：只有被批准的那一次获得授权", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    const a = plainExec("call-a", "Get-Date");
    const b = plainExec("call-b", "Get-Date");
    const [first, second] = await Promise.all([runTool(host, a, { pre: askDownstream }), runTool(host, b, { pre: askDownstream })]);
    expect(first.pre.kind).toBe("ask");
    expect(second.pre.kind).toBe("ask");
    await askApproval(host, "call-a");
    const leases = await host.leases.list();
    expect(leases).toHaveLength(1);
    expect(leases[0].sourceCallId).toBe("call-a");
  });
});
describe("审批放行生命周期（真 cordis 端到端）", () => {
  it("批准一次 → 同一条操作（不同 justification）第二次完全不惊动人类答话器；到期后恢复询问", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    await runTool(host, escalateExec("c1", "第一次"));
    expect(await host.leases.list()).toHaveLength(0);
    expect(await askApproval(host, "c1", "pwsh")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(1);
    const leases = await host.leases.list();
    expect(leases).toHaveLength(1);
    expect(leases[0].kind).toBe("universal");
    // 第二次：不同 callId、不同理由 → 同一操作指纹 → Guard 代答，不调用人类
    await runTool(host, escalateExec("c2", "完全不同的理由"));
    expect(await askApproval(host, "c2", "pwsh")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(1);
    expect(await host.leases.list()).toHaveLength(1);
    // 到期后同一个调用重新交还人类
    now += 61_000;
    await runTool(host, escalateExec("c3"));
    expect(await askApproval(host, "c3", "pwsh")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(2);
  });
  it("规则 disabled 的工具：完全不进入 Guard（不签发、不代答）", async () => {
    const host = makeHost({ ...DEFAULT_UNIVERSAL_POLICY, rules: [{ match: "pwsh", enabled: false }] }, () => Promise.resolve("allowed-once"));
    await runTool(host, escalateExec("c1", "第一次"));
    expect(await askApproval(host, "c1", "pwsh")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(1);
    expect(await host.leases.list()).toHaveLength(0);
    // 第二次仍然要问人（没有任何授权）
    await runTool(host, escalateExec("c2"));
    expect(await askApproval(host, "c2", "pwsh")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(2);
  });
  it("【治理视图】授权到期后 auth=expired、宿主档位读数不变，且没有「待回滚」动作", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    await runTool(host, escalateExec("c1"));
    await askApproval(host, "c1", "pwsh");
    const govConsole = new GovernanceConsole({ audit: host.audit, leases: host.leases, now: clock, currentMode: () => "read-only" });
    expect((await govConsole.snapshot()).sessions[0]?.sandbox.currentMode).toBe("read-only");
    now += 61_000;
    const after = await govConsole.snapshot();
    expect(after.sessions[0]?.auth.state).toBe("expired");
    expect(after.sessions[0]?.actions).toEqual({ canRevoke: false });
    // 宿主档位是用户自己的设置：无论授权是否失效，Guard 都只读不写
    expect(after.sessions[0]?.sandbox.currentMode).toBe("read-only");
  });
});
describe("治理接口在真实生命周期状态上的投影", () => {
  it("快照实时反映授权剩余时间；PATCH settings 改变后续签发的 TTL", async () => {
    const host = makeHost(ALWAYS_ASK, () => Promise.resolve("allowed-once"));
    await runTool(host, plainExec("c1"), { pre: askDownstream });
    await askApproval(host, "c1");
    const govConsole = new GovernanceConsole({ audit: host.audit, leases: host.leases, guardName: "dsh-capability-guard", now: clock });
    const handle = await startConsoleServer({ console: govConsole, policy: host.policy, settings: host.settings, port: 0 });
    try {
      const snapshot = (await (await fetch(`${handle.url}api/snapshot`)).json()) as { summary: { leasesActive: number }; sessions: { auth: { remainingMs?: number; state: string; grants: { toolName: string }[] } }[] };
      expect(snapshot.summary.leasesActive).toBe(1);
      expect(snapshot.sessions[0]?.auth.state).toBe("active");
      expect(snapshot.sessions[0]?.auth.grants[0]).toMatchObject({ toolName: "pwsh" });
      expect(snapshot.sessions[0]?.auth.remainingMs).toBe(60_000);
      // 剩余时间随时钟推进实时缩短（页面倒计时的数据来源）
      now += 20_000;
      const later = (await (await fetch(`${handle.url}api/snapshot`)).json()) as { sessions: { auth: { remainingMs?: number } }[] };
      expect(later.sessions[0]?.auth.remainingMs).toBe(40_000);
      // 运行期设置写接口 → 后续新授权使用新的复用时长（写入的是产品设置，不是沙箱档位）
      const patched = await fetch(`${handle.url}api/config`, { method: "PATCH", headers: { "content-type": "application/json", "x-dsh-guard": "1" }, body: JSON.stringify({ settings: { reuseTtlSeconds: 120 } }) });
      expect(patched.status).toBe(200);
      expect(host.settings.reuseTtlSeconds).toBe(120);
      await runTool(host, plainExec("c2", "Get-Process"));
      await askApproval(host, "c2");
      const newest = (await host.leases.list()).find((lease) => lease.issuedAt === now);
      expect(newest?.expiresAt).toBe(now + 120_000);
      // 审计接口按决策过滤
      const audit = (await (await fetch(`${handle.url}api/audit?decision=LEASE_ISSUED`)).json()) as unknown[];
      expect(audit).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });
});
