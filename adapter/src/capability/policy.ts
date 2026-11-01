import { GuardError } from "./errors.js";
import { isScopeMode, type ScopeMode } from "./scope-modes.js";
// 作用：Universal Policy 配置与解析（重构规格第 7 节）——V1 的 match 只支持精确 Tool Name
// （V1.1 再扩展 glob/regex）；TTL 非法（<=0 或 > maxTtlSeconds）一律抛错 Fail Closed，禁止静默 clamp。
export interface FieldsScopeConfig {
  mode: "fields";
  paths: string[];
}
export type ScopeConfig =
  | { mode: "exact-arguments" }
  | FieldsScopeConfig
  | { mode: "tool" };
export interface ToolLeaseRule {
  match: string;
  enabled?: boolean;
  ttlSeconds?: number;
  scope?: ScopeConfig;
}
export interface UniversalPolicyConfig {
  enabled: boolean;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  /** 默认范围挡位：可由治理页面在运行期切换（仍受 DEFAULTABLE_SCOPE_MODES 白名单约束） */
  defaultScope: ScopeMode;
  /** fields 挡位作为默认值时使用的字段路径（未配置时由 scope-modes 提供保守兜底） */
  defaultScopePaths?: readonly string[];
  rules: ToolLeaseRule[];
}
export interface ResolvedToolPolicy {
  enabled: boolean;
  ttlSeconds: number;
  scope: ScopeConfig;
}
export const DEFAULT_UNIVERSAL_POLICY: UniversalPolicyConfig = {
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: [],
};
export class PolicyResolver {
  private readonly getConfig: () => UniversalPolicyConfig;
  constructor(config: UniversalPolicyConfig | (() => UniversalPolicyConfig)) {
    // 作用：构造即校验配置合法性（Fail Closed）——max/default TTL 非法、rule scope 非法直接抛错。
    // 允许传入配置读取函数（而非配置对象）：治理页面在运行期调整「默认匹配范围挡位」时必须立即生效，
    // 而每次 resolve 都重新读取当前配置正是「挡位切换即时生效」的实现方式（不做任何缓存）。
    this.getConfig = typeof config === "function" ? config : () => config;
    const initial = this.getConfig();
    if (!Number.isInteger(initial.maxTtlSeconds) || initial.maxTtlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", "maxTtlSeconds must be a positive integer");
    }
    if (!Number.isInteger(initial.defaultTtlSeconds) || initial.defaultTtlSeconds <= 0 || initial.defaultTtlSeconds > initial.maxTtlSeconds) {
      throw new GuardError("LEASE_TTL_INVALID", "defaultTtlSeconds must be in (0, maxTtlSeconds]");
    }
    if (!isScopeMode(initial.defaultScope)) {
      throw new GuardError("LEASE_POLICY_INVALID", `unknown defaultScope: ${String(initial.defaultScope)}`);
    }
    for (const rule of initial.rules) this.validateRule(rule);
  }
  resolve(toolName: string): ResolvedToolPolicy {
    // 作用：按 Tool Name 解析生效策略——V1 精确匹配取第一条；规则 disabled 则该 Tool 不被 Guard 接管；
    // TTL 超上限或非法即抛错（上层捕获后保持原 ask，不签发 Lease）
    const config = this.getConfig();
    const fallbackScope = defaultScopeConfig(config);
    if (!config.enabled) {
      return { enabled: false, ttlSeconds: config.defaultTtlSeconds, scope: fallbackScope };
    }
    const rule = config.rules.find((r) => r.match === toolName);
    if (rule?.enabled === false) {
      return { enabled: false, ttlSeconds: config.defaultTtlSeconds, scope: fallbackScope };
    }
    const scope = rule?.scope ?? fallbackScope;
    const ttlSeconds = rule?.ttlSeconds ?? config.defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", `tool ${toolName} ttlSeconds must be a positive integer`);
    }
    if (ttlSeconds > config.maxTtlSeconds) {
      throw new GuardError("LEASE_TTL_INVALID", `tool ${toolName} ttlSeconds ${ttlSeconds} exceeds maxTtlSeconds ${config.maxTtlSeconds}`);
    }
    return { enabled: true, ttlSeconds, scope };
  }
  private validateRule(rule: ToolLeaseRule): void {
    // 作用：单条规则校验（Fail Closed）——match 必须非空字符串；scope/paths/ttl 非法直接拒绝
    if (typeof rule.match !== "string" || rule.match.length === 0) {
      throw new GuardError("LEASE_POLICY_INVALID", "rule.match must be a non-empty string");
    }
    if (rule.ttlSeconds !== undefined && (!Number.isInteger(rule.ttlSeconds) || rule.ttlSeconds <= 0)) {
      throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} ttlSeconds must be a positive integer`);
    }
    if (rule.scope !== undefined) {
      if (rule.scope.mode === "fields") {
        const paths = (rule.scope as FieldsScopeConfig).paths;
        if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p.length === 0)) {
          throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} fields scope requires non-empty string paths`);
        }
      } else if (!isScopeMode(rule.scope.mode)) {
        throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} unknown scope mode`);
      }
    }
  }
}
export function defaultScopeConfig(config: UniversalPolicyConfig): ScopeConfig {
  // 作用：把「默认范围挡位」编译成 ScopeConfig——fields 挡位使用显式配置的路径，
  // 未配置时回落到兜底路径。
  // 【注意（2026-10-31 修正）】兜底路径不是"安全网"：`ScopeResolver.resolveFields` 遇到缺失字段会
  // Fail Closed 抛错，Guard 因此不接管，结果是该工具**永远无法复用授权**（每次都要问）。
  // 所以 fields 已从 DEFAULTABLE_SCOPE_MODES 移除，只能按工具在 rules 里显式配置。
  if (config.defaultScope === "fields") {
    const configured = config.defaultScopePaths;
    const paths = configured && configured.length > 0 ? [...configured] : ["path", "file_path"];
    return { mode: "fields", paths };
  }
  if (config.defaultScope === "tool") return { mode: "tool" };
  return { mode: "exact-arguments" };
}
