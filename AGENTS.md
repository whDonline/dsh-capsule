# AGENTS.md

> 本文件是 dsh-capsule 项目的"项目宪法"，所有 AI 编码会话开始前必须通读并遵守。
> 当前有效规格：`docs/DSH_Capability_Guard_基于现有版本重构技术规格.md`（增量重构，以其为准）。
> 项目决策（2026-09-14，项目所有者确认）：**Legacy Python / Docker Isolated Runtime 已整体移除，不再预留、后续不实现**。规格中涉及 Legacy 保留 / Phase 5 Optional Isolated Runtime 的条款随之作废；本插件为纯 TypeScript，无 Python / Docker / UDS 依赖。

> **集成基线（2026-09-14 对已安装 DSH 源码逐行核实，取代规格第 34 节的"待核对"占位）**
> 完整核实报告（含行号引用与重跑清单）位于 `docs/集成基线-真实DSH行为.md`（注意：`/docs/` 被 `.gitignore` 排除，属本地文件）。
> 以下四条是**已证伪的旧假设**与**必须遵守的新前提**，任何会话不得再按旧假设编码：
>
> 1. **`tools/pre-execute` 的落底决策是 `allow`**（`dsh-tools:3115-3116`），标准 profile 下没有任何 shipped listener 返回 `ask`（`dsh-base/cordis.patch.yml:254` 只挂 `tool-jobs`）。因此"在 pre-execute 等下游 ask"在真实 DSH 中**空转**，不产生任何 Lease。
> 2. **真实审批入口是工具体内的 `approveEscalation → ctx.approval.request`**（`dsh-sandbox:93-104`），发生在 pre-execute 决策**之后**，且 `approval/request` 载荷**不含 tool arguments**（只有 agent/toolName/callId/reason/signal）。因此沙箱升级的 Scope 必须在 `tools/execute`（body 之前、arguments 可用）阶段算好并按 callId 关联。
> 3. **授权要真正生效必须提升会话沙箱模式**：`setSandboxMode(session, mode)`（`dsh-sandbox-policy:41`，公开无门禁）＋ TTL 到期/撤销时回滚。**严禁**调用 `permissionPresets.set` / `approval.setPolicy` —— 内置 `danger-full-access` preset 配的是 `approval: never`，调用它等于永久关闭审批。
> 4. **子 agent 被钉死 `approvalPolicy: 'never'`**（`dsh-subagent:566-571`），其 ask 在瀑布派发**之前**就被判 `rejected`。跨 session 继承授权在设计上不可能，**Lease Store 必须显式拒绝为子 session 签发**。

## 1. 项目一句话定位

DSH Capability Guard 是面向 DeepSeek Harness 的通用 Tool 短期授权 + Managed Extension Broker 插件：任何原本触发 DSH Approval 的已装插件，**零代码改造**即获得短期 Lease、复用、过期、撤销与审计（Universal Mode）；遵循 Guard 标准开发的 Managed Extension 进一步由 Broker 代解析凭证与调用 Provider（Managed Mode）。默认主链路纯 TypeScript，Windows / macOS / Linux 均可运行。

## 2. 架构分层（必须遵守，禁止破坏信任边界）

```text
DeepSeek Harness 原生（Tool Pipeline / Approval / Credentials / Sandbox）
        ↓
DSH Capability Guard（TS 插件，横切）
   ├── Universal Gate（四个 hook，全部 prepend 观察）
   │     ├── tools/pre-execute：只接管下游 ask（真实 DSH 中通常为 allow → 透传；仅 hook 插件会 ask）
   │     ├── tools/execute：识别沙箱升级参数 → 按 (toolName, 目标模式) 算语义 Scope → 记 pending（唯一能拿到 arguments 的时机）
   │     ├── approval/request：始终 next() 委派给人/机 answerer；allowed-once → 签发 Lease + setSandboxMode 提升会话模式 + 记回滚点
   │     └── tools/result：清理 pending + 记录结果（沙箱模式回滚与 Lease 回收在此协同）
   ├── LeaseManager（MemoryLeaseStore，接口抽象可换持久化）
   ├── CapabilityService（ctx.capabilities，Managed Extension 用）
   └── Broker（Lease 校验 → ctx.credentials.resolve → Provider → External API）
```

- Legacy 层（旧 Python Runtime + Docker Capsule + UDS）：**已按项目决策整体移除**，禁止以任何理由恢复（无 `runtime.mode = isolated`，无 Phase 5）。
- 全部路径禁止：spawn Python、依赖 Docker、使用 Unix Domain Socket。
- Provider 是 Trusted Code，由 Guard Core 内置/审核；Managed Extension **不得**注册可获得 Secret 的 Provider。
- Managed Extension 通过 `ctx.capabilities.execute(run, operation)` 拿业务结果；项目标准禁止 Extension `inject credentials` 直接 `ctx.credentials.resolve`。

## 3. 与 DSH 原生机制的职责边界（不得越权）

- **不替代 Approval**：只增强——用户 `allowed-once` 后签发明确 Scope + TTL 的短期 Lease；`approval policy=never` 不得绕过。
- **不重定义权限体系**：只处理下游已返回 `kind === 'ask'` 的调用；原 `deny` 永远保持 deny，Lease 不得覆盖；Guard ALLOW 后 monotonic guard（`ctx.tools.guard()`）仍可 Deny，不得绕过。
- **不自存 Secret**：Broker 只能 `ctx.credentials.resolve(ref)`，每次 Provider operation 重新 resolve，禁止跨 operation 缓存。

## 4. 技术栈与依赖

- 主链路：TypeScript + 当前 DSH/Cordis 版本（Service / events / waterfall 中间件）。
- 新增 SDK：`sdk/typescript/`（`@dsh-capsule/extension-sdk`，第一版只有类型与 helper；禁止在 SDK 复制 Lease/Broker/Credential 逻辑——这些只存在于 Guard Core）。
- 依赖管理：pnpm workspaces（无 Python 依赖，不再使用 uv）。
- 任何路径禁止依赖：docker、python、unix socket、chmod、UID/GID、`/run/*`、Linux capability。

## 5. 强制实现规则（重构规格 MUST/MUST NOT 逐条遵守）

1. 基于现有仓库增量重构，禁止另起炉灶；动手前先跑现有 TypeScript 测试确认基线。
2. Legacy Python / Docker Runtime 已按项目决策移除（2026-09-14），禁止恢复；新增代码一律纯 TypeScript。
3. 不修改 DSH Core 源码，以独立 DSH Plugin 接入。
4. DSH API（`tools/pre-execute`、`approval/request`、`tools/result`、Cordis Service、`ctx.credentials`）以当前安装版本 TypeScript 类型定义为准，禁止凭猜测硬编码（规格第 34 节校验基线，2026-09-14）。
5. Universal V1 默认路径不得 spawn Python、不得依赖 Docker。
6. Lease 必须绑定 Session，一律取 `exec.agent.id`；agent 缺失则禁止创建 Lease（不得发明 global / anonymous lease），保持原始 ask/deny 语义。
7. 默认 Universal Scope 必须是 exact-arguments（toolName + canonical JSON 的 SHA-256）；`tool` 宽 scope 只允许用户显式配置，禁止作为默认值。
8. 禁止用 LLM 或字符串启发式猜测 Tool 的 Provider/Resource/Action；Tool Name 字符串猜测不得当作安全边界。
9. Lease 复用不能覆盖原始 DENY；只有下游 `ask` 才进入 Guard。
10. Approval reason 必须明确告知"批准将签发 Scope=xxx、TTL=xx 秒的短期 Lease"；只有 `allowed-once` 才签发，禁止把 allowed-once 静默扩展成 Lease。
11. 并行调用必须通过 callId（PendingExecution Map）隔离上下文；禁止 global `currentSession/currentTool`。
12. 过期采用 find/validate 时实时比较 `Date.now()`，禁止依赖 setInterval 作为安全正确性前提（低频 GC 只做内存回收）。
13. 所有关键失败路径 Fail Closed：Scope Resolver 抛错、TTL 非法、Lease 状态不合法、Provider/Resource/Action 不一致等一律拒绝或不签发。
14. Credential 不得写入日志、Lease、Audit、Tool Result、异常信息；每次 Provider operation 重新 resolve，禁止缓存。
15. 错误统一使用规格第 18 节错误码（`LEASE_REQUIRED` / `CAPABILITY_MISMATCH` / `CREDENTIAL_NOT_CONFIGURED` 等），禁止杂乱字符串。
16. 每完成一个 Phase，先补齐规格要求的测试并全部通过，再进入下一 Phase；禁止为通过测试删除安全断言。
17. V1 禁止顺手实现 Dashboard/Web UI（Phase 4 才做）；禁止在同一 Phase 大规模 Rename 仓库（项目名暂保 dsh-capsule，新模块内部命名用 Capability Guard / LeaseManager / Managed Extension）。
18. **审批瀑布三条红线（2026-09-14 基线新增，违反即为严重越权）**：
    (a) `approval/request` 处理器**只观察、绝不合成 outcome** —— 任何路径都必须 `await next()` 并原样返回其结果；Guard 以 prepend 排在最前，一旦提前 return 就会在零人工交互下批准一切并旁路人类答话器。由 `universal-gate.test.ts` 的 P0-3 用例与 `integration/cordis-pipeline.test.ts` 的真 cordis 用例守护。
    (a2) **`approval/request` 上只允许注册这一个 prepend 监听器**（2026-09-14 真 cordis 实测：prepend 监听器互相遮蔽——后注册的 prepend 排最前，认领后不再调用 `next()`，先注册者收不到事件）。任何额外的 prepend 监听器都会把 Guard 挤出观察位置，造成"审批通过却静默不签发 Lease"。同时必须校验审批发起者 session 与上下文一致，不一致一律不接管。
    (b) 提升授权**只能用 `setSandboxMode`**；**严禁** `permissionPresets.set` / `approval.setPolicy`（内置 `danger-full-access` preset 配 `approval: never`，调用即永久关闭审批）。回滚前必须做冲突检测：当前模式已非 Guard 写入值（用户手动改过）则**跳过回滚**并记审计，绝不冲掉用户选择。
    (c) **禁止为子 session 签发 Lease** —— 子 agent 的 approval policy 被 DSH 钉死为 `never`，其授权请求在瀑布派发前就 fail-closed；跨 session 继承授权在设计上不可能，也不允许尝试。

## 6. 实现阶段顺序（重构规格第 24 节，禁止跳序或超前）

1. **Phase 0**：冻结旧 Docker Runtime——旧 TS 文件（rpc-client / approval / credentials / tool-loader）移入 `adapter/src/legacy/`，默认启动不 spawn Python，旧测试保持可独立运行。
2. **Phase 1**：Universal Short-lived Authorization——types / canonical / scope-resolver / escalation / policy / MemoryLeaseStore / LeaseManager / PendingExecution + **四个 hook**（`tools/pre-execute`、`tools/execute`、`approval/request`、`tools/result`）+ audit。
   *（2026-09-14 基线修正：原为三个 hook。`tools/execute` 是沙箱升级链路上唯一能同时拿到 callId 与 arguments 的时机，属 Phase 1 基线的必要组成部分，不新开 Phase。）*
3. **Phase 2**：Managed Capability Service（`ctx.capabilities` register / execute / 语义 Scope）。
4. **Phase 3**：Credential Broker（ProviderRegistry + GitHubProvider + per-operation resolve + 双重校验）。
5. **Phase 4**：Governance Console / Observability。
6. ~~**Phase 5**：Optional Isolated Runtime~~（已作废：Legacy Python/Docker 层按项目决策移除，不再实现）。

Phase 0–4 已全部完成。当前验收基线见第 7.2 节：**通用场景的权限生命周期**（ask → 签发 → 复用 → 过期/撤销，
含沙箱升级的档位提升与回滚）已端到端跑通并有真 cordis 集成测试守护；**权限代理（Managed Broker 代理链路）**
按项目决策暂不实跑，其代码保留但不作为验收标准。治理台（授权剩余时间 / 审计 / 范围挡位）已接入 DSH Web GUI。

## 7. 目录结构（新增模块必须归位）

```text
adapter/src/
├── index.ts                 # Guard Plugin 入口（纯 TypeScript）+ buildSandboxContext 宿主适配器
├── capability/              # types / canonical / scope-resolver / escalation / policy / sandbox-grant / lease-store / lease-manager / pending / universal-gate
├── integration/             # 真 @deepseek-ai/cordis 集成测试：cordis-pipeline（hook 接线与瀑布认领语义）
│                            #   / plugin-activation（Context.plugin 装载）/ cordis-get-semantics（ctx.get 降级契约）
├── service/                 # capability-service.ts（ctx.capabilities）
├── broker/                  # errors / provider / registry / broker / providers/github.ts
├── audit/                   # types / audit-service
└── console/                 # types / policy（运行期挡位与 TTL）/ console-service / http-server / console-ui
adapter/client.js            # DSH 客户端半边：治理台面板（main + sidebar.panellist 槽位）
sdk/typescript/              # @dsh-capsule/extension-sdk
extensions/github-demo/      # Managed Extension 示例
scripts/smoke-console.mjs    # 本地手工冒烟（示例数据 + 独立治理页面）
```

## 7.1 治理台接线事实（2026-10-15 实测，禁止再按旧假设实现）

1. **Console 默认开启**（`console.enabled !== false`）：治理台是「查看授权剩余时间 / 审计 / 切换范围挡位」的
   唯一可视化入口；端口被占用时回退系统分配的随机端口（不让插件装配失败），实际地址写在 stderr。
2. **同源路由必须用 `ctx.inject(['webServer'], cb)` 注册**，不能只用 `ctx.get("webServer")`：
   bundle 行的激活顺序不保证 webServer 已就绪，直接解析可能拿到 undefined，导致 `/guard/…` 静默缺失
   （实测现象：插件其余部分全部正常，只有同源入口返回 404）。
3. **跨源访问要走 loopback CORS**：DSH Web GUI 与独立 Console 端口不同源；Console 只对
   `http://127.0.0.1|localhost|[::1]` 来源回显 CORS 头，其余来源 403；写接口另有自定义头 +
   JSON content-type 两道闸门（浏览器预检挡住 CSRF）。
4. **治理台写接口只能改 `defaultScope` / `defaultTtlSeconds` / `maxTtlSeconds`**：
   `enabled` 与 `rules` 是部署配置，接口层返回 400；`tool` 挡位禁止作为默认值（规格第 7 条）。
   运行期改动**不落盘**（Guard 不写 profile 的 `cordis.patch.yml`）。
5. **客户端半边注册槽位**：`ctx.slots.inject('main', …)` 提供面板、`ctx.slots.inject('sidebar.panellist', …)`
   提供侧栏入口，两者的 `id`/`key` 必须一致（`guard`）才能互相寻址。
6. **改完插件代码必须重启 DSH**：profile 的 HMR 只重组配置，不会重新加载已装载模块的新一代 JavaScript。

## 7.2 当前验收基线

- **通用权限生命周期已跑通**：`adapter/src/integration/permission-lifecycle.test.ts` 在真 cordis 上覆盖
  ask → allowed-once → 签发 → 复用 → TTL 过期 / 撤销 → 重新询问，以及沙箱升级的
  「提升档位 → 复用 → 到期回滚 → 用户手动改动则跳过回滚」。
- **权限代理（Managed Broker 代理链路）按项目决策暂不实跑**：代码仍在（`broker/`、`service/`），
  但不作为当前验收标准，也不要为了它改动 Universal 链路。
- 治理台的两个入口（DSH 面板 / 独立页面）共用 `console/console-ui.ts` 一份前端代码，禁止再造第二套视图。

## 8. 安全声明边界（README / 注释不得混淆）

- Universal Mode 可声明：短期授权、Session/Scope 绑定、TTL、撤销、审计、零改造集成；**不得**声明"第三方插件看不到 Credential / 无法绕过 Broker / 网络被隔离"。
- Managed Broker Mode 可声明：按 Guard SDK 编写的 Tool 不直接解析 Credential、Broker 统一执行 Provider Operation；它是 Architectural Contract，不是 OS 强隔离边界，文档必须如实说明。
- 本项目不再提供任何 OS 级强隔离后端（Legacy Container Runtime 已移除）；需要强隔离的场景由 DSH 原生 Sandbox 或外部机制负责。

## 9. 测试与跨平台

- 新 TS 测试位于 `adapter/src/capability/*.test.ts`（算法与负向路径）与 `adapter/src/integration/*.test.ts`（真 cordis 接线语义），必须覆盖规格第 22 节 V1 清单（原 allow/deny 不受影响、deny 不可被 Lease 覆盖、Lease 复用、Session/Scope 隔离、TTL、revoke、并行 callId 隔离、取消清理、canonical JSON 哈希稳定）与第 23 节 V2 清单（15 项）。
- **改动 hook 注册、事件顺序或宿主服务访问方式时，必须同时更新 `adapter/src/integration/` 下的真 cordis 测试**——历史上三个最难查的缺陷（事件时序、prepend 遮蔽、服务必须 `ctx.get`）都只有这一层能发现，单元测试用的假 bus/假 ctx 会掩盖它们。
- CI 必须在 ubuntu / windows / macos 三平台跑 build + test（纯 TS，无 Python/Docker job）。
- 安全相关代码必须配负向测试（rejected / cancelled / unavailable 不签发、mismatch 拒绝、Secret 不入日志）。

## 10. 开发纪律

- 只做当前 Phase 范围内的事，禁止"顺手加功能"或超前实现。
- 代码注释使用中文，给出方法作用说明；普通代码不随意空行，保持整洁。

## 11. 会话回复规范

- 全程使用中文回复用户。
- 每个任务执行完毕后，向用户说明本次使用了哪些大模型。
