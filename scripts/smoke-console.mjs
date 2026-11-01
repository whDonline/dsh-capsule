// 作用：本地手工冒烟脚本（开发期用，不参与构建产物）——启动一个带示例数据的只在内存中运行的
// Guard 治理接口，便于在浏览器里直接检查页面（http://127.0.0.1:8799/）。
// 2026-11-01：示例数据改为「审批层短期授权 + 宿主档位读数」，不再有任何沙箱档位提升/回滚；
// 页面上的「立即收回」在冒烟环境里点得动（与生产同一份 GuardActions）。
// 用法：node scripts/smoke-console.mjs（需先 pnpm -C adapter build）
import { AuditService } from "../adapter/dist/audit/audit-service.js";
import { LeaseManager } from "../adapter/dist/capability/lease-manager.js";
import { MemoryLeaseStore } from "../adapter/dist/capability/lease-store.js";
import { GuardActions } from "../adapter/dist/console/actions.js";
import { GovernanceConsole } from "../adapter/dist/console/console-service.js";
import { GovernancePolicy } from "../adapter/dist/console/policy.js";
import { startConsoleServer } from "../adapter/dist/console/http-server.js";

const audit = new AuditService();
const leases = new LeaseManager(new MemoryLeaseStore());
const policy = new GovernancePolicy({
  initial: { defaultScope: "exact-arguments", defaultTtlSeconds: 300, maxTtlSeconds: 1800 },
});
// 会话一：一条操作授权生效中（页面上应显示「生效中」；档位是宿主读数，由 DSH 设定）
const escalated = await leases.issue({
  sessionId: "session-smoke-1",
  toolName: "pwsh",
  scope: { kind: "exact-arguments", key: "deadbeef", display: "pwsh: Set-Content C:\\tmp\\a.txt → workspace-write" },
  ttlSeconds: 300,
  sourceCallId: "call-1",
});
// 会话二：普通参数授权（45 秒后到期）
const shortLived = await leases.issue({
  sessionId: "session-smoke-2",
  toolName: "deploy.preview",
  scope: { kind: "exact-arguments", key: "cafebabe", display: "deploy.preview: staging 环境预检" },
  ttlSeconds: 45,
});
for (const [decision, sessionId, toolName, extra] of [
  ["ASK", "session-smoke-2", "deploy.preview", { scopeDisplay: "deploy.preview: staging 环境预检" }],
  ["LEASE_ISSUED", "session-smoke-2", "deploy.preview", { leaseId: shortLived.id, scopeDisplay: "deploy.preview: staging 环境预检" }],
  ["LEASE_REUSED", "session-smoke-2", "deploy.preview", { leaseId: shortLived.id, scopeDisplay: "deploy.preview: staging 环境预检" }],
  ["LEASE_REUSED", "session-smoke-1", "pwsh", { leaseId: escalated.id, scopeDisplay: "pwsh: Set-Content C:\\tmp\\a.txt → workspace-write · 凭族放行：同目录 pwsh @ C:\\tmp" }],
  ["TOOL_SUCCESS", "session-smoke-1", "pwsh", {}],
  ["APPROVAL_REJECTED", "session-smoke-2", "deploy.production", {}],
]) {
  audit.record({ sessionId, callId: `call-${Math.random().toString(16).slice(2, 8)}`, rootCallId: "root", toolName, decision, ...extra });
}
const labels = { "session-smoke-1": "修复登录超时", "session-smoke-2": "部署预发环境" };
const govConsole = new GovernanceConsole({
  audit,
  leases,
  guardName: "dsh-capability-guard",
  // 宿主实时档位（只读读数）；冒烟环境里用固定值演示「Guard 不改动它」
  currentMode: (sessionId) => (sessionId === "session-smoke-1" ? "read-only" : "workspace-write"),
  sessions: { describe: (sessionId) => ({ label: labels[sessionId] ?? `会话 ${sessionId.slice(0, 8)}`, source: labels[sessionId] ? "title" : "id", cwd: "D:\\gitpro\\demo" }) },
});
const actions = new GuardActions({ leases, audit });
const handle = await startConsoleServer({ console: govConsole, policy, actions, sweepIntervalMs: 30000, host: "127.0.0.1", port: 8799 });
process.stdout.write(`smoke console: ${handle.url}\n`);
process.stdout.write("提示：等第二会话的 45s 授权过期后刷新页面，可看到「已到期」与「立即收回」按钮消失。\n");
