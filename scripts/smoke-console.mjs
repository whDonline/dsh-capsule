// 作用：本地手工冒烟脚本（开发期用，不参与构建产物）——启动一个带示例数据的只在内存中运行的
// Guard 治理接口，便于在浏览器里直接检查页面（http://127.0.0.1:8799/）。
// 用法：node scripts/smoke-console.mjs
import { AuditService } from "../adapter/dist/audit/audit-service.js";
import { LeaseManager } from "../adapter/dist/capability/lease-manager.js";
import { MemoryLeaseStore } from "../adapter/dist/capability/lease-store.js";
import { GovernanceConsole } from "../adapter/dist/console/console-service.js";
import { GovernancePolicy } from "../adapter/dist/console/policy.js";
import { startConsoleServer } from "../adapter/dist/console/http-server.js";

const now = Date.now();
const audit = new AuditService();
const leases = new LeaseManager(new MemoryLeaseStore());
const policy = new GovernancePolicy({
  initial: { defaultScope: "sandbox-escalation", defaultTtlSeconds: 300, maxTtlSeconds: 1800 },
  deployment: { enabled: true, rules: [{ match: "pwsh", ttlSeconds: 300, scope: { mode: "sandbox-escalation" } }] },
});
await leases.issue({
  sessionId: "session-smoke-1",
  toolName: "pwsh",
  scope: { kind: "sandbox-escalation", key: "deadbeef", display: "tool=pwsh 沙箱升级至 danger-full-access" },
  ttlSeconds: 300,
  kind: "sandbox-mode",
  sourceCallId: "call-1",
});
await leases.issue({
  sessionId: "session-smoke-2",
  toolName: "deploy.preview",
  scope: { kind: "exact-arguments", key: "cafebabe", display: 'tool=deploy.preview args={"environment":"staging"}' },
  ttlSeconds: 45,
});
for (const [decision, toolName, extra] of [
  ["ASK", "deploy.preview", { scopeDisplay: 'tool=deploy.preview args={"environment":"staging"}' }],
  ["LEASE_ISSUED", "deploy.preview", { leaseId: "smoke-lease-2" }],
  ["LEASE_REUSED", "deploy.preview", { leaseId: "smoke-lease-2" }],
  ["SANDBOX_MODE_RAISED", "pwsh", { scopeDisplay: "会话沙箱模式提升至 danger-full-access" }],
  ["TOOL_SUCCESS", "pwsh", {}],
  ["APPROVAL_REJECTED", "deploy.production", {}],
]) {
  audit.record({ sessionId: "session-smoke-1", callId: `call-${Math.random().toString(16).slice(2, 8)}`, rootCallId: "root", toolName, decision, ...extra });
}
const govConsole = new GovernanceConsole({
  audit,
  leases,
  capabilities: { listCapabilities: () => [] },
  providers: { list: () => [] },
  guardName: "dsh-capability-guard",
});
const handle = await startConsoleServer({ console: govConsole, policy, host: "127.0.0.1", port: 8799 });
process.stdout.write(`smoke console: ${handle.url} (now ${new Date(now).toISOString()})\n`);
