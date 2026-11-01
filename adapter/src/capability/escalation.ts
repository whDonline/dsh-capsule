// 作用：DSH 沙箱升级请求的确定性识别与档位文案（P0-1，2026-11-01 收窄）。
//
// 本插件【不再提升会话沙箱档位】，因此这里只剩两件事：
//   1. 从工具参数里识别「这次调用申请了升级到哪一档」——操作指纹与免打扰窗口都需要它
//      （同一条命令「升到工作区可写」与「升到完全访问」必须算两条不同的操作）；
//   2. 档位的中文说法（唯一事实来源）。
// 背景（2026-09-14 对已安装 DSH 源码核实，见 docs/集成基线-真实DSH行为.md）：
//   - 真实审批来自 pwsh/bash/fs 工具体内的 approveEscalation → ctx.approval.request(...)；
//   - 该请求载荷不含 tool arguments，因此操作指纹必须在 tools/execute 阶段预先记录。
/** DSH 沙箱模式闭集，与 @deepseek-ai/dsh-sandbox-policy 的 SANDBOX_MODES 逐字一致（源码核实），
 * 顺序为从最严到最宽。 */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
/** DSH 用于请求沙箱升级的参数键（工具体读取、DSH 自行校验，本模块只识别不改写）。 */
export const ESCALATION_PERMISSION_KEY = "sandbox_permissions";
/** 升级理由的参数键——只用于判断「这是一次可识别的升级请求」，绝不参与任何哈希或判定。 */
const ESCALATION_JUSTIFICATION_KEY = "justification";
// 作用：识别出的一次沙箱升级请求——只保留 Guard 生成指纹与审计所需字段。
// 注意：justification 是模型自由文本，【绝不】参与指纹计算（否则每次措辞不同会导致授权无法复用，
// 且等于把安全边界建立在模型输出上）；它只用于人可读展示，且必须截断。
export interface EscalationRequest {
  requestedMode: SandboxMode;
  justification: string;
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
  // 任一不满足返回 undefined，含义是「本次调用不是可识别的沙箱升级」→ 上层按普通调用处理
  //（指纹不含目标档位；免打扰窗口也不会为它自动放行）。这里刻意不抛错：DSH 自己会对
  // `sandbox_permissions` 与 `justification` 的配对做校验并给出面向模型的错误，Guard 重复校验
  // 只会产生两条互相矛盾的错误信息。
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const mode = record[ESCALATION_PERMISSION_KEY];
  if (!isSandboxMode(mode)) return undefined;
  const justification = record[ESCALATION_JUSTIFICATION_KEY];
  if (typeof justification !== "string" || justification.length === 0) return undefined;
  return { requestedMode: mode, justification };
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
