// 作用：本地手工冒烟脚本（开发期用，不参与构建产物）——启动一个带示例数据的只在内存中运行的
// Guard 治理接口，便于在浏览器里直接检查页面（http://127.0.0.1:8799/）。
// 2026-10-31：示例数据改为「会话视图 + 两个独立状态」，并接上真实的收缩型动作，因此页面上
// 的「立即收回 / 立即回滚档位」在冒烟环境里点得动（与生产同一份 GuardActions）。
// 用法：node scripts/smoke-console.mjs
import { AuditService } from "../adapter/dist/audit/audit-service.js";
import { LeaseManager } from "../adapter/dist/capability/lease-manager.js";
import { MemoryLeaseStore } from "../adapter/dist/capability/lease-store.js";
import { SandboxGrantManager } from "../adapter/dist/capability/sandbox-grant.js";
import { GuardActions } from "../adapter/dist/console/actions.js";
import { GovernanceConsole } from "../adapter/dist/console/console-service.js";
import { GovernancePolicy } from "../adapter/dist/console/policy.js";
import { startConsoleServer } from "../adapter/dist/console/http-server.js";

const audit = new AuditService();
const leases = new LeaseManager(new MemoryLeaseStore());
// 作用：沙箱宿主替身——用 sessionId 字符串当 session 对象，冒烟环境里不触碰任何真实会话
const modes = new Map();
const sandboxHost = {
  sessionSandboxMode: (session) => modes.get(String(session)) ?? "workspace-write",
  setSessionSandboxMode: (session, mode) => modes.set(String(session), mode),
};
const grants = new SandboxGrantManager(sandboxHost, leases);
const policy = new GovernancePolicy({
  initial: { defaultScope: "sandbox-escalation", defaultTtlSeconds: 300, maxTtlSeconds: 1800 },
  deployment: { enabled: true, rules: [{ match: "pwsh", ttlSeconds: 300, scope: { mode: "sandbox-escalation" } }] },
});
// 会话一：沙箱授权已生效并真正提升了档位（页面上应显示「生效中 · 已提升」）
const escalated = await leases.issue({
  sessionId: "session-smoke-1",
  toolName: "pwsh",
  scope: { kind: "sandbox-escalation", key: "deadbeef", display: "tool=pwsh 沙箱升级至 danger-full-access" },
  ttlSeconds: 300,
  kind: "sandbox-mode",
  sourceCallId: "call-1",
});
await grants.applyGrant({ leaseId: escalated.id, sessionId: "session-smoke-1", session: "session-smoke-1", toolName: "pwsh", requestedMode: "danger-full-access" });
// 会话二：普通参数授权（页面上应显示「生效中 · 不涉及沙箱档位」）
await leases.issue({
  sessionId: "session-smoke-2",
  toolName: "deploy.preview",
  scope: { kind: "exact-arguments", key: "cafebabe", display: 'tool=deploy.preview args={"environment":"staging"}' },
  ttlSeconds: 45,
});
for (const [decision, sessionId, toolName, extra] of [
  ["ASK", "session-smoke-2", "deploy.preview", { scopeDisplay: 'tool=deploy.preview args={"environment":"staging"}' }],
  ["LEASE_ISSUED", "session-smoke-2", "deploy.preview", { leaseId: "smoke-lease-2" }],
  ["LEASE_REUSED", "session-smoke-2", "deploy.preview", { leaseId: "smoke-lease-2" }],
  ["SANDBOX_MODE_RAISED", "session-smoke-1", "pwsh", { scopeDisplay: "会话沙箱模式提升至 danger-full-access" }],
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
  // 与生产同源的两个数据来源：沙箱状态来自 SandboxGrantManager，会话名来自会话标题（此处用兜底映射演示）
  sandbox: { states: () => grants.grantStates(), lastOutcomeOf: (sessionId) => grants.lastOutcomeOf(sessionId) },
  sessions: { describe: (sessionId) => ({ label: labels[sessionId] ?? `会话 ${sessionId.slice(0, 8)}`, source: labels[sessionId] ? "title" : "id", cwd: "D:\\gitpro\\demo" }) },
});
const actions = new GuardActions({
  leases,
  sandbox: grants,
  audit,
  // 冒烟环境用 sessionId 字符串充当会话对象（与 sandboxHost 的键一致），这样「免打扰窗口」也能点得动
  resolveSession: (sessionId) => (labels[sessionId] ? sessionId : undefined),
  maxTtlSeconds: () => policy.snapshot().maxTtlSeconds,
});
const handle = await startConsoleServer({ console: govConsole, policy, actions, sweepIntervalMs: 30000, host: "127.0.0.1", port: 8799 });
process.stdout.write(`smoke console: ${handle.url}\n`);
process.stdout.write(`提示：等第一会话的 300s 授权过期后刷新页面，可看到「已到期 · 待回滚」与「立即回滚档位」。\n`);
