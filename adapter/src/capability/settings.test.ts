import { describe, expect, it } from "vitest";
import { DEFAULT_GUARD_SETTINGS, GuardSettings, isGuardMode } from "./settings.js";
describe("GuardSettings（开关 + 复用时长 + 免打扰默认时长）", () => {
  it("默认值：启用 + 30 分钟复用 + 15 分钟免打扰", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    expect(settings.active).toBe(true);
    expect(settings.reuseTtlSeconds).toBe(DEFAULT_GUARD_SETTINGS.reuseTtlSeconds);
    expect(settings.snapshot()).toMatchObject({ ...DEFAULT_GUARD_SETTINGS, revision: 1 });
  });
  it("关闭开关 / 修改时长即时生效，revision 递增", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    const off = settings.update({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(settings.active).toBe(false);
    expect(off.revision).toBe(2);
    const updated = settings.update({ reuseTtlSeconds: 120, dndDurationSeconds: 300 });
    expect(updated).toMatchObject({ enabled: false, reuseTtlSeconds: 120, dndDurationSeconds: 300, revision: 3 });
    // 关闭开关不影响其它字段：重新打开后时长保持
    expect(settings.update({ enabled: true })).toMatchObject({ enabled: true, reuseTtlSeconds: 120, dndDurationSeconds: 300 });
  });
  it("非法值整体拒绝（Fail Closed），已生效的值保持不变", () => {
    const settings = new GuardSettings({ maxTtlSeconds: 1800 });
    expect(() => settings.update({ reuseTtlSeconds: 0 })).toThrow(/positive integer/);
    expect(() => settings.update({ reuseTtlSeconds: 1801 })).toThrow(/maxTtlSeconds/);
    expect(() => settings.update({ dndDurationSeconds: 1.5 })).toThrow(/positive integer/);
    // 一次 patch 里只要有一项非法，整次拒绝（不做部分应用）
    expect(() => settings.update({ enabled: false, reuseTtlSeconds: -1 })).toThrow(/GUARD_SETTINGS_INVALID/);
    expect(settings.snapshot()).toMatchObject({ enabled: true, reuseTtlSeconds: DEFAULT_GUARD_SETTINGS.reuseTtlSeconds });
  });
  it("构造期就校验插件配置（写错时长不应等到页面打开才炸）", () => {
    expect(() => new GuardSettings({ maxTtlSeconds: 1800, initial: { dndDurationSeconds: 0 } })).toThrow(/GUARD_SETTINGS_INVALID/);
    expect(() => new GuardSettings({ maxTtlSeconds: 60, initial: { reuseTtlSeconds: 120 } })).toThrow(/maxTtlSeconds/);
  });
  it("isGuardMode 仅作为挡位菜单的 UI 目录（不再持久化）", () => {
    expect(isGuardMode("same-operation")).toBe(true);
    expect(isGuardMode("same-family")).toBe(true);
    expect(isGuardMode("do-not-disturb")).toBe(true);
    expect(isGuardMode("exact-arguments")).toBe(false);
  });
});
