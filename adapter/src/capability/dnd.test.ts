import { describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { DndManager } from "./dnd.js";
import type { SandboxMode } from "./escalation.js";
function makeDnd(options?: { mode?: SandboxMode | undefined; maxMs?: number }) {
  // 作用：组装带可控时钟的 DndManager；modeOf 用可变引用模拟用户切换原生档位
  let now = 1_000_000;
  const audit = new AuditService();
  const mode = { value: options?.mode === undefined ? ("workspace-write" as SandboxMode | undefined) : options.mode };
  const manager = new DndManager({
    audit,
    modeOf: () => mode.value,
    maxWindowMs: () => options?.maxMs ?? 1_800_000,
    now: () => now,
  });
  return {
    manager,
    audit,
    mode,
    advance(ms: number) {
      now += ms;
    },
  };
}
const evalOf = (sessionId: string, mode?: SandboxMode) => ({
  sessionId,
  callId: "call-1",
  toolName: "pwsh",
  mode,
  display: "pwsh: npm install",
});
describe("DndManager（免打扰 = 限时完全访问的审批放行窗口）", () => {
  it("开启窗口：有到期时间、计数为 0，并写 DND_OPENED 审计", () => {
    const { manager, audit } = makeDnd();
    const view = manager.start("s1", 900);
    expect(view.sessionId).toBe("s1");
    expect(view.expiresAt - view.startedAt).toBe(900_000);
    expect(view.allowedCount).toBe(0);
    expect(audit.list().some((event) => event.decision === "DND_OPENED" && event.sessionId === "s1")).toBe(true);
  });
  it("完全访问档位拒绝开启（没有可放行的审批）", () => {
    const { manager } = makeDnd({ mode: "danger-full-access" });
    expect(() => manager.start("s1", 900)).toThrow(/DND_NOT_APPLICABLE/);
    expect(manager.view("s1")).toBeUndefined();
  });
  it("非法 TTL / 超过运行期上限一律拒绝", () => {
    const { manager } = makeDnd({ maxMs: 600_000 });
    expect(() => manager.start("s1", 0)).toThrow(/ttlSeconds/);
    expect(() => manager.start("s1", 1.5)).toThrow(/ttlSeconds/);
    expect(() => manager.start("s1", 601)).toThrow(/ttlSeconds/);
  });
  it("只放行带 requestedMode 的升级；没有目标档位的审批继续委派", () => {
    const { manager, audit } = makeDnd();
    manager.start("s1", 900);
    expect(manager.evaluate(evalOf("s1", "danger-full-access"))).toBe("allow");
    expect(manager.evaluate(evalOf("s1"))).toBe("delegate");
    expect(manager.evaluate(evalOf("s2", "danger-full-access"))).toBe("delegate");
    const view = manager.view("s1");
    expect(view?.allowedCount).toBe(1);
    expect(view?.recent[0]).toMatchObject({ toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(audit.list().filter((event) => event.decision === "DND_ALLOWED")).toHaveLength(1);
  });
  it("窗口到期后自动失效：不再放行，并写 DND_CLOSED(expired)", () => {
    const { manager, audit, advance } = makeDnd();
    manager.start("s1", 60);
    advance(60_000);
    expect(manager.view("s1")).toBeUndefined();
    expect(manager.evaluate(evalOf("s1", "danger-full-access"))).toBe("delegate");
    expect(audit.list().some((event) => event.decision === "DND_CLOSED" && /expired/.test(event.scopeDisplay ?? ""))).toBe(true);
  });
  it("手动结束：窗口立刻消失，evaluate 回到委派", () => {
    const { manager, audit } = makeDnd();
    manager.start("s1", 900);
    expect(manager.stop("s1", "user")).toBe(true);
    expect(manager.stop("s1", "user")).toBe(false);
    expect(manager.evaluate(evalOf("s1", "danger-full-access"))).toBe("delegate");
    expect(audit.list().some((event) => event.decision === "DND_CLOSED" && /user/.test(event.scopeDisplay ?? ""))).toBe(true);
  });
  it("延长窗口：总时长仍受 maxWindowMs 约束", () => {
    const { manager } = makeDnd({ maxMs: 1_800_000 });
    manager.start("s1", 600);
    const first = manager.extend("s1", 600);
    expect(first.expiresAt - first.startedAt).toBe(1_200_000);
    const second = manager.extend("s1", 600);
    expect(second.expiresAt - second.startedAt).toBe(1_800_000);
    expect(() => manager.extend("s1", 1)).toThrow(/within/);
    expect(() => manager.extend("s1", 0)).toThrow(/addSeconds/);
  });
  it("延长不存在的窗口拒绝（Fail Closed）", () => {
    const { manager } = makeDnd();
    expect(() => manager.extend("s1", 600)).toThrow(/no active/);
  });
  it("用户手改原生档位：sweep 立即结束窗口，切回原档位也不复活", () => {
    const { manager, audit, mode } = makeDnd({ mode: "workspace-write" });
    manager.start("s1", 900);
    mode.value = "read-only";
    manager.sweep();
    expect(manager.view("s1")).toBeUndefined();
    mode.value = "workspace-write";
    expect(manager.evaluate(evalOf("s1", "danger-full-access"))).toBe("delegate");
    expect(audit.list().some((event) => event.decision === "DND_CLOSED" && /mode-changed/.test(event.scopeDisplay ?? ""))).toBe(true);
  });
  it("重开窗口会替换旧窗口，并留下 restarted 关闭记录", () => {
    const { manager, audit } = makeDnd();
    const first = manager.start("s1", 300);
    const second = manager.start("s1", 900);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(audit.list().some((event) => event.decision === "DND_CLOSED" && /restarted/.test(event.scopeDisplay ?? ""))).toBe(true);
  });
  it("插件卸载 closeAll：所有窗口失效并写关闭记录", () => {
    const { manager, audit } = makeDnd();
    manager.start("s1", 900);
    manager.start("s2", 900);
    manager.closeAll("plugin-dispose");
    expect(manager.view("s1")).toBeUndefined();
    expect(manager.view("s2")).toBeUndefined();
    expect(audit.list().filter((event) => event.decision === "DND_CLOSED" && /plugin-dispose/.test(event.scopeDisplay ?? ""))).toHaveLength(2);
  });
});
