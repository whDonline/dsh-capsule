import { Context } from "@deepseek-ai/cordis";
import { CapabilityService, LeaseManager, MemoryLeaseStore, sha256Scope } from "@dsh-capsule/adapter";
import { describe, expect, it } from "vitest";
import { apply, type DemoHostContext, type DemoToolDefinition } from "./index.js";
// 作用：github-demo 端到端测试——用 Guard Core 真实 CapabilityService + mock Broker executor 验证
// 扩展注册、execute 双重校验链路与 dispose 行为；同时回归验证 SDK 类型与 adapter 接口结构兼容。
interface TestHost {
  host: DemoHostContext;
  tools: Map<string, DemoToolDefinition>;
  leases: LeaseManager;
  capabilities: CapabilityService;
  operations: Array<{ provider: string; resource: string; action: string; input: unknown }>;
}
function makeHost(): TestHost {
  // 作用：构造最小 DSH 宿主——tools.register 收集到 Map，capabilities 为真实 CapabilityService
  //（executor mock 只记录 operation 并返回固定业务结果，模拟 Broker + Provider）
  const tools = new Map<string, DemoToolDefinition>();
  const operations: Array<{ provider: string; resource: string; action: string; input: unknown }> = [];
  const leases = new LeaseManager(new MemoryLeaseStore());
  // 作用：CapabilityService 现在是真正的 cordis Service（构造时 `super(ctx, "capabilities")`
  // 会调用 ctx.reflect.provide），因此必须传真实 cordis Context——假对象会以
  // "Cannot read properties of undefined (reading 'provide')" 崩溃（2026-09 CI 三平台失败的根因）
  const capabilities = new CapabilityService(new Context(), {
    leases,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 1800,
    executor: {
      execute: async (operation) => {
        operations.push(operation);
        return { ok: true, action: operation.action, resource: operation.resource };
      },
    },
  });
  const host: DemoHostContext = { tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, capabilities };
  return { host, tools, leases, capabilities, operations };
}
function makeRun(name: string, args: Record<string, unknown>) {
  // 作用：构造可信 Tool Runtime 产生的 run 上下文——agent.id 即 SessionId（规格 10.3）
  return { callId: `c-${name}`, rootCallId: `r-${name}`, name, arguments: args, agent: { id: "session-1" } };
}
function managedScopeKey(resource: string, action: string): string {
  // 作用：构造与 CapabilityService.buildScope 同源的 managed scope key——sha256({provider, resource, action})
  return sha256Scope({ provider: "github", resource, action });
}
describe("guard-github-demo Managed Extension", () => {
  it("apply 注册 2 个 Tool 与 2 条 managed 能力定义（listCapabilities 白名单投影）", () => {
    const { host, tools, capabilities } = makeHost();
    const dispose = apply(host);
    expect([...tools.keys()].sort()).toEqual(["guard_github_create_issue", "guard_github_read_issue"]);
    expect(capabilities.listCapabilities()).toEqual([
      { toolName: "guard_github_read_issue", provider: "github", action: "issues.read", ttlSeconds: 60 },
      { toolName: "guard_github_create_issue", provider: "github", action: "issues.create", ttlSeconds: 300 },
    ]);
    dispose();
  });
  it("read：有 managed Lease 时 execute 走 Broker，executor 收到正确语义 Operation", async () => {
    const { host, tools, leases, operations } = makeHost();
    const dispose = apply(host);
    await leases.issue({ sessionId: "session-1", toolName: "guard_github_read_issue", scope: { kind: "managed", key: managedScopeKey("repo:a/b", "issues.read"), display: "provider=github resource=repo:a/b action=issues.read" }, ttlSeconds: 60, kind: "managed" });
    const result = await tools.get("guard_github_read_issue")!.execute(makeRun("guard_github_read_issue", { repo: "a/b", issue_number: 42 }));
    expect(result).toEqual({ ok: true, action: "issues.read", resource: "repo:a/b" });
    expect(operations).toEqual([{ provider: "github", resource: "repo:a/b", action: "issues.read", input: { issue_number: 42 } }]);
    dispose();
  });
  it("create：独立 TTL 的 managed Lease 下 execute 走 Broker（input 白名单映射 title/body）", async () => {
    const { host, tools, leases, operations } = makeHost();
    const dispose = apply(host);
    await leases.issue({ sessionId: "session-1", toolName: "guard_github_create_issue", scope: { kind: "managed", key: managedScopeKey("repo:o/r", "issues.create"), display: "provider=github resource=repo:o/r action=issues.create" }, ttlSeconds: 300, kind: "managed" });
    const result = await tools.get("guard_github_create_issue")!.execute(makeRun("guard_github_create_issue", { repo: "o/r", title: "T", body: "B", extra: "不透传" }));
    expect(result).toEqual({ ok: true, action: "issues.create", resource: "repo:o/r" });
    expect(operations).toEqual([{ provider: "github", resource: "repo:o/r", action: "issues.create", input: { title: "T", body: "B" } }]);
    dispose();
  });
  it("无 Lease：execute 抛 LEASE_REQUIRED（Fail Closed）", async () => {
    const { host, tools, operations } = makeHost();
    const dispose = apply(host);
    await expect(tools.get("guard_github_read_issue")!.execute(makeRun("guard_github_read_issue", { repo: "a/b", issue_number: 1 }))).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
    expect(operations).toEqual([]);
    dispose();
  });
  it("args.repo 非法：resource 计算抛错，不进入 Guard / Broker", async () => {
    const { host, tools, operations } = makeHost();
    const dispose = apply(host);
    await expect(tools.get("guard_github_read_issue")!.execute(makeRun("guard_github_read_issue", { repo: "not a repo", issue_number: 1 }))).rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    expect(operations).toEqual([]);
    dispose();
  });
  it("dispose 后 definition 已注销：execute 抛 CAPABILITY_NOT_REGISTERED", async () => {
    const { host, tools, leases } = makeHost();
    const dispose = apply(host);
    const read = tools.get("guard_github_read_issue")!;
    await leases.issue({ sessionId: "session-1", toolName: "guard_github_read_issue", scope: { kind: "managed", key: managedScopeKey("repo:a/b", "issues.read"), display: "provider=github resource=repo:a/b action=issues.read" }, ttlSeconds: 60, kind: "managed" });
    dispose();
    await expect(read.execute(makeRun("guard_github_read_issue", { repo: "a/b", issue_number: 1 }))).rejects.toMatchObject({ code: "CAPABILITY_NOT_REGISTERED" });
  });
});
