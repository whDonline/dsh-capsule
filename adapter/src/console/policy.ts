// 作用：治理策略运行期配置（Phase 4 治理控制台）——把「授权默认匹配的范围挡位」等策略项暴露给
// 治理页面，同时保证：① 只有白名单内的挡位可被选中；② 运行期改动不落盘（不擅自改写 profile 的
// cordis.patch.yml——那由用户与 DSH 插件管理器拥有）；③ 每次变更都返回完整快照供审计与回显。
//
// 【安全边界（不得突破）】
//   - 运行期只能改 defaultScope / defaultTtlSeconds / maxTtlSeconds 三项；
//   - `enabled` 与 `rules` 属于部署配置（profile patch），运行期一律不可改：治理页面不能把 Guard
//     关掉，也不能凭空给某个工具造出一条授权规则（那等于绕开审批给自己放权）；
//   - 任何非法值一律 Fail Closed 抛错，不做静默 clamp。
import { DEFAULT_UNIVERSAL_POLICY, type UniversalPolicyConfig } from "../capability/policy.js";
import { isScopeMode, type ScopeMode } from "../capability/scope-modes.js";
export interface ConsoleRuntimePolicy {
  /** 下发授权时使用的默认范围挡位（exact-arguments / fields / tool） */
  defaultScope: ScopeMode;
  /** 默认 TTL（秒） */
  defaultTtlSeconds: number;
  /** TTL 上限（秒），任何规则的 TTL 都不得超过它 */
  maxTtlSeconds: number;
}
export interface ConsolePolicySnapshot extends ConsoleRuntimePolicy {
  /** 部署配置项（只读）——运行期不可修改，仅供治理页面展示来源与理由 */
  enabled: boolean;
  rules: readonly { match: string; enabled: boolean; ttlSeconds: number; scopeMode: ScopeMode }[];
  /** 部署配置来源（默认 "plugin-config"，便于用户知道该去哪里改） */
  source: string;
  /** 每次成功变更递增的修订号，供前端做乐观并发控制 */
  revision: number;
}
export interface ConsoleRuntimePolicyPatch {
  defaultScope?: ScopeMode;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  /** 可选：仅当配置由外部权威提供时才允许写入（Guard 自身不写 profile 文件） */
  persist?: (policy: ConsoleRuntimePolicy) => void | Promise<void>;
}
export interface GovernancePolicyDeps {
  /** 运行期初值（默认取插件配置，缺省与 DEFAULT_UNIVERSAL_POLICY 一致） */
  initial?: Partial<ConsoleRuntimePolicy>;
  /** 部署配置（只读展示） */
  deployment?: Pick<UniversalPolicyConfig, "enabled" | "rules"> & { defaultScopePaths?: readonly string[] };
  source?: string;
}
export class ConsolePolicyError extends Error {
  constructor(public readonly code: "GUARD_CONSOLE_INVALID" | "GUARD_CONSOLE_CONFLICT", message: string) {
    super(`${code}: ${message}`);
    this.name = "ConsolePolicyError";
  }
}
export class GovernancePolicy {
  private runtime: ConsoleRuntimePolicy;
  private revision = 1;
  constructor(private readonly deps: GovernancePolicyDeps = {}) {
    // 作用：构造期校验初值——插件配置里写错挡位或 TTL 必须在启动时就暴露（Fail Closed），
    // 而不是等到治理页面被打开时才失败
    const base = deps.initial ?? {};
    this.runtime = this.validate({
      defaultScope: base.defaultScope ?? DEFAULT_UNIVERSAL_POLICY.defaultScope,
      defaultTtlSeconds: base.defaultTtlSeconds ?? DEFAULT_UNIVERSAL_POLICY.defaultTtlSeconds,
      maxTtlSeconds: base.maxTtlSeconds ?? DEFAULT_UNIVERSAL_POLICY.maxTtlSeconds,
    });
  }
  get current(): ConsoleRuntimePolicy {
    // 作用：读取当前运行期策略（返回副本，调用方无法就地改写内部状态）
    return { ...this.runtime };
  }
  get config(): UniversalPolicyConfig {
    // 作用：组装成 PolicyResolver 需要的完整配置——enabled / rules 固定来自部署配置，
    // 运行期可变的只有挡位与 TTL；PolicyResolver 每次 resolve 都读取本对象，因此改动即时生效
    const deployment = this.deps.deployment ?? { enabled: DEFAULT_UNIVERSAL_POLICY.enabled, rules: DEFAULT_UNIVERSAL_POLICY.rules, defaultScopePaths: DEFAULT_UNIVERSAL_POLICY.defaultScopePaths };
    return {
      enabled: deployment.enabled,
      rules: deployment.rules as UniversalPolicyConfig["rules"],
      defaultScopePaths: deployment.defaultScopePaths,
      ...this.runtime,
    };
  }
  snapshot(): ConsolePolicySnapshot {
    // 作用：治理视图投影——运行期策略 + 只读部署配置（规则只暴露匹配名、TTL 与挡位，不含任何 Secret）
    const deployment = this.deps.deployment ?? { enabled: DEFAULT_UNIVERSAL_POLICY.enabled, rules: DEFAULT_UNIVERSAL_POLICY.rules, defaultScopePaths: DEFAULT_UNIVERSAL_POLICY.defaultScopePaths };
    return {
      ...this.runtime,
      enabled: deployment.enabled,
      rules: deployment.rules.map((rule) => ({
        match: rule.match,
        enabled: rule.enabled !== false,
        ttlSeconds: rule.ttlSeconds ?? this.runtime.defaultTtlSeconds,
        scopeMode: (rule.scope?.mode ?? this.runtime.defaultScope) as ScopeMode,
      })),
      source: this.deps.source ?? "plugin-config",
      revision: this.revision,
    };
  }
  async update(patch: ConsoleRuntimePolicyPatch): Promise<ConsolePolicySnapshot> {
    // 作用：应用一次运行期策略变更——先合并再整体校验（Fail Closed：任何一项非法则整次拒绝，
    // 绝不部分生效），校验通过后才调用持久化 hook，最后递增 revision 并返回新快照。
    // 注意：本方法不修改 enabled / rules（见文件头安全边界）。
    const merged = this.validate({
      defaultScope: patch.defaultScope ?? this.runtime.defaultScope,
      defaultTtlSeconds: patch.defaultTtlSeconds ?? this.runtime.defaultTtlSeconds,
      maxTtlSeconds: patch.maxTtlSeconds ?? this.runtime.maxTtlSeconds,
    });
    if (patch.persist) await patch.persist({ ...merged });
    this.runtime = merged;
    this.revision += 1;
    return this.snapshot();
  }
  private validate(next: ConsoleRuntimePolicy): ConsoleRuntimePolicy {
    // 作用：单点校验（Fail Closed）——挡位必须在白名单内；TTL 必须是正整数且 default <= max
    if (!isScopeMode(next.defaultScope)) {
      throw new ConsolePolicyError("GUARD_CONSOLE_INVALID", `unknown defaultScope ${String(next.defaultScope)}`);
    }
    if (!Number.isInteger(next.maxTtlSeconds) || next.maxTtlSeconds <= 0) {
      throw new ConsolePolicyError("GUARD_CONSOLE_INVALID", "maxTtlSeconds must be a positive integer");
    }
    if (!Number.isInteger(next.defaultTtlSeconds) || next.defaultTtlSeconds <= 0 || next.defaultTtlSeconds > next.maxTtlSeconds) {
      throw new ConsolePolicyError("GUARD_CONSOLE_INVALID", "defaultTtlSeconds must be in (0, maxTtlSeconds]");
    }
    return { ...next };
  }
}
