import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { GovernanceConsole } from "./console-service.js";
import { CONSOLE_CLIENT_JS } from "./console-ui.js";
import { startConsoleServer, type ConsoleHttpHandle } from "./http-server.js";
import { GovernancePolicy } from "./policy.js";
// 作用：治理台前端两条真实执行路径的验证（无需浏览器）：
//   ① 共享 UI（console-ui.ts 里的脚本）挂载到真实治理接口，渲染出「授权 + 剩余时间」；
//   ② DSH 客户端半边（adapter/client.js）在最小 DOM/React 替身下完成槽位注册与面板挂载。
// 为什么需要这一层：这两个文件是面板能否显示的唯一关键路径，但它们在 Node 测试里不会被 TS 编译，
// 语法错误或字段拼错只会在浏览器里静默失败（面板空白 / slot entry crashed），因此必须在这里跑通。
interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  children: FakeNode[];
  dataset: Record<string, string>;
  style: Record<string, string>;
  hidden: boolean;
  id: string;
  type: string;
  value: string;
  disabled: boolean;
  placeholder: string;
  autocomplete: string;
  colSpan?: number;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  appendChild(child: FakeNode): FakeNode;
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode;
  setAttribute(name: string, value: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  querySelectorAll(): FakeNode[];
  childNodes: FakeNode[];
}
function makeDocument(): { head: FakeNode; documentElement: FakeNode; createElement(tag: string): FakeNode; getElementById(id: string): FakeNode | null } {
  // 作用：最小 DOM 替身——只实现前端脚本真正用到的 API（createElement/appendChild/textContent/classList…）
  function create(tag: string): FakeNode {
    const classes = new Set<string>();
    let text = "";
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      className: "",
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      id: "",
      type: "",
      value: "",
      disabled: false,
      placeholder: "",
      autocomplete: "",
      classList: {
        add: (name) => void classes.add(name),
        remove: (name) => void classes.delete(name),
        contains: (name) => classes.has(name),
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      insertBefore(child) {
        this.children.unshift(child);
        return child;
      },
      setAttribute(name, value) {
        (this as unknown as Record<string, unknown>)[name] = value;
      },
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
      get childNodes() {
        return this.children;
      },
    };
    Object.defineProperty(node, "className", {
      get: () => [...classes].join(" "),
      set: (value: string) => {
        classes.clear();
        for (const item of String(value).split(/\s+/)) if (item) classes.add(item);
      },
    });
    // 与真实 DOM 一致：写 textContent 会清空子节点（前端脚本正是靠这个清空表格/容器的）
    Object.defineProperty(node, "textContent", {
      get: () => text,
      set: (value: string) => {
        text = value === undefined || value === null ? "" : String(value);
        node.children.length = 0;
      },
    });
    return node;
  }
  const head = create("head");
  const documentElement = create("html");
  return { head, documentElement, createElement: create, getElementById: () => null };
}
function texts(node: FakeNode): string[] {
  // 作用：递归取出整棵替身树的文本（含元素自身 textContent），用于断言"页面上确实出现了某段文案"
  const out: string[] = [];
  const walk = (current: FakeNode): void => {
    if (current.textContent) out.push(current.textContent);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}
function textsExcept(node: FakeNode, skipClass: string): string[] {
  // 作用：与 texts 类似，但跳过指定 class 的子树——用来断言「原始 ID 只出现在技术详情里」
  const out: string[] = [];
  const walk = (current: FakeNode): void => {
    if (current.className && current.className.split(/\s+/).includes(skipClass)) return;
    if (current.textContent) out.push(current.textContent);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}
function findPanel(container: FakeNode, tab: string): FakeNode {
  // 作用：按 data-tab 找到某个面板（替身 DOM 没有 querySelector，只能遍历 children）
  return container.children.find((child) => child.dataset.tab === tab) as FakeNode;
}
function makeConsole(leases: LeaseManager, audit: AuditService): GovernanceConsole {
  return new GovernanceConsole({ audit, leases, guardName: "dsh-capability-guard" });
}
interface UiHandle {
  refresh(): Promise<unknown>;
  loadAudit(): Promise<unknown>;
  dispose(): void;
}
describe("治理台共享 UI（真实治理接口 + 最小 DOM）", () => {
  it("挂载后渲染出授权、剩余时间倒计时与审计行，并拒绝非法挡位", async () => {
    const leases = new LeaseManager(new MemoryLeaseStore());
    const audit = new AuditService();
    const policy = new GovernancePolicy({ initial: { defaultScope: "exact-arguments", defaultTtlSeconds: 60, maxTtlSeconds: 1800 } });
    await leases.issue({ sessionId: "session-ui", toolName: "pwsh", scope: { kind: "sandbox-escalation", key: "k1", display: "tool=pwsh 沙箱升级至 danger-full-access" }, ttlSeconds: 300, kind: "sandbox-mode" });
    audit.record({ sessionId: "session-ui", callId: "call-1", rootCallId: "call-1", toolName: "pwsh", decision: "LEASE_ISSUED", leaseId: "lease-1", scopeDisplay: "tool=pwsh 沙箱升级至 danger-full-access" });
    const handle: ConsoleHttpHandle = await startConsoleServer({ console: makeConsole(leases, audit), policy, port: 0 });
    try {
      const document_ = makeDocument();
      const container = document_.createElement("div");
      // 把共享 UI 脚本装进一个可控的全局环境（UMD 会把工厂挂到 globalThis.DshGuardConsole）
      const sandbox = { document: document_, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), setInterval: () => 0, clearInterval: () => undefined, URL, Date, Math, JSON, Number, String, Object, Array, Error, isNaN, console };
      runInNewContext(CONSOLE_CLIENT_JS, sandbox);
      const factory = sandbox.DshGuardConsole as { mount(options: Record<string, unknown>): UiHandle };
      expect(typeof factory.mount).toBe("function");
      const ui = factory.mount({ host: handle.url.replace(/\/$/, ""), container, document: document_, pollMs: 1e9 });
      await ui.refresh();
      await ui.loadAudit();
      const rendered = texts(container);
      expect(rendered.join("|")).toContain("tool=pwsh 沙箱升级至 danger-full-access");
      expect(rendered.join("|")).toContain("生效中");
      expect(rendered.some((text) => /^\d+m\d+s$|^\d+s$/.test(text))).toBe(true); // 剩余时间倒计时
      expect(rendered.join("|")).toContain("已签发临时授权");
      expect(rendered.join("|")).toContain("defaultScope");
      ui.dispose();
      expect(container.children).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
  it("首屏：当前会话 + 两条独立状态，原始授权 ID 只出现在技术详情里", async () => {
    // 场景：授权已到期，但沙箱档位还没回滚——这正是「倒计时归零 ≠ 恢复完成」要显示出来的状态
    let now = 1_000_000;
    const leases = new LeaseManager(new MemoryLeaseStore(() => now), () => now);
    const audit = new AuditService();
    const lease = await leases.issue({ sessionId: "session-pending", toolName: "pwsh", scope: { kind: "sandbox-escalation", key: "abcdef123456", display: "tool=pwsh 沙箱升级至 danger-full-access" }, ttlSeconds: 300, kind: "sandbox-mode" });
    now += 301_000;
    const sandbox = {
      states: () => [{ sessionId: "session-pending", baseline: "workspace-write" as const, lastWritten: "danger-full-access" as const, currentMode: "danger-full-access" as const, status: "raised" as const, liveCount: 0, staleCount: 1, grants: [{ leaseId: lease.id, toolName: "pwsh", requestedMode: "danger-full-access" as const, writtenMode: "danger-full-access" as const, raised: true, live: false }] }],
      lastOutcomeOf: () => undefined,
    };
    const gov = new GovernanceConsole({ audit, leases, now: () => now, sandbox, sessions: { describe: () => ({ label: "修复登录超时", source: "title" as const, cwd: "D:\\gitpro\\demo" }) } });
    const actions = { revokeSession: async (sessionId: string) => ({ sessionId, revoked: 0, results: [] }), restoreSandbox: async (sessionId: string) => ({ sessionId, results: [] }) };
    const handle: ConsoleHttpHandle = await startConsoleServer({ console: gov, actions, sweepIntervalMs: 30_000, port: 0 });
    try {
      const document_ = makeDocument();
      const container = document_.createElement("div");
      const sandboxGlobal = { document: document_, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), setInterval: () => 0, clearInterval: () => undefined, URL, Date, Math, JSON, Number, String, Object, Array, Error, isNaN, console };
      runInNewContext(CONSOLE_CLIENT_JS, sandboxGlobal);
      const factory = sandboxGlobal.DshGuardConsole as { mount(options: Record<string, unknown>): UiHandle };
      const ui = factory.mount({ host: handle.url.replace(/\/$/, ""), container, document: document_, pollMs: 1e9, sessionId: "session-pending" });
      await ui.refresh();
      await ui.loadAudit();
      const sessionPanel = findPanel(container, "session");
      const firstScreen = texts(sessionPanel).join("|");
      const withoutDetails = textsExcept(sessionPanel, "dgc-details-body").join("|");
      // 会话名 + 两条独立状态 + 人话说明
      expect(firstScreen).toContain("修复登录超时");
      expect(firstScreen).toContain("已到期");
      expect(firstScreen).toContain("待回滚");
      expect(firstScreen).toContain("完全访问");
      expect(firstScreen).toContain("立即回滚档位");
      expect(firstScreen).toContain("档位还停在");
      // 原始 ID / Scope 只进技术详情，首屏不出现
      expect(firstScreen).toContain(lease.id);
      expect(withoutDetails).not.toContain(lease.id);
      expect(withoutDetails).not.toContain("session-pending");
      expect(withoutDetails).not.toContain("abcdef123456");
      ui.dispose();
    } finally {
      await handle.close();
    }
  });
  it("独立页面外壳引用同一份脚本（两处不会漂移）", async () => {
    const handle = await startConsoleServer({ console: makeConsole(new LeaseManager(new MemoryLeaseStore()), new AuditService()), port: 0 });
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain('src="/console.js"');
      expect(html).toContain("DshGuardConsole.mount");
      const served = await (await fetch(`${handle.url}console.js`)).text();
      expect(served).toBe(CONSOLE_CLIENT_JS);
    } finally {
      await handle.close();
    }
  });
});
describe("DSH 客户端半边（adapter/client.js）", () => {
  interface FakeElement {
    children: FakeElement[];
    props: Record<string, unknown>;
    type: unknown;
  }
  function loadClientModule(): { inject: string[]; apply(ctx: unknown): void } {
    // 作用：在最小浏览器替身里执行 adapter/client.js，取出它的 cordis 插件对象。
    // 这里刻意只做"装载 + 注册"层面的验证：client.js 是浏览器模块，Node 里没有真实 React 与 DOM，
    // 伪造 hooks 语义只会测出假象；渲染正确性由上面的共享 UI 用例（真实治理接口 + 最小 DOM）保证。
    const source = readFileSync(fileURLToPath(new URL("../../client.js", import.meta.url)), "utf8");
    let factory: ((require: (name: string) => unknown) => { inject: string[]; apply(ctx: unknown): void }) | undefined;
    const React = {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children }, children: [] }),
      useRef: () => ({ current: null }),
      useState: (initial: unknown) => [initial, () => undefined],
      useEffect: () => undefined,
    };
    const window_ = { __ModuleLoader__: { load: (definition: { id: string; factory: typeof factory }) => { factory = definition.factory; } }, DshGuardConsole: undefined as unknown };
    const document_ = makeDocument();
    runInNewContext(source, { window: window_, document: document_, setTimeout, setInterval, clearInterval, fetch, console });
    expect(factory).toBeTypeOf("function");
    const plugin = factory!((name: string) => {
      if (name === "react") return React;
      throw new Error(`unexpected require: ${name}`);
    });
    expect(plugin.inject).toEqual(["slots"]);
    return plugin;
  }
  function registerPlugin(): { registrations: { slot: string; options: Record<string, unknown>; component: unknown }[] } {
    const plugin = loadClientModule();
    const registrations: { slot: string; options: Record<string, unknown>; component: unknown }[] = [];
    const ctx = {
      slots: {
        inject: (_slot: string, callback: () => unknown) => {
          callback();
          return () => undefined;
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ slot: String(options.name), options, component });
          return () => undefined;
        },
      },
    };
    plugin.apply(ctx);
    return { registrations };
  }
  it("注册对话内提示条、输入框模式 chip 与会话内「能力授权」tab（不再注册设置页）", () => {
    const { registrations } = registerPlugin();
    expect(registrations.map((item) => item.slot).sort()).toEqual(["conversation.input.dock", "conversation.input.left", "conversation.view"]);
    const dock = registrations.find((item) => item.slot === "conversation.input.dock");
    const chip = registrations.find((item) => item.slot === "conversation.input.left");
    const view = registrations.find((item) => item.slot === "conversation.view");
    // 提示条：list 槽的 id 形态 + 排序位，紧跟在待办之后
    expect(dock?.options.id).toBe("guard");
    expect(dock?.options.order).toBe(5);
    expect(typeof dock?.component).toBe("function");
    // 模式 chip：紧挨原生档位控件（不抢占 conversation.input.permission，避免遮蔽 DSH 自带 UI）
    expect(chip?.options.id).toBe("guard-mode");
    expect(typeof chip?.component).toBe("function");
    // 会话视图：第三个 tab（对话 0 / 轨迹 10 / 能力授权 20），label 就是 tab 上的文字
    expect(view?.options.id).toBe("guard");
    expect(view?.options.order).toBe(20);
    expect(view?.options.label).toBe("能力授权");
    expect(typeof view?.component).toBe("function");
    // 设置页不再注册：配置已全部搬到会话内「能力授权」（2026-10-31 产品决定）
    expect(registrations.some((item) => item.slot === "settings.section")).toBe(false);
    // 组件在「还没拿到快照」时渲染为空（不占位、不报错）——数据到达后才决定显示什么
    const rendered = (dock?.component as (props: Record<string, unknown>) => FakeElement | null)({ sessionId: "session-x" });
    expect(rendered).toBeNull();
  });
  it("面板模型（纯函数）：时间范围过滤 + 指标聚合，避免再有渲染期空白", () => {
    const { registrations } = registerPlugin();
    const view = registrations.find((item) => item.slot === "conversation.view")?.component as unknown as {
      buildModel(records: unknown[], rangeDays: number, now: number): { rows: unknown[]; metrics: { label: string; value: string }[]; topFamilies: [string, number][] };
    };
    expect(typeof view.buildModel).toBe("function");
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    const base = { kind: "universal", outcome: "expired", uses: 0, windowMs: 0 };
    const records = [
      { ...base, leaseId: "old", grantedAt: now - 60 * day },
      { ...base, leaseId: "exact", grantedAt: now - 1 * day, uses: 2 },
      { ...base, leaseId: "family", grantedAt: now - 2 * day, uses: 3, familyLabel: "同前缀 tsc" },
      { ...base, leaseId: "window", grantedAt: now - 3 * day, uses: 1, kind: "sandbox-mode" },
      { ...base, leaseId: "active", grantedAt: now - 1 * day, outcome: "active", windowMs: 90_000 },
    ];
    // 默认近 30 天：60 天前那条被过滤掉
    const model = view.buildModel(records, 30, now);
    expect(model.rows).toHaveLength(4);
    const pick = (label: string) => model.metrics.find((m) => m.label === label)?.value;
    expect(pick("人工批准")).toBe("4");
    expect(pick("命中复用")).toBe("6");
    expect(pick("复用率")).toBe("60");
    expect(pick("生效中")).toBe("1");
    expect(pick("精确 / 族 / 免打扰")).toBe("2 / 3 / 1");
    expect(model.topFamilies[0]).toEqual(["同前缀 tsc", 3]);
    // rangeDays=0 → 全部
    expect(view.buildModel(records, 0, now).rows).toHaveLength(5);
  });
  it("对话内提示条：四种状态的文案（没有授权时也必须显示一行，否则用户以为功能不存在）", () => {
    const { registrations } = registerPlugin();
    const dock = registrations.find((item) => item.slot === "conversation.input.dock")?.component as unknown as {
      describe(view: unknown, now: number): { tone: string; title: string; sub?: string; action?: { mode: string } } | null;
    };
    const describe = dock.describe;
    expect(typeof describe).toBe("function");
    // ① 没有任何授权：提示条整条隐藏（模式 chip 已常驻显示"功能存在且当前档位"，不再写占位行）
    const idle = describe({ sessionId: "s", auth: { state: "none", activeCount: 0, grants: [] }, sandbox: { state: "not-involved" } }, 1_000);
    expect(idle).toBeNull();
    // ② 生效中：说清「放开了什么 + 还剩多久 + 到期会怎样」
    const active = describe(
      { sessionId: "s", auth: { state: "active", activeCount: 1, nextExpiresAt: 61_000, grants: [{ capabilityText: "pwsh 可以免审批升到「完全访问」" }] }, sandbox: { state: "raised", currentMode: "danger-full-access", currentModeText: "完全访问" } },
      1_000,
    );
    expect(active?.tone).toBe("active");
    expect(active?.title).toContain("pwsh 可以免审批升到「完全访问」");
    expect(active?.sub).toContain("还剩 1 分 00 秒");
    expect(active?.action?.mode).toBe("revoke");
    // ③ 授权已到期但权限没收回：必须是醒目告警 + 独立按钮
    const pending = describe({ sessionId: "s", auth: { state: "expired", activeCount: 0, grants: [] }, sandbox: { state: "pending-restore", currentMode: "danger-full-access", currentModeText: "完全访问" } }, 1_000);
    expect(pending?.tone).toBe("warn");
    expect(pending?.title).toContain("没有收回");
    expect(pending?.title).toContain("完全访问");
    expect(pending?.action?.mode).toBe("restore-sandbox");
    // ④ 已收回：给一句确认，之后由调用方按时间自然隐藏
    const restored = describe({ sessionId: "s", auth: { state: "expired", activeCount: 0, grants: [] }, sandbox: { state: "restored", currentMode: "workspace-write", currentModeText: "工作区可写", lastOutcomeAt: 99_500 } }, 100_000);
    expect(restored?.tone).toBe("done");
    expect(restored?.title).toContain("已收回");
    // ⑤ 连会话数据都没有（接口不可达）：不占位
    expect(describe(null, 1_000)).toBeNull();
  });
  it("会话视图组件在「没有快照」时渲染占位（不抛错、不留白屏）", () => {
    const { registrations } = registerPlugin();
    const View = registrations.find((item) => item.slot === "conversation.view")?.component as (props: Record<string, unknown>) => FakeElement;
    const rendered = View({ sessionId: "session-x" });
    expect(rendered.type).toBe("div");
    // 还没拿到数据时只渲染一行提示文字，不渲染空白容器
    expect(JSON.stringify(rendered.props)).toContain("正在读取本会话的授权状态");
  });
  it("插件可重复装载（fiber 卸载后重新注册不会抛错）", () => {
    const first = registerPlugin();
    const second = registerPlugin();
    expect(first.registrations).toHaveLength(3);
    expect(second.registrations).toHaveLength(3);
  });
});
