# 集成基线：真实 DSH 行为核实

> 本文件替代重构规格第 34 节的"待核对"占位（规则 4：DSH API 以当前安装版本类型定义与源码为准，禁止凭猜测硬编码）。
> 核实方式：对**已安装的编译产物**（`lib/index.js`、`lib/types/*.d.ts`、`cordis.patch.yml`）做静态阅读，逐条带行号引用。
> 核实日期：2026-09-14。DSH 处于 Developer Preview 快速迭代期，**升级 DSH 后必须重跑本文件的核实流程**。

## 0. 版本与环境前提

| 项 | 值 |
|---|---|
| npm 全局检出 | `C:\Users\dwh\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`（rc.1） |
| **实际运行**的 profile | `C:\Users\dwh\.dsh\profiles\web`（bundles = `dsh-base` + `dsh-web-app`，用户 patch 层为空） |
| 实际加载版本 | `C:\Users\dwh\.dsh\profiles\node_modules\@deepseek-ai\`（rc.2） |
| 两棵树差异 | 逐包比对 `lib/index.js`：**0 个不同**；仅 `dsh-web-frontend`、`schemastery` 不在 profile 中 |

**结论：本文所有结论对 rc.1 与 rc.2 同时成立。** 下文 `<ROOT>` = 上述任一 `node_modules\@deepseek-ai\`。

---

## 1. `tools/pre-execute` 的默认下游决策是 `allow`（**核心事实**）

`<ROOT>\dsh-tools\lib\index.js:3115-3116`

```js
const carrier = scopeTarget(this, exec.agent);
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
```

Cordis 瀑布落底语义 `<ROOT>\cordis\lib\index.js:317-324`：`const next = () => (cbs.shift() ?? inner)(...args);`
→ **无监听器认领时，那个箭头函数本身就是最终决策**。

### 全量 shipped 监听器清点（穷尽 grep `pre-execute`）

| 包 | 位置 | 能返回什么 |
|---|---|---|
| `dsh-hooks-claude-code` | `lib\index.js:248`（判定 `:255-262`） | **deny 与 ask** |
| `dsh-hooks-codex` | `lib\index.js:232` | **仅 deny**（README:83 "PreToolUse has no allow or ask"） |
| `dsh-tool-jobs` | `lib\index.js:179` | 仅 `return next()` |

另有 deny-only 的 guard 机制（在 pre-execute **之后**求值，返回 `string | undefined`，无 ask）：`dsh-subagent-in-process-driver\lib\index.js:85`、API `dsh-tools\lib\index.js:2816`。

### 标准 profile 下不会出现 `ask`

`dsh-base\cordis.patch.yml:254` 三者中**只挂载了 `tool-jobs`**，且无 hooks 行；全部 shipped `cordis.patch.yml` / `agent.cordis.yml` 搜索结果同样只有 tool-jobs。

> **推论 1：若 Universal Gate 只挂在 `tools/pre-execute` 上等待下游返回 `ask`，在开箱即用的 DSH 中它永远走 `PASSTHROUGH_ALLOW`，不会签发任何 Lease —— 即 Universal Mode 空转。**

---

## 2. 真实的审批请求来自工具体内，且**晚于** pre-execute

`<ROOT>\dsh-sandbox\lib\index.js:93-104`

```js
const outcome = await approval.approver.request({
  agent: approval.agent, toolName: approval.toolName, callId: approval.callId,
  reason: `escalate sandbox to ${mode}: ${justification}`,
  ...approval.signal ? { signal: approval.signal } : {}
});
```

接线与调用点（均在 `async execute(args, exec)` **内部**）：

| 工具 | 接线（`approver: ctx.get("approval")`） | 调用点 |
|---|---|---|
| `pwsh` | `dsh-tool-pwsh\lib\index.js:212-227`（:221） | :360-363 |
| `bash` | `dsh-tool-bash\lib\index.js:238-253`（:247） | :386-389 |
| `fs`（write/edit） | `dsh-tool-fs\lib\index.js:1188-1210`（:1200） | :648 / :797 |

**顺序证明**：pre-execute 在 `prepareExecution` 已解决（`dsh-tools\lib\index.js:3116`），之后调度才进入 `:3213` → `dispatchToolBody` → `tool.execute(exec.arguments, exec)`（`:3192`）。

**失败映射 Fail Closed**（`dsh-sandbox\lib\index.js:105-111`）：仅 `allowed-once` 返回模式；`rejected` / `cancelled` / `unavailable` 各自 throw。

> **推论 2：`approval/request` 是 Universal Mode 唯一真实的入口，但它【不含 tool arguments】，因此 Scope 必须在更早的 `tools/execute` 阶段预先记录。**

---

## 3. `tools/execute` 是唯一能同时拿到 callId 与 arguments 的时机

- 签名 `dsh-tools\lib\types\index.d.ts:49`：`'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>`
- 包装器先于 body：`dsh-tools\lib\index.js:3213` `const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));`
- 参考实现：`dsh-tool-call-timeout-policy\lib\index.js:116-141`
- **不能**重新决策 allow/deny/ask（PreToolDecision 已在 `prepareExecution` 消费），但**可以替换结果**（不调用 `next()` 即否决后续整条链，`cordis\lib\index.js:311-312`）
- `exec.arguments` 创建时深冻结（`:3057-3060` `arguments: deepFreeze(detached)`），类型 `readonly`，DSH 明确"刻意不允许改写 arguments"（`:416-417`、README:224）

> **注意（UNCLEAR，静态推断）**：被冻结的是 arguments 的**值**，执行对象本身要到 `notifyResult`（`:3285`）才 `Object.freeze`。因此 pre-execute 阶段 `arguments` **属性**理论上可被 `any` 整体重赋值，且 shipped invariant 不检测此项。Guard 从不改写参数，不受影响；但**计算 Scope 时应使用值的快照，不要长期持有参数引用**。

---

## 4. `approval/request` 的载荷与策略先行短路

`<ROOT>\dsh-user-approval\lib\index.js:175-192`

```js
if (signal?.aborted) return "cancelled";
if (this.effectivePolicy(session) === "never") return "rejected";
const answer = ... this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))...
```

| 情形 | 结果 | 是否派发瀑布 |
|---|---|---|
| signal 已 abort | `cancelled` | 否（**先于**策略检查） |
| 策略 `never` | `rejected` | **否 —— 任何 listener 都看不到** |
| 策略 `ask` | 瀑布，落底 `unavailable` | 是 |
| answerer 抛错 / 返回非法值 | `unavailable` | 是 |

- 无 open turn 时 `request()` 直接 throw：`:133`
- 审计对仍成对写入：`:135` / `:142`（`never` 也记录 asked + decided）
- **载荷** `dsh-user-approval\lib\types\types.d.ts:55-66`：`{ agent, toolName, callId?, reason?, signal? }`
  - **不含 tool arguments**（`types\index.d.ts:57-58`："callId links to an already presented tool call, so arguments are not duplicated here"）
  - 含完整 `agent`（`.session` 可达），无独立 session 字段

---

## 5. 会话沙箱模式：写入路径公开、且**支持按调用传入已批准模式**

### 5.1 公开写入路径（无校验、无门禁）

`<ROOT>\dsh-sandbox-policy\lib\index.js:41-43`

```js
function setSandboxMode(session, mode) {
  session.append("sandbox/mode", { mode });
}
```

- 模块级公开导出：`:159` `export { SANDBOX_MODES, SandboxPolicyService, SandboxPolicyService as default, setSandboxMode }`；package.json `exports["."]` → `./lib/index.js`
- 模式闭集 `:27-31`：`["read-only", "workspace-write", "danger-full-access"]`
- 服务上下文键：`ctx.sandboxPolicy`（`lib\index.js:111` `super(ctx, "sandboxPolicy")`），由 `dsh-base\cordis.patch.yml:208-212` 挂载
- 服务接口**只读**（`lib\types\index.d.ts:71-95`）：`resolve(request?)` / `overrideOf(session)` / `readonly defaultMode` / `readonly workspaceRoot` —— **没有 mutator**

### 5.2 按调用传入已批准模式（**P0-2 方案选择的关键**）

`<ROOT>\dsh-sandbox-policy\lib\index.js:141-148`

```js
resolve(request = {}) {
  const { session } = request;
  return {
    mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
    ...
```

优先级：**`request.mode`（已批准模式） > session 的 `sandbox/mode` 事件 > 部署默认**。
`overrideOf(session)`（`:154-156`）读的是 `sessionProjections.stateOf(session, "sandboxMode")`，即**最后一条 `sandbox/mode` 事件**。

### 5.3 危险的兄弟 API（**禁止使用**）

`ctx.permissionPresets.set(session, name)` 是公开的，但它 `apply()` **同时写两个旋钮**
（`dsh-permission-presets\lib\index.js:284` `setSandboxMode(session, spec.sandbox)`、`:285` setApprovalPolicy / `:172` `this.ctx.approval.setPolicy(agent, policy)`）。
而内置 preset 表中 `danger-full-access` 配的是 **`approval: never`**（`dsh-base\cordis.patch.yml:239-241`）。

> **安全红线：Guard 提升授权时【只能】用 `setSandboxMode`，绝不允许调用 `permissionPresets.set` / `approval.setPolicy`。**
> 否则会在用户不知情的情况下把 approval policy 改成 `never` —— 那等于**永久关闭审批**，是最严重的越权。

---

## 6. 硬边界：子 Agent 永远无法获得交互式授权

`<ROOT>\dsh-subagent\lib\index.js:566-571`

```js
approvalPolicy: parent.ctx.get("approval") === void 0 ? void 0 : "never"
```

文档 `:561-562`："the approval policy is pinned to `'never'` regardless of the parent's own policy"；写入 child 自己的 log `:586-589`；所有委派路径均调用（`dsh-subagent-in-process-driver:169-172`、`dsh-subagent:1066`、`:1666`）。

**代码级后果**：child 的 ask 命中 `decide()` 的 `never` 分支 → 在瀑布前返回 `"rejected"` → 交互式 answerer **永不被咨询**；升级路径把它映射为 `throw new Error('the user rejected escalating this ...')`（`dsh-sandbox:107`）——**从未询问过任何人**。

`Agent.id` 是 `SessionId`（`dsh-agent\lib\types\types.d.ts:11-14`），子 agent 用新 id（`dsh-subagent\lib\index.js:1649`）→ 天然隔离。

> **规则：Lease Store 必须以 `exec.agent.id` 建键，并【显式拒绝】为子会话签发 Lease。跨 session 继承授权在设计上不可能，也不允许尝试。**

---

## 7. 作用域过滤：根上下文未打标签的 listener 接收所有 agent 事件

`<ROOT>\dsh-scope\lib\index.js:327-338`

```js
const carrier = { [Context.filter](ctx) {
  if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
  const tag = scopeOf(ctx);
  if (tag === void 0) return true;                       // 未打标签 → 全局接纳
  for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
  return false;
} };
```

→ 插件在 `apply` 里用 `ctx.on(...)` 注册的 listener 对**每个** agent（含子 agent）都被接纳；事件只向父流，不向子流。

---

## 8. 自伤风险：`approval/request` 是"谁认领谁说了算"的瀑布

shipped 的 UI answerer 本身就是这条瀑布上的 host 端 listener（`dsh-api-remotes\lib\index.js:115-125`，由 `dsh-client-ui-approval\lib\client.js:282` 认领）。

> **规则（P0-3 不变量）**：Guard 以 `prepend: true` 排在最前，因此
> **任何提前 return、任何合成 outcome 的分支都会在零人工交互下批准一切，并旁路人类答话器。**
> `handleApprovalRequest` 必须始终 `await next()` 并原样返回其结果，禁止出现 `"allowed-once"` 返回值。
> 由 `universal-gate.test.ts` 的 P0-3 用例与 `integration/cordis-pipeline.test.ts` 的真 cordis 用例共同守护。

### 8.1 实测补充（2026-09-14，真 cordis 集成测试）：prepend 监听器会互相遮蔽

用真实 `@deepseek-ai/cordis@4.0.2` 的 `Context`/`waterfall` 实测（`adapter/src/integration/cordis-pipeline.test.ts`）：

- `prepend: true` 是**在自己的 listener 列表内 `unshift`**（`cordis/lib/index.js:336`）；因此**后注册的 prepend 排在最前**。
- 瀑布中**认领（返回值而不调用 `next()`）的监听器会终止整条链**，其后（包括先注册的 prepend）**完全收不到该事件**。
- 实证：先注册 prepend 的 Guard + 后注册 prepend 的 answerer → 只有 answerer 被调用，Guard 什么都看不到。

**因此有两条硬约束：**

1. **Guard 在 `approval/request` 上只允许注册一个 prepend 监听器**，且必须是有条件转发 `next()` 的那一个。
   再叠加第二个 prepend（哪怕是为了"记日志"）都会把 Guard 挤出观察位置，导致**审批通过却静默不签发 Lease**。
2. 生产形态下 UI answerer 属于宿主组合、先于第三方插件装载，因此它排在 Guard 之前**并认领**事件，
   Guard 位于**下游**观察到最终 outcome —— 这正是"只观察、不合成"能成立的原因，也再次说明
   **Guard 绝不能在 handler 里直接返回 `allowed-once`**（那会越过人类答话器，构成零交互批准）。

> 已知边界（应写入 README）：`approval/request` 是开放瀑布，**任何插件都可以认领**并零交互返回
> `allowed-once`，或反过来遮蔽 Guard 的观察位置。这是 DSH 事件模型的固有性质，不属于本插件能防御的范围。


---

## 9. 与现有实现的偏差清单（本次修复的输入）

| # | 现有假设 | 真实行为 | 处置 |
|---|---|---|---|
| D-1 | Gate 在 `tools/pre-execute` 等下游 `ask` | 默认 `allow`，标准 profile 无 shipped listener 返回 ask | 新增 `tools/execute` hook 记录 pending；`approval/request` 作为真实签发入口 |
| D-2 | approval 请求可携带/推导参数 Scope | 载荷不含 arguments | Scope 在 `tools/execute` 阶段算好并暂存，按 callId 关联 |
| D-3 | 默认 `exact-arguments` 可复用授权 | escalation 的 `justification` 由模型每次现写，参数哈希几乎不可能复用 | 沙箱升级改用 `(toolName, 目标模式)` 语义 Scope（`capability/escalation.ts`） |
| D-4 | 授权只需签发 Lease 即生效 | Lease 本身不影响 DSH 沙箱判定 | 用 `setSandboxMode` 提升会话模式，到期/撤销时回滚（**禁止**用 `permissionPresets.set`） |
| D-5 | 子 session 可能继承授权 | 子 agent 被钉死 `never`，且瀑布都不派发 | 显式拒绝为子 session 签发；写入文档 |
| D-6 | `capabilities` 可直接挂属性 | 应以 Cordis Service 注册 | Phase 1 基线修正项（P1-2） |

---

## 10. 重跑核实的检查清单（升级 DSH 后必做）

1. `dsh-tools`：`tools/pre-execute` 落底决策是否仍为 `allow`；`tools/execute` 是否仍在 body 之前
2. `dsh-user-approval`：`decide()` 的短路顺序；`approval/request` 载荷是否仍不含 arguments
3. `dsh-sandbox-policy`：`SANDBOX_MODES` 取值域；`resolve()` 优先级；`setSandboxMode` 是否仍无校验导出
4. `dsh-subagent`：子 agent approval policy 是否仍钉 `never`
5. `dsh-base\cordis.patch.yml`：`permission` preset 表中 `danger-full-access` 的 approval 取值是否仍为 `never`
6. `dsh-permission-presets`：`set()` 是否仍同时写两个旋钮（决定红线是否继续成立）

---

## 11. 实现期踩坑记录（供后续复用，非 DSH 事实）

这些不是 DSH 的行为，而是本项目在按上述基线实现时**真实踩到并已修复**的缺陷，记在此处防止重犯：

| # | 缺陷 | 根因 | 正确做法 |
|---|---|---|---|
| P-1 | 有效 Lease 被判定为失效，授权被错误回滚 | `settle()` 默认参数用**真实挂钟** `Date.now()`，而 Lease 由**注入时钟**创建，两套时间基准不可比 | 时间有效性只由 `LeaseManager` 单一来源判定（`isLive(id)` 内部用自身时钟）；**禁止**让调用方自行传入时间做安全比较 |
| P-2 | 多条授权交替时把 Guard 自己的写入误判为「用户改动」 | 用单条授权的 `writtenMode` 做冲突检测，后一条授权提升模式后前一条的 `writtenMode` 即成过期值 | 按 **session** 记录 Guard 最后一次写入值作为唯一比较基准 |
| P-3 | 幂等性失效：同一 Lease 重复提升会再写一次 session log | `settle()` 的调用时点排在幂等判断之前，把刚记录的授权当成失效项回收 | `settle()` 必须先执行，再做幂等与提升判断 |
| P-4 | 从未真正提升过的授权在释放时报「用户改动」 | 未区分「Guard 未写入」与「写入后被用户改动」两种情形 | 记录 `raised` 标志区分：未写入 → `UNCHANGED`；写入后被改 → `SKIPPED_USER_OVERRIDE` |

