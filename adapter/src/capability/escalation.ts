import { sha256Scope } from "./canonical.js";
// 作用：DSH 沙箱升级（sandbox escalation）的确定性识别与语义 Scope 构造（P0-1）。
// 背景（2026-09-14 对已安装 DSH 源码核实，见 docs/集成基线-真实DSH行为.md）：
//   1. `tools/pre-execute` 默认下游决策为 allow，标准 profile 下没有任何 shipped listener 返回 ask，
//      因此 Universal Gate 不会在那里看到 ask；
//   2. 真实审批来自 pwsh/bash/fs 工具体内的 approveEscalation → ctx.approval.request(...)，
//      该请求发生在 tools/pre-execute 决策之后，且 approval/request 载荷【不含 tool arguments】
//      （只有 agent/toolName/callId/reason/signal），所以 Scope 必须在 tools/execute 阶段预先记录；
//   3. `tools/execute` wrapper 在工具体之前运行、exec.arguments 完整可用，是唯一能同时拿到
//      callId 与 arguments 的时机。
// 本模块只做「确定性识别 + 语义 Scope」，不猜测、不参与 DSH 参数校验（校验仍由 DSH 自身完成）。
/** DSH 沙箱模式闭集，与 @deepseek-ai/dsh-sandbox-policy 的 SANDBOX_MODES 逐字一致（源码核实），
 * 顺序为从最严到最宽，比较宽窄时依赖该顺序。 */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
/** DSH 用于请求沙箱升级的参数键（工具体读取、DSH 自行校验，本模块只识别不改写）。 */
export const ESCALATION_PERMISSION_KEY = "sandbox_permissions";
export const ESCALATION_JUSTIFICATION_KEY = "justification";
// 作用：识别出的一次沙箱升级请求——只保留 Guard 生成 Scope 与审计所需字段。
// 注意：justification 是模型自由文本，【绝不】参与 Scope 计算（否则每次措辞不同会导致 Lease 无法复用，
// 且等于把安全边界建立在模型输出上）；它只用于人可读展示，且必须截断。
export interface EscalationRequest {
  requestedMode: SandboxMode;
  justification: string;
}
/** 语义 Scope 的稳定 key 输入：只含工具名与目标模式，不含任何模型自由文本、不含参数原文。 */
export interface EscalationScopeInput {
  toolName: string;
  requestedMode: SandboxMode;
}
export function isSandboxMode(value: unknown): value is SandboxMode {
  // 作用：运行时白名单校验（Fail Closed）——非闭集字符串一律不认，避免 DSH 契约变化时静默放宽
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}
export function parseEscalation(args: unknown): EscalationRequest | undefined {
  // 作用：从工具参数中确定性识别沙箱升级请求——仅当【同时】满足以下全部条件才返回结果：
  //   1. args 是普通对象（非 null / 非数组）；
  //   2. args.sandbox_permissions 是 SANDBOX_MODES 中的字面量；
  //   3. args.justification 是非空字符串。
  // 任一不满足返回 undefined，含义是「本次调用不是可识别的沙箱升级」→ 上层完全不接管、不记录、
  // 不签发 Lease。这里刻意不抛错：DSH 自己会对 `sandbox_permissions` 与 `justification` 的配对做
  // 校验并给出面向模型的错误，Guard 重复校验只会产生两条互相矛盾的错误信息。
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const mode = record[ESCALATION_PERMISSION_KEY];
  if (!isSandboxMode(mode)) return undefined;
  const justification = record[ESCALATION_JUSTIFICATION_KEY];
  if (typeof justification !== "string" || justification.length === 0) return undefined;
  return { requestedMode: mode, justification };
}
export function escalationScopeKey(input: EscalationScopeInput): string {
  // 作用：生成沙箱升级的语义 Scope key —— SHA-256(toolName + 目标模式)，与参数无关：
  // 用户批准「本会话内 pwsh 可升级到 danger-full-access」后，后续【任意】同类升级都能复用，
  // 这正是 DSH 原生缺失的「有界授权」语义；同时因为只按 (工具, 目标模式) 取键，
  // 不会把授权面扩大到别的工具或别的模式。
  return sha256Scope({ kind: "sandbox-escalation", tool: input.toolName, mode: input.requestedMode });
}
/** 展示用的 justification 最大长度——审计与 Approval reason 都不允许无限长文本。 */
export const ESCALATION_DISPLAY_MAX_LENGTH = 120;
export function escalationScopeDisplay(input: EscalationScopeInput, justification?: string): string {
  // 作用：生成脱敏、截断后的展示文本（给用户看的人可读说明）——只含工具名与目标模式，
  // justification 仅在提供时附加并强制截断；文本来自模型，因此在展示场景需假定其不可信。
  const head = `tool=${input.toolName} 沙箱升级至 ${input.requestedMode}`;
  if (typeof justification !== "string" || justification.length === 0) return head;
  const text = justification.length > ESCALATION_DISPLAY_MAX_LENGTH ? `${justification.slice(0, ESCALATION_DISPLAY_MAX_LENGTH)}…` : justification;
  return `${head}（模型理由：${text}）`;
}
export function isModeWiderThan(candidate: SandboxMode, current: SandboxMode): boolean {
  // 作用：判断目标模式是否严格宽于当前模式——只有严格更宽才值得提升会话模式；
  // 使用 SANDBOX_MODES 的声明顺序（从最严到最宽）做确定性比较，避免维护第二张映射表。
  return SANDBOX_MODES.indexOf(candidate) > SANDBOX_MODES.indexOf(current);
}
/** 档位的中文说法——**唯一事实来源**：宿主侧（决策记录 / 动作 / 治理视图）都从这里取，
 * 前端不再自己维护映射表（服务端会把文本随快照下发）。 */
export const SANDBOX_MODE_LABELS: Record<SandboxMode, string> = {
  "read-only": "只读",
  "workspace-write": "工作区可写",
  "danger-full-access": "完全访问",
};
export function sandboxModeLabel(mode: SandboxMode | undefined): string {
  // 作用：未知/缺失时给「未知」而不是编造——UI 文案不得猜测宿主状态
  return mode ? (SANDBOX_MODE_LABELS[mode] ?? mode) : "未知";
}
