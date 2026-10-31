import { describe, expect, it } from "vitest";
import { DEFAULT_GUARD_SETTINGS, GuardSettings, isGuardMode } from "./settings.js";
describe("GuardSettings（用户可见的三档设置）", () => {
  it("默认值：启用 + 同操作模式 + 300 秒 + 免打扰到完全访问 900 秒", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    expect(settings.active).toBe(true);
    expect(settings.mode).toBe("same-operation");
    expect(settings.snapshot()).toMatchObject({ ...DEFAULT_GUARD_SETTINGS, revision: 1 });
  });
  it("切换模式 / 关闭开关即时生效，revision 递增", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    expect(settings.update({ mode: "same-family" }).mode).toBe("same-family");
    const off = settings.update({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(settings.active).toBe(false);
    expect(off.revision).toBe(3);
    // 关闭开关不影响其它字段：重新打开后仍是同族模式
    expect(settings.update({ enabled: true }).mode).toBe("same-family");
  });
  it("非法值整体拒绝（Fail Closed），已生效的值保持不变", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    expect(() => settings.update({ mode: "wider-everything" as never })).toThrow(/GUARD_SETTINGS_INVALID/);
    expect(() => settings.update({ reuseTtlSeconds: 0 })).toThrow(/positive integer/);
    expect(() => settings.update({ reuseTtlSeconds: 1801 })).toThrow(/maxTtlSeconds/);
    expect(() => settings.update({ dndDurationSeconds: 1.5 })).toThrow(/positive integer/);
    expect(() => settings.update({ dndTargetMode: "read-only" })).toThrow(/wider than read-only/);
    expect(() => settings.update({ dndTargetMode: "root" as never })).toThrow(/GUARD_SETTINGS_INVALID/);
    // 一次 patch 里只要有一项非法，整次拒绝（不做部分应用）
    expect(() => settings.update({ enabled: false, reuseTtlSeconds: -1 })).toThrow(/GUARD_SETTINGS_INVALID/);
    expect(settings.snapshot()).toMatchObject({ enabled: true, mode: "same-operation", reuseTtlSeconds: DEFAULT_GUARD_SETTINGS.reuseTtlSeconds });
  });
  it("构造期就校验插件配置（写错模式不应等到页面打开才炸）", () => {
    expect(() => new GuardSettings({ maxTtlSeconds: 1800, initial: { mode: "nope" as never } })).toThrow(/GUARD_SETTINGS_INVALID/);
    expect(() => new GuardSettings({ maxTtlSeconds: 60, initial: { reuseTtlSeconds: 120 } })).toThrow(/maxTtlSeconds/);
  });
  it("isGuardMode 只认三档", () => {
    expect(isGuardMode("same-operation")).toBe(true);
    expect(isGuardMode("same-family")).toBe(true);
    expect(isGuardMode("do-not-disturb")).toBe(true);
    expect(isGuardMode("exact-arguments")).toBe(false);
  });
});
