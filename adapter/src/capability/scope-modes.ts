// 作用：Universal Scope 挡位的唯一事实来源——「范围挡位」既是策略配置值，也是治理页面上的选项，
// 两处必须完全一致；因此把枚举、展示文案与「哪些挡位允许作为默认值」集中在这里，供
// PolicyResolver / GovernancePolicy / Console API / 前端 UI 共用（避免前后端各自硬编码一份）。
// 本文件不引入任何 DSH/Cordis 依赖。
import { GuardError } from "./errors.js";
export type ScopeMode = "exact-arguments" | "fields" | "tool" | "sandbox-escalation";
export interface ScopeModeMeta {
  id: ScopeMode;
  /** 治理页面上的中文标签 */
  label: string;
  /** 一句话说明该挡位把什么纳入复用范围 */
  summary: string;
  /** 复用范围由宽到窄的风险提示（页面据此给出警示文案） */
  risk: "narrowest" | "narrow" | "wide" | "escalation";
  /** fields 挡位需要字段路径；其余挡位不使用该值 */
  defaultPaths?: readonly string[];
}
export const SCOPE_MODES: readonly ScopeModeMeta[] = [
  {
    id: "exact-arguments",
    label: "exact-arguments（参数完全一致）",
    summary: "仅当工具名与参数逐字节一致时复用授权；最保守，也是零配置默认值。",
    risk: "narrowest",
  },
  {
    id: "fields",
    label: "fields（按指定字段）",
    summary: "只把指定字段纳入复用键，其余参数变化不重新询问；未配置字段时退化为兜底字段集合。",
    risk: "narrow",
    defaultPaths: ["path", "file_path"],
  },
  {
    id: "sandbox-escalation",
    label: "sandbox-escalation（按工具与目标沙箱档位）",
    summary: "只对带沙箱升级参数的调用生效，复用键为「工具名 + 目标档位」，且会提升会话沙箱模式。",
    risk: "escalation",
  },
  {
    id: "tool",
    label: "tool（整个工具）",
    summary: "同一会话内只要工具名相同即复用——范围最宽，显式选择才会生效。",
    risk: "wide",
  },
];
export const SCOPE_MODE_IDS: readonly ScopeMode[] = SCOPE_MODES.map((mode) => mode.id);
/**
 * 允许作为「默认范围挡位」的挡位。
 * 【为什么不包含 tool】规格第 7 条强制规则：`tool` 宽 scope 只允许用户显式按工具配置，
 * 禁止作为默认值——否则任意一次批准都会变成「该工具在本会话内随便用」。
 */
export const DEFAULTABLE_SCOPE_MODES: readonly ScopeMode[] = ["exact-arguments", "fields", "sandbox-escalation"];
export function isScopeMode(value: unknown): value is ScopeMode {
  return typeof value === "string" && (SCOPE_MODE_IDS as readonly string[]).includes(value);
}
export function assertScopeMode(value: unknown, what: string): ScopeMode {
  // 作用：挡位校验（Fail Closed）——未知挡位一律拒绝，绝不回落到更宽的挡位
  if (!isScopeMode(value)) {
    throw new GuardError("LEASE_POLICY_INVALID", `${what} unknown scope mode: ${String(value)}`);
  }
  return value;
}
export function scopeModeMeta(mode: ScopeMode): ScopeModeMeta {
  const found = SCOPE_MODES.find((item) => item.id === mode);
  if (!found) throw new GuardError("LEASE_POLICY_INVALID", `unknown scope mode: ${String(mode)}`);
  return found;
}
