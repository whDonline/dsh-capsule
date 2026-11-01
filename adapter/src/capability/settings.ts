// 作用：用户可见的「能力授权」设置——开关 + 复用时长 + 免打扰默认时长。
// 与 `console/policy.ts` 的区别：policy 是**部署策略**（挡位与 TTL 的引擎参数），本文件是**产品设置**
// （用户开关、时长），两者互不覆盖。运行期改动不落盘（不写 profile 的 cordis.patch.yml）。
//
// 重要（2026-11-01 定稿）：免打扰**不是**持久化"模式"，而是一个有界窗口（见 capability/dnd.ts）。
// GUARD_MODES 仅保留为输入框挡位菜单的展示目录，不再写入设置、也不参与权限判定。
export const GUARD_MODES = ["same-operation", "do-not-disturb"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];
export const GUARD_MODE_LABELS: Record<GuardMode, string> = {
  "same-operation": "短期授权",
  "do-not-disturb": "免打扰",
};
export const GUARD_MODE_SUMMARIES: Record<GuardMode, string> = {
  "same-operation": "同一条命令、同一个文件或目录、同一个只读工具都不再询问",
  "do-not-disturb": "限时完全访问：窗口内自动批准沙箱升级，结束或到期立即恢复询问",
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
  /** ①② 共用：一次批准管多久（秒） */
  reuseTtlSeconds: number;
  /** 免打扰窗口的默认时长（秒）。免打扰本身是窗口，不是持久化"模式"。 */
  dndDurationSeconds: number;
  /** 每次成功变更递增，供前端做乐观并发控制 */
  revision: number;
}
export interface GuardSettingsPatch {
  enabled?: boolean;
  reuseTtlSeconds?: number;
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
/** 默认值（与产品文案一致：30 分钟复用、15 分钟免打扰）。 */
export const DEFAULT_GUARD_SETTINGS: Omit<GuardSettingsSnapshot, "revision"> = {
  enabled: true,
  // 默认 30 分钟：短期授权的定位是"一次开发会话"，5 分钟覆盖不到连续开发/提交的节奏
  reuseTtlSeconds: 1800,
  dndDurationSeconds: 900,
};
export class GuardSettings {
  private state: Omit<GuardSettingsSnapshot, "revision">;
  private revision = 1;
  constructor(private readonly deps: GuardSettingsDeps) {
    // 作用：构造期 Fail Closed——插件配置里写错的时长必须在启动时就暴露
    const base = deps.initial ?? {};
    this.state = this.validate({
      enabled: base.enabled ?? DEFAULT_GUARD_SETTINGS.enabled,
      reuseTtlSeconds: base.reuseTtlSeconds ?? DEFAULT_GUARD_SETTINGS.reuseTtlSeconds,
      dndDurationSeconds: base.dndDurationSeconds ?? DEFAULT_GUARD_SETTINGS.dndDurationSeconds,
    });
  }
  /** 作用：Guard 是否应该介入（用户开关）。false 时所有 hook 直接透传。 */
  get active(): boolean {
    return this.state.enabled;
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
      reuseTtlSeconds: patch.reuseTtlSeconds ?? this.state.reuseTtlSeconds,
      dndDurationSeconds: patch.dndDurationSeconds ?? this.state.dndDurationSeconds,
    });
    this.state = merged;
    this.revision += 1;
    return this.snapshot();
  }
  private validate(next: Omit<GuardSettingsSnapshot, "revision">): Omit<GuardSettingsSnapshot, "revision"> {
    if (typeof next.enabled !== "boolean") throw new GuardSettingsError("enabled must be a boolean");
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
