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
function makeConsole(leases: LeaseManager, audit: AuditService): GovernanceConsole {
  return new GovernanceConsole({ audit, leases, capabilities: { listCapabilities: () => [] }, providers: { list: () => [] }, guardName: "dsh-capability-guard" });
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
      expect(rendered.join("|")).toContain("已签发授权");
      expect(rendered.join("|")).toContain("defaultScope");
      ui.dispose();
      expect(container.children).toHaveLength(0);
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
  it("注册主面板与侧栏入口，两者的 key/id 一致（否则侧栏按钮点不到面板）", () => {
    const { registrations } = registerPlugin();
    expect(registrations.map((item) => item.slot).sort()).toEqual(["main", "sidebar.panellist"]);
    const main = registrations.find((item) => item.slot === "main");
    const sidebar = registrations.find((item) => item.slot === "sidebar.panellist");
    expect(main?.options.key).toBe("guard");
    expect(sidebar?.options.id).toBe("guard");
    expect(sidebar?.options.label).toBe("能力授权");
  });
  it("侧栏图标是可渲染的 SVG（接收宿主传入的 size/active）", () => {
    const { registrations } = registerPlugin();
    const Icon = registrations.find((item) => item.slot === "sidebar.panellist")?.component as (props: { size: number; active: boolean }) => FakeElement;
    const icon = Icon({ size: 16, active: true });
    expect(icon.type).toBe("svg");
    expect(icon.props.width).toBe(16);
    expect(icon.props.height).toBe(16);
    expect(icon.props["aria-hidden"]).toBe("true");
    // 图标内容是两个 path（盾牌轮廓 + 时钟指针），说明不是空 SVG
    expect(Array.isArray(icon.props.children)).toBe(true);
    expect((icon.props.children as unknown[]).length).toBe(2);
  });
  it("插件可重复装载（fiber 卸载后重新注册不会抛错）", () => {
    const first = registerPlugin();
    const second = registerPlugin();
    expect(first.registrations).toHaveLength(2);
    expect(second.registrations).toHaveLength(2);
  });
});
