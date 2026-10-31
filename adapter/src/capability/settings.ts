// 作用：用户可见的「能力授权」设置——一个开关 + 三档范围模式 + 时长/目标档位。
// 与 `console/policy.ts` 的区别：policy 是**部署策略**（挡位与 TTL 的引擎参数），本文件是**产品设置**
// （用户开关、三种复用模式），两者互不覆盖。运行期改动不落盘（不写 profile 的 cordis.patch.yml）。
//
// 三档语义（2026-10-31 产品定稿）：
//   ① same-operation  同操作模式：工具 + 参数（去掉 justification）+ 目标档位完全一致才复用
//   ② same-family     同族模式：命中内置/学习到的操作族即复用（同文件 / 同工具 / 同命令）
//   ③ do-not-disturb  免打扰模式：整个会话提升到目标档位，到期自动回滚
import { isSandboxMode, SANDBOX_MODE_LABELS, type SandboxMode } from "./escalation.js";
export const GUARD_MODES = ["same-operation", "do-not-disturb"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];
export const GUARD_MODE_LABELS: Record<GuardMode, string> = {
  "same-operation": "同类复用",
  "do-not-disturb": "免打扰模式",
};
export const GUARD_MODE_SUMMARIES: Record<GuardMode, string> = {
  "same-operation": "同一条命令、同一个文件或目录、同一个只读工具都不再询问",
  "do-not-disturb": "整个会话放宽权限级别，到期自动回滚",
};
export function isGuardMode(value: unknown): value is GuardMode {
  // 兼容旧值：`same-family` 已合并进 `same-operation`（2026-10-31 产品精简为两档）
  if (value === "same-family") return true;
  return typeof value === "string" && (GUARD_MODES as readonly string[]).includes(value);
}
/** 作用：把旧挡位名归一成两档模型（`same-family` → `same-operation`）。 */
export function normalizeGuardMode(value: unknown): GuardMode {
  return value === "same-family" ? "same-operation" : (isGuardMode(value) ? value : "same-operation");
}
export interface GuardSettingsSnapshot {
  /** 用户开关：关闭后 Guard 完全不介入（所有 hook 直接透传，不签发任何授权） */
  enabled: boolean;
  mode: GuardMode;
  /** ①② 共用：一次批准管多久（秒） */
  reuseTtlSeconds: number;
  /** ③ 的目标档位与时长（秒） */
  dndTargetMode: SandboxMode;
  dndDurationSeconds: number;
  /** 每次成功变更递增，供前端做乐观并发控制 */
  revision: number;
}
export interface GuardSettingsPatch {
  enabled?: boolean;
  mode?: GuardMode;
  reuseTtlSeconds?: number;
  dndTargetMode?: SandboxMode;
  dndDurationSeconds?: number;
}
export interface GuardSettingsDeps {
  initial?: Partial<Omit<GuardSettingsSnapshot, "revision">>;
  /** TTL 上限来源（来自部署配置的 maxTtlSeconds） */
  maxTtlSeconds: number;
}
export class GuardSettingsError extends Error {
  constructor(message: string) {
    super(`GUARD_SETTINGS_INVALID: ${message}`);
    this.name = "GuardSettingsError";
  }
}
/** 默认值（与产品文案一致：5 分钟复用、15 分钟免打扰到完全访问）。 */
export const DEFAULT_GUARD_SETTINGS: Omit<GuardSettingsSnapshot, "revision"> = {
  enabled: true,
  mode: "same-operation",
  reuseTtlSeconds: 300,
  dndTargetMode: "danger-full-access",
  dndDurationSeconds: 900,
};
export class GuardSettings {
  private state: Omit<GuardSettingsSnapshot, "revision">;
  private revision = 1;
  constructor(private readonly deps: GuardSettingsDeps) {
    // 作用：构造期 Fail Closed——插件配置里写错的模式/时长必须在启动时就暴露
    const base = deps.initial ?? {};
    this.state = this.validate({
      enabled: base.enabled ?? DEFAULT_GUARD_SETTINGS.enabled,
      mode: base.mode ?? DEFAULT_GUARD_SETTINGS.mode,
      reuseTtlSeconds: base.reuseTtlSeconds ?? DEFAULT_GUARD_SETTINGS.reuseTtlSeconds,
      dndTargetMode: base.dndTargetMode ?? DEFAULT_GUARD_SETTINGS.dndTargetMode,
      dndDurationSeconds: base.dndDurationSeconds ?? DEFAULT_GUARD_SETTINGS.dndDurationSeconds,
    });
  }
  /** 作用：Guard 是否应该介入（用户开关）。false 时所有 hook 直接透传。 */
  get active(): boolean {
    return this.state.enabled;
  }
  get mode(): GuardMode {
    return this.state.mode;
  }
  get reuseTtlSeconds(): number {
    return this.state.reuseTtlSeconds;
  }
  snapshot(): GuardSettingsSnapshot {
    return { ...this.state, revision: this.revision };
  }
  update(patch: GuardSettingsPatch): GuardSettingsSnapshot {
    // 作用：合并后整体校验（任一非法则整次拒绝，绝不部分生效）
    const merged = this.validate({
      enabled: patch.enabled ?? this.state.enabled,
      mode: patch.mode ?? this.state.mode,
      reuseTtlSeconds: patch.reuseTtlSeconds ?? this.state.reuseTtlSeconds,
      dndTargetMode: patch.dndTargetMode ?? this.state.dndTargetMode,
      dndDurationSeconds: patch.dndDurationSeconds ?? this.state.dndDurationSeconds,
    });
    this.state = merged;
    this.revision += 1;
    return this.snapshot();
  }
  private validate(next: Omit<GuardSettingsSnapshot, "revision">): Omit<GuardSettingsSnapshot, "revision"> {
    if (typeof next.enabled !== "boolean") throw new GuardSettingsError("enabled must be a boolean");
    if (!isGuardMode(next.mode)) throw new GuardSettingsError(`unknown mode ${String(next.mode)}`);
    // 旧挡位名归一：same-family → same-operation（合并后不再有单独的同族挡位）
    next = { ...next, mode: normalizeGuardMode(next.mode) };
    if (!isSandboxMode(next.dndTargetMode)) throw new GuardSettingsError(`unknown dndTargetMode ${String(next.dndTargetMode)}`);
    if (next.dndTargetMode === "read-only") throw new GuardSettingsError("dndTargetMode must be wider than read-only");
    assertSeconds("reuseTtlSeconds", next.reuseTtlSeconds, this.deps.maxTtlSeconds);
    assertSeconds("dndDurationSeconds", next.dndDurationSeconds, this.deps.maxTtlSeconds);
    return { ...next };
  }
}
function assertSeconds(field: string, value: number, max: number): void {
  // 作用：秒数必须为正整数且不超过运行期上限（不静默裁剪，直接拒绝）
  if (!Number.isInteger(value) || value <= 0) throw new GuardSettingsError(`${field} must be a positive integer`);
  if (value > max) throw new GuardSettingsError(`${field} must be <= maxTtlSeconds (${max})`);
}
/** 作用：给人看的档位中文名（前端不再自己维护映射，服务端下发）。 */
export function dndTargetModeLabel(mode: SandboxMode): string {
  return SANDBOX_MODE_LABELS[mode] ?? mode;
}
