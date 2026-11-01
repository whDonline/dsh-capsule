import { beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { PendingRegistry } from "../capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "../capability/policy.js";
import { ScopeResolver } from "../capability/scope-resolver.js";
import { UniversalGate } from "../capability/universal-gate.js";
import type { ApprovalOutcome, PreToolDecision } from "../capability/types.js";
// 作用：P0-4 真 cordis 集成测试——用【真实的 @deepseek-ai/cordis Context】验证 Guard 的 hook 接线，
// 而不是像既有单测那样只断言 install() 注册了哪几个事件名。
// 本文件对照 DSH 真实调用形态（dsh-tools / dsh-user-approval 的源码核实结论，见 docs/集成基线-真实DSH行为.md）：
//   tools/pre-execute  : ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }))
//   tools/execute      : ctx.waterfall(carrier, "tools/execute", exec, () => Promise.resolve(toolResult))
//   approval/request   : ctx.waterfall(carrier, "approval/request", req, () => Promise.resolve("unavailable"))
//   tools/result       : ctx.emit(carrier, "tools/result", exec, result)
// 关键点：默认落底决策就是 allow —— 这解释了「为什么 Guard 在 pre-execute 等不到 ask」。
// 2026-11-01：本插件不再改写会话沙箱档位，因此这里【没有】任何 SandboxGrantManager / setSandboxMode 替身；
// 「批准一次」的效果就是签发一条 universal 操作授权 + 后续同一条操作由 Guard 代答 allowed-once。
let now = 1_000_000;
const clock = () => now;
/** 组装「真实 cordis 总线 + 忠实模拟 DSH 工具管线」的测试宿主。
 * @param answerer 可选的审批答话器。**必须在 Guard 的 install 之前注册**：它代表 DSH 自带的
 *   UI answerer（host 端 listener，先于第三方插件装载）。先注册 + prepend 会把它排在内层，
 *   Guard 位于外层时才能观察到最终 outcome——与真实组合一致。 */
function makeHost(answerer?: () => Promise<ApprovalOutcome>) {
  const root = new Context();
  const human = vi.fn(answerer ?? (() => Promise.resolve("unavailable" as ApprovalOutcome)));
  if (answerer) root.on("approval/request", () => human(), { prepend: true });
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const pending = new PendingRegistry();
  const audit = new AuditService();
  const gate = new UniversalGate({
    policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending,
    audit,
    settings: { active: true, reuseTtlSeconds: 300 },
    now: clock,
  });
  // 与 Guard 的 install() 完全相同：四个 hook，前三个 prepend（外层中间件），tools/result 为观察者
  gate.install(root as never);
  // 模拟 DSH 注册的单调守卫：它在 Guard 之后（此事件上后注册者排在后面），只做透传
  root.on("tools/pre-execute", (_exec: unknown, next: () => Promise<PreToolDecision>) => next());
  return { root, leases, pending, audit, human };
}
interface RunOptions {
  exec: { callId: string; rootCallId: string; name: string; arguments: unknown; agent: { id: string } };
  pre?: () => Promise<PreToolDecision>;
  body?: () => Promise<unknown>;
}
/**
 * 按 DSH 的真实顺序驱动一次工具调用：tools/pre-execute →（allow 时）tools/execute → tools/result。
 * 注意：pre 决策不是 allow 时刻意【不】发 tools/result——DSH 在 denied/asked 而未执行时确实不会产生
 * 最终结果事件，测试若需要该事件可自行 emit，从而能观察到事件前后的状态差异。
 */
async function runTool(host: ReturnType<typeof makeHost>, options: RunOptions) {
  const pre = await host.root.waterfall(host.root, "tools/pre-execute", options.exec, options.pre ?? (() => Promise.resolve({ kind: "allow" as const })));
  if (pre.kind !== "allow") {
    return { pre, result: undefined };
  }
  const result = await host.root.waterfall(host.root, "tools/execute", options.exec, options.body ?? (() => Promise.resolve("tool-ok")));
  host.root.emit(host.root, "tools/result", options.exec, { isError: false });
  return { pre, result };
}
/** 按 DSH 的真实形态发起一次审批（落底 unavailable；答话器在 makeHost 时已注册）。 */
async function askApproval(host: ReturnType<typeof makeHost>, callId: string, toolName = "pwsh") {
  return await host.root.waterfall(host.root, "approval/request", { callId, toolName, reason: "escalate sandbox" }, () => Promise.resolve("unavailable" as const));
}
const escalationExec = (callId: string, justification = "需要写入工作区外") => ({
  callId,
  rootCallId: callId,
  name: "pwsh",
  arguments: { command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification },
  agent: { id: "s1" },
});
const plainExec = (callId: string) => ({ callId, rootCallId: callId, name: "pwsh", arguments: { command: "Get-Date" }, agent: { id: "s1" } });
beforeEach(() => {
  now = 1_000_000;
});
describe("P0-4 真 cordis：pre-execute 落底决策语义", () => {
  it("无任何 listener 返回 ask 时，落底就是 allow（固化「Guard 在 pre-execute 等不到 ask」这一事实）", async () => {
    const host = makeHost();
    const { pre } = await runTool(host, { exec: plainExec("c1") });
    expect(pre).toEqual({ kind: "allow" });
    expect(await host.leases.list()).toHaveLength(0);
    expect(host.audit.list().some((e) => e.decision === "PASSTHROUGH_ALLOW")).toBe(true);
    expect(host.audit.list().some((e) => e.decision === "ASK")).toBe(false);
  });
  it("下游 hook 返回 ask 时 Guard 才接管：reason 中必须写明 Scope 与 TTL", async () => {
    const host = makeHost();
    const { pre } = await runTool(host, { exec: plainExec("c1"), pre: () => Promise.resolve({ kind: "ask" as const, reason: "需人工确认" }) });
    expect(pre.kind).toBe("ask");
    expect(pre.reason).toContain("需人工确认");
    expect(pre.reason).toContain("TTL=");
    expect(pre.reason).toContain("Lease");
    expect(host.pending.size()).toBe(1);
  });
  it("下游 deny 永远透传（Lease 不得覆盖）", async () => {
    const host = makeHost();
    const { pre } = await runTool(host, { exec: plainExec("c1"), pre: () => Promise.resolve({ kind: "deny" as const, reason: "policy" }) });
    expect(pre).toEqual({ kind: "deny", reason: "policy" });
    expect(await host.leases.list()).toHaveLength(0);
  });
});
describe("P0-4 真 cordis：prepend 与瀑布认领语义（Guard 接线的硬约束）", () => {
  it("两个 prepend 监听器会互相遮蔽：后注册者排最前，认领后不再调用 next()，先注册者收不到事件", async () => {
    const root = new Context();
    const seen: string[] = [];
    root.on(
      "evt",
      async (_a: unknown, next: () => Promise<string>) => {
        seen.push("guard");
        return await next();
      },
      { prepend: true },
    );
    root.on(
      "evt",
      async () => {
        seen.push("answerer");
        return "from-answerer";
      },
      { prepend: true },
    );
    const out = await root.waterfall(root, "evt", {}, () => Promise.resolve("inner"));
    // Guard 排在 answerer 之后：answerer 认领（未调用 next）→ Guard 完全看不到这次审批。
    // 因此 Guard 必须【只注册一个】prepend 监听器，且必须是有条件转发 next() 的那一个。
    expect(seen).toEqual(["answerer"]);
    expect(out).toBe("from-answerer");
  });
  it("Guard 位于下游（answerer 先认领）时能观察到审批结果——这就是唯一 prepend 的接线形态", async () => {
    const root = new Context();
    const seen: string[] = [];
    root.on("evt2", async () => {
      seen.push("answerer");
      return "granted";
    });
    root.on(
      "evt2",
      async (_a: unknown, next: () => Promise<string>) => {
        const result = await next();
        seen.push(`guard-saw:${result}`);
        return result;
      },
      { prepend: true },
    );
    const out = await root.waterfall(root, "evt2", {}, () => Promise.resolve("unavailable"));
    expect(seen).toEqual(["answerer", "guard-saw:granted"]);
    expect(out).toBe("granted");
  });
});
describe("P0-4 真 cordis：审批层短期授权全链路", () => {
  const grantOnce = () => Promise.resolve("allowed-once" as const);
  it("tools/execute 记录操作 → 审批 allowed-once → 签发 universal 操作授权（不改任何档位）", async () => {
    const host = makeHost(grantOnce);
    await runTool(host, { exec: escalationExec("c1") });
    expect(await host.leases.list()).toHaveLength(0); // 尚未批准
    expect(await askApproval(host, "c1")).toBe("allowed-once");
    const leases = await host.leases.list();
    expect(leases).toHaveLength(1);
    expect(leases[0].kind).toBe("universal");
    expect(leases[0].scope.kind).toBe("exact-arguments");
    expect(host.audit.list().some((e) => e.decision === "LEASE_ISSUED")).toBe(true);
  });
  it("【核心价值】第二次同一条操作（不同 justification 与 callId）完全不惊动人类答话器", async () => {
    const host = makeHost(grantOnce);
    await runTool(host, { exec: escalationExec("c1", "第一次") });
    await askApproval(host, "c1");
    expect(host.human).toHaveBeenCalledTimes(1);
    await runTool(host, { exec: escalationExec("c2", "完全不同的第二次理由") });
    expect(await askApproval(host, "c2")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(1);
    expect(await host.leases.list()).toHaveLength(1);
  });
  it("approval 落底结果为 unavailable（无人认领）时不签发（Fail Closed）", async () => {
    const host = makeHost();
    await runTool(host, { exec: escalationExec("c1") });
    expect(await askApproval(host, "c1")).toBe("unavailable");
    expect(await host.leases.list()).toHaveLength(0);
  });
  it("【P0-3 不变量 · 真总线验证】Guard 绝不合成 outcome：answerer 结果原样返回", async () => {
    for (const outcome of ["allowed-once", "rejected", "cancelled", "unavailable"] as const) {
      const host = makeHost(() => Promise.resolve(outcome));
      await runTool(host, { exec: escalationExec("c1") });
      expect(await askApproval(host, "c1")).toBe(outcome);
    }
  });
  it("授权到期后：下一次审批重新交还人类答话器", async () => {
    const host = makeHost(grantOnce);
    await runTool(host, { exec: escalationExec("c1") });
    await askApproval(host, "c1");
    expect(host.human).toHaveBeenCalledTimes(1);
    now += 301_000;
    await runTool(host, { exec: escalationExec("c2") });
    expect(await askApproval(host, "c2")).toBe("allowed-once");
    expect(host.human).toHaveBeenCalledTimes(2);
    // 到期那条不会被复用；重新批准后产生第二条授权
    expect(await host.leases.list()).toHaveLength(2);
  });
});
describe("P0-4 真 cordis：不改变执行结果", () => {
  it("tools/execute 不替换、不否决下游结果（sentinel 同一引用）", async () => {
    const host = makeHost();
    const sentinel = Object.freeze({ ok: true });
    const { result } = await runTool(host, { exec: escalationExec("c1"), body: () => Promise.resolve(sentinel) });
    expect(result).toBe(sentinel);
  });
  it("approval/request 的 sentinel 也原样返回（allowed-once 时仍签发，但结果引用不变）", async () => {
    const host = makeHost();
    await runTool(host, { exec: escalationExec("c1") });
    const sentinel = Object.freeze({ decision: "allowed-once" });
    const out = await host.root.waterfall(host.root, "approval/request", { callId: "c1", toolName: "pwsh" }, () => Promise.resolve(sentinel as never));
    expect(out).toBe(sentinel);
  });
});
