# AGENTS.md

> **当前项目决策（2026-10-30 / 2026-11-01，项目所有者明确要求）**：凭证代理相关代码已移除，包括 Broker / Provider、命令凭证绑定、Managed Capability Service、Managed Extension SDK 与 GitHub 示例。
> **2026-11-01 追加决策：移除「提升会话沙箱档位 + TTL 回滚」整条链路**——`SandboxGrantManager`、`/api/window`、`action=restore-sandbox`、`sandbox-mode` Lease 种类、`sandbox-escalation` 范围挡位、`WINDOW_OPENED` / `SANDBOX_MODE_*` 审计决策与治理台的档位状态机全部删除。Guard **不再调用 `setSandboxMode`**，"沙箱档位"仅为宿主只读读数。
> 当前仅保留：通用短期授权（同一条操作复用）、免打扰窗口、审计、治理台。下文旧定位中涉及 Managed/Broker、档位提升与回滚的实现、保留及测试要求已作废，禁止按历史条款恢复这些模块；凭证管理交由 DSH 原生或相关工具。通用授权的安全红线及测试要求继续有效。


> 本文件是 dsh-capsule 项目的"项目宪法"，所有 AI 编码会话开始前必须通读并遵守。
> 当前有效规格：`docs/DSH_Capability_Guard_基于现有版本重构技术规格.md`（增量重构，以其为准）。
> 项目决策（2026-09-14，项目所有者确认）：**Legacy Python / Docker Isolated Runtime 已整体移除，不再预留、后续不实现**。规格中涉及 Legacy 保留 / Phase 5 Optional Isolated Runtime 的条款随之作废；本插件为纯 TypeScript，无 Python / Docker / UDS 依赖。

> **集成基线（2026-09-14 对已安装 DSH 源码逐行核实，取代规格第 34 节的"待核对"占位）**
> 完整核实报告（含行号引用与重跑清单）位于 `docs/集成基线-真实DSH行为.md`（规格与基线文档入库；
> `docs/面试*` 属本地私人笔记，已被 `.gitignore` 排除）。
> 以下四条是**已证伪的旧假设**与**必须遵守的新前提**，任何会话不得再按旧假设编码：
>
> 1. **`tools/pre-execute` 的落底决策是 `allow`**（`dsh-tools:3115-3116`），标准 profile 下没有任何 shipped listener 返回 `ask`（`dsh-base/cordis.patch.yml:254` 只挂 `tool-jobs`）。因此"在 pre-execute 等下游 ask"在真实 DSH 中**空转**，不产生任何 Lease。
> 2. **真实审批入口是工具体内的 `approveEscalation → ctx.approval.request`**（`dsh-sandbox:93-104`），发生在 pre-execute 决策**之后**，且 `approval/request` 载荷**不含 tool arguments**（只有 agent/toolName/callId/reason/signal）。因此沙箱升级的 Scope 必须在 `tools/execute`（body 之前、arguments 可用）阶段算好并按 callId 关联。
> 3. ~~**授权要真正生效必须提升会话沙箱模式**~~ **（2026-11-01 作废）**：Guard 现在**不写**沙箱档位——批准一次只放行当次调用 + 在 TTL 内代答同一条操作，会话档位始终是用户/DSH 设定的值。**仍然严禁**调用 `permissionPresets.set` / `approval.setPolicy` / `setSandboxMode`（内置 `danger-full-access` preset 配的是 `approval: never`，调用它等于永久关闭审批）。
> 4. **子 agent 被钉死 `approvalPolicy: 'never'`**（`dsh-subagent:566-571`），其 ask 在瀑布派发**之前**就被判 `rejected`。跨 session 继承授权在设计上不可能，**Lease Store 必须显式拒绝为子 session 签发**。

## 1. 项目一句话定位

DSH Capability Guard 是面向 DeepSeek Harness 的通用 Tool 短期授权插件：任何原本触发 DSH Approval 的已装插件，
**零代码改造**即获得短期 Lease、复用、过期、撤销与授权决策记录；此外提供「免打扰窗口」——用户显式开启的
限时完全访问审批放行层。**Guard 不改写会话沙箱档位**（2026-11-01 起没有档位提升/回滚）。
默认主链路纯 TypeScript，Windows / macOS / Linux 均可运行。
（2026-10-30 起 **Managed Extension / Broker / 凭证代理层已整体移除**，不再保留、不再恢复。）

## 2. 架构分层（必须遵守，禁止破坏信任边界）

```text
DeepSeek Harness 原生（Tool Pipeline / Approval / Credentials / Sandbox）
        ↓
DSH Capability Guard（TS 插件，横切）
   ├── Universal Gate（四个 hook，全部 prepend 观察）
   │     ├── tools/pre-execute：只接管下游 ask（真实 DSH 中通常为 allow → 透传；仅 hook 插件会 ask）
   │     ├── tools/execute：按策略算出本次调用的 Scope（工具 + 参数 + 目标档位）并记入 OperationRegistry（唯一能拿到 arguments 的时机）
   │     ├── approval/request：默认 `next()` 委派给人/机 answerer；命中【同一条操作】的有效授权或免打扰窗口时代答 allowed-once（见红线 (a)/(a1)）；人批准后签发操作授权，**不提升档位**
   │     └── tools/result：清理 pending + 记录结果
   ├── DndManager（免打扰窗口：独立状态，不写档位、不签 Lease）
   ├── SensitivePaths（2026-11-01：静态敏感路径保护，注册到 DSH 原生 `ctx.tools.guard()`；只许拒绝）
   ├── AccessLog（2026-11-01：工作区外访问记录，只记目录；可观测性，不参与判定）
   ├── LeaseManager（MemoryLeaseStore，接口抽象可换持久化）
   └── Console（输入框模式 chip / 能力授权 tab：配置 + 状态 + 审计 + 统计）
```

- Legacy 层（旧 Python Runtime + Docker Capsule + UDS）：**已按项目决策整体移除**，禁止以任何理由恢复（无 `runtime.mode = isolated`，无 Phase 5）。
- 全部路径禁止：spawn Python、依赖 Docker、使用 Unix Domain Socket。
- Provider 是 Trusted Code，由 Guard Core 内置/审核。（Managed Extension / Broker 已移除，本节仅保留历史结论。）
- 项目不再提供任何 `ctx.capabilities` / Provider 注册面；新增能力一律走 DSH 原生机制。

## 3. 与 DSH 原生机制的职责边界（不得越权）

- **不替代 Approval**：只增强——用户 `allowed-once` 后签发明确 Scope + TTL 的短期 Lease；`approval policy=never` 不得绕过。
- **不重定义权限体系**：只处理下游已返回 `kind === 'ask'` 的调用；原 `deny` 永远保持 deny，Lease 不得覆盖；Guard ALLOW 后 monotonic guard（`ctx.tools.guard()`）仍可 Deny，不得绕过。
- **允许“只收紧”的拒绝**（2026-11-01）：敏感路径保护通过原生 `tools.guard()` 注册，命中即拒绝；它只收紧、不放开，且 guard 内部异常必须返回 `undefined`（交回原生流程）。不得把任何原生 `deny` 翻回允许。
- **不自存 Secret**：当前没有凭证层（Broker 已移除）。任何未来的凭证相关能力必须走 DSH 原生 `ctx.credentials`，Guard 不得自建明文存储。

## 4. 技术栈与依赖

- 主链路：TypeScript + 当前 DSH/Cordis 版本（Service / events / waterfall 中间件）。
- 新增 SDK：**已随 Managed 链路移除**（2026-10-30），仓库不再有 `sdk/` 目录；禁止恢复 `@dsh-capsule/extension-sdk`。
- 依赖管理：pnpm workspaces（无 Python 依赖，不再使用 uv）。
- 任何路径禁止依赖：docker、python、unix socket、chmod、UID/GID、`/run/*`、Linux capability。

## 5. 强制实现规则（重构规格 MUST/MUST NOT 逐条遵守）

1. 基于现有仓库增量重构，禁止另起炉灶；动手前先跑现有 TypeScript 测试确认基线。
2. Legacy Python / Docker Runtime 已按项目决策移除（2026-09-14），禁止恢复；新增代码一律纯 TypeScript。
3. 不修改 DSH Core 源码，以独立 DSH Plugin 接入。
4. DSH API（`tools/pre-execute`、`approval/request`、`tools/result`、Cordis Service、`ctx.credentials`）以当前安装版本 TypeScript 类型定义为准，禁止凭猜测硬编码（规格第 34 节校验基线，2026-09-14）。
5. Universal V1 默认路径不得 spawn Python、不得依赖 Docker。
6. Lease 必须绑定 Session，一律取 `exec.agent.id`；agent 缺失则禁止创建 Lease（不得发明 global / anonymous lease），保持原始 ask/deny 语义。
7. 默认 Universal Scope 必须是 exact-arguments（toolName + canonical JSON 参数（去掉 justification）+ 目标沙箱档位的 SHA-256）；`tool` 宽 scope 只允许用户显式配置，禁止作为默认值。
8. 禁止用 LLM 或字符串启发式猜测 Tool 的 Provider/Resource/Action；Tool Name 字符串猜测不得当作安全边界。
9. Lease 复用不能覆盖原始 DENY；只有下游 `ask` 才进入 Guard。
10. Approval reason 必须明确告知"批准将签发 Scope=xxx、TTL=xx 秒的短期 Lease"；只有 `allowed-once` 才签发，禁止把 allowed-once 静默扩展成 Lease。
11. 并行调用必须通过 callId（PendingExecution Map）隔离上下文；禁止 global `currentSession/currentTool`。
12. 过期采用 find/validate 时实时比较 `Date.now()`，禁止依赖 setInterval 作为安全正确性前提（低频 GC 只做内存回收）。
13. 所有关键失败路径 Fail Closed：Scope Resolver 抛错、TTL 非法、Lease 状态不合法、Provider/Resource/Action 不一致等一律拒绝或不签发。
14. Credential 不得写入日志、Lease、Audit、Tool Result、异常信息；每次 Provider operation 重新 resolve，禁止缓存。
15. 错误统一使用规格第 18 节错误码（`LEASE_REQUIRED` / `CAPABILITY_MISMATCH` / `CREDENTIAL_NOT_CONFIGURED` 等），禁止杂乱字符串。
16. 每完成一个 Phase，先补齐规格要求的测试并全部通过，再进入下一 Phase；禁止为通过测试删除安全断言。
17. V1 禁止顺手实现 Dashboard/Web UI（Phase 4 才做）；禁止在同一 Phase 大规模 Rename 仓库（项目名暂保 dsh-capsule，新模块内部命名用 Capability Guard / LeaseManager）。
18. **审批瀑布三条红线（2026-09-14 基线；2026-10-31 窄化 (a)；2026-11-01 增加免打扰窗口例外 (a1)）**：
    (a) `approval/request` 处理器**默认只观察**：默认路径必须 `await next()` 并原样返回其结果。
    **例外一（同操作复用，代答 `allowed-once`）必须同时满足 5 个条件**：① 本 `callId` 被 Guard 亲自记录过（`tools/execute` 的 OperationRegistry 记录，或 `tools/pre-execute` 留下的 pending 记录，且两者都带 session/tool/scope）；
    ② 审批请求的会话与工具名与记录一致；③ 存在 ACTIVE 且未过期的授权；④ 授权 scope key 与本次操作指纹完全一致；
    ⑤ 用户开关处于启用状态。任一不满足 → 必须 `await next()`。
    该例外只表示「同一条操作，人已经批准过一次」，不提升任何权限。由 `operation-reuse.test.ts` 九条用例守护
    （无记录 / 会话不符 / 参数不同 / 目标档位不同 / 过期 / 撤销 / 被拒绝 / 关闭开关 全部必须惊动人类答话器）。
    (a1) **例外二（免打扰窗口，代答 `allowed-once`）**：仅当同时满足 ① 注入 `settings` 且 `enabled=true`；
    ② 该会话存在由用户显式开启、未过期的免打扰窗口；③ 本 `callId` 在 `tools/execute` 被 Guard 记录过；
    ④ 审批的会话/工具与记录一致；⑤ 记录里带 `requestedMode`（即这是一次沙箱升级，不是普通审批）。
    满足时代答 `allowed-once` 并写 `DND_ALLOWED`，**不签发 Lease、不提升档位**；任一不满足（含窗口到期/被手动结束/
    原生档位被改）必须 `await next()`。免打扰**绝不**接管没有 `requestedMode` 的审批，也不为子 session 开启
    （子 agent approval policy 被钉死为 `never`，见 (c)）。由 `capability/dnd.test.ts` 与
    `universal-gate.test.ts` 的免打扰用例守护。
    (a2) **`approval/request` 上只允许注册这一个 prepend 监听器**（2026-09-14 真 cordis 实测：prepend 监听器互相遮蔽——后注册的 prepend 排最前，认领后不再调用 `next()`，先注册者收不到事件）。任何额外的 prepend 监听器都会把 Guard 挤出观察位置，造成"审批通过却静默不签发 Lease"。同时必须校验审批发起者 session 与上下文一致，不一致一律不接管。
    (b) **Guard 不得改写会话沙箱档位**（2026-11-01）：禁止调用 `setSandboxMode` / `permissionPresets.set` / `approval.setPolicy`（内置 `danger-full-access` preset 配 `approval: never`，调用即永久关闭审批）。批准一次只放行当次调用 + 在 TTL 内代答同一条操作；档位始终由用户与 DSH 决定。
    (c) **禁止为子 session 签发 Lease** —— 子 agent 的 approval policy 被 DSH 钉死为 `never`，其授权请求在瀑布派发前就 fail-closed；跨 session 继承授权在设计上不可能，也不允许尝试。

## 6. 实现阶段顺序（重构规格第 24 节，禁止跳序或超前）

1. **Phase 0**：冻结旧 Docker Runtime——旧 TS 文件（rpc-client / approval / credentials / tool-loader）移入 `adapter/src/legacy/`，默认启动不 spawn Python，旧测试保持可独立运行。
2. **Phase 1**：Universal Short-lived Authorization——types / canonical / scope-resolver / escalation / policy / MemoryLeaseStore / LeaseManager / PendingExecution + **四个 hook**（`tools/pre-execute`、`tools/execute`、`approval/request`、`tools/result`）+ audit。
   *（2026-09-14 基线修正：原为三个 hook。`tools/execute` 是唯一能同时拿到 callId 与 arguments 的时机，属 Phase 1 基线的必要组成部分，不新开 Phase。）*
3. ~~**Phase 2**：Managed Capability Service（`ctx.capabilities` register / execute / 语义 Scope）~~（已作废：2026-10-30 移除）。
4. ~~**Phase 3**：Credential Broker（ProviderRegistry + GitHubProvider + per-operation resolve）~~（已作废：凭证交由 DSH 原生）。
5. **Phase 4**：Governance Console / Observability。
6. ~~**Phase 5**：Optional Isolated Runtime~~（已作废：Legacy Python/Docker 层按项目决策移除，不再实现）。

Phase 0/1/4 有效，Phase 2/3/5 已作废。当前验收基线见第 7.2 节：**通用场景的权限生命周期**（ask → 签发 → 复用 → 过期/撤销，
含免打扰窗口的自动放行）已端到端跑通并有真 cordis 集成测试守护；治理界面（输入框模式 chip / 能力授权 tab）
已接入 DSH Web GUI。

## 7. 目录结构（新增模块必须归位）

```text
adapter/src/
├── index.ts                 # Guard Plugin 入口（纯 TypeScript）+ buildSandboxModeReader 宿主只读适配器
├── capability/              # types / canonical / scope-resolver / escalation / policy / settings
│                            #   / dnd / sensitive-paths / access-log / lease-store / lease-manager / pending
│                            #   / operation-registry / families / universal-gate
├── integration/             # 真 @deepseek-ai/cordis 集成测试：cordis-pipeline（hook 接线与瀑布认领语义）
│                            #   / plugin-activation（Context.plugin 装载）/ cordis-get-semantics（ctx.get 降级契约）
├── audit/                   # types / catalog / audit-service / journal
└── console/                 # types / policy（运行期挡位与 TTL）/ console-service / decisions（授权决策记录）
                             #   / session-directory / actions（仅撤销授权）/ http-server / console-ui（独立页面）
adapter/client.js            # DSH 客户端半边：输入框模式 chip（conversation.input.left）
                             #   + 会话内「能力授权」tab（conversation.view）
scripts/smoke-console.mjs    # 本地手工冒烟（示例数据 + 独立治理页面）
assets/                      # README 用示意图（结构示意，非截图）
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
4. **策略写接口只能改 `defaultScope` / `defaultTtlSeconds` / `maxTtlSeconds`**：
   `enabled` 与 `rules` 是部署配置，接口层返回 400；`tool` 挡位禁止作为默认值（规格第 7 条）。
   运行期改动**不落盘**（Guard 不写 profile 的 `cordis.patch.yml`）。
4.1. **治理台动作接口（2026-10-31 批准；2026-11-01 收敛为撤销 + 免打扰）**：`POST /api/revoke`、
   `/api/dnd`、`/api/dnd/stop`、`/api/dnd/extend`。
   - `POST /api/revoke` 只有一个动作：撤销该会话全部有效授权（`{ sessionId }`）。它**不影响沙箱档位**
     （档位是用户自己的设置）；`action` 字段已不接受（未知字段一律 400）。
   - **`/api/dnd` 是用户显式开启的免打扰窗口（限时完全访问的审批放行层）**：请求体
     `{ sessionId, ttlSeconds }`；窗口状态由 `capability/dnd.ts` 的 `DndManager` 独占，**不写沙箱档位、
     不写审批策略、不签发 Lease**。约束：TTL 为正整数且 ≤ 运行期 `maxTtlSeconds`；必须能解析到真实 Session；
     `enabled=false` 或当前档位是 `danger-full-access` 时拒绝（后者没有可放行的审批）；
   - `/api/dnd/stop`（`{sessionId}`）纯收缩；`/api/dnd/extend`（`{sessionId, addSeconds}`）延长，
     但窗口总时长不得超过 `maxTtlSeconds`（不允许续成永久授权）；
   - **`/api/window`、`action=restore-sandbox`、`openWindow`、`SandboxGrantManager` 已删除（2026-11-01）**，
     禁止以任何理由恢复。
   所有写接口共用同一套闸门（`x-dsh-guard` 头 + `application/json` + loopback 来源），非 POST 一律 405；
   都写审计（`LEASE_REVOKED` / `DND_*`）。
   **`GET /api/audit/export`** 是只读导出（附件 JSON，含 `decisionLabel`），仅 loopback。
   **安全提示（必须写进 README）**：治理接口是本机 loopback 上的无鉴权面，"能开免打扰"就等于
   "窗口内能自动批准沙箱升级（限时完全访问）"；不信任本机进程时请把 `console.enabled` 设为 `false`。
4.2. **敏感路径保护（2026-11-01 新增）**：`capability/sensitive-paths.ts` 提供内置规则（SSH / 云凭据 /
   浏览器配置读写全拦，`~/.dsh` 只禁写），通过 DSH 原生 `ctx.tools.guard()` 注册（服务缺失时跳过并写 stderr，
   即「不保护」而不是拒绝一切）。命中写 `STATIC_DENY` 审计；配置 `sensitivePaths` 可关闭或追加 `extra` 规则，
   非法形状在装配期直接失败（Fail Closed）。文件工具按参数路径判定；命令类工具只扫命令文本，**必须标注启发式**，
   不得宣称是安全边界。
4.3. **工作区外访问记录（2026-11-01 新增）**：`capability/access-log.ts` 在 `tools/execute` 观察点
   （Gate 的 `observe` 回调）记录文件类工具**工作区外**的读/写，按目录聚合后由 `sessions[].access` 下发。
   **只记目录、不记文件名/命令文本**；内存态（重启清空），审计写 `ACCESS_OUTSIDE`（同样只含目录）。
   工作区根读不到时不记录；`accessLog: false` 关闭。它是可观测性，**不参与任何允许/拒绝判定**。
5. **客户端半边的槽位（2026-10-31 更新）**：`conversation.input.dock`（一眼层）与
   `conversation.view`（详情层）都是 session 作用域，组件直接拿到 `sessionId`；
   **不再注册 `main` 面板与 `sidebar.panellist` 图标**（项目所有者要求"先不做全局中台"）。
   旧的 `main` 槽是 root-scoped、`ownerProps` 为空，拿不到会话绑定——这正是放弃全局面板、
   改为会话内嵌的原因，不要再用服务端「最近活动」推断去冒充当前会话。
6. **改完宿主端插件代码必须重启 DSH**：profile 的 HMR 只重组配置，不会重新加载已装载的宿主模块的新一代
   JavaScript；只改 `client.js` 时 Web 客户端会通过客户端 HMR 重新加载，但**涉及接口/快照字段变化时必须重启**，
   否则会出现"新 UI 接旧接口"（客户端已用 `/api/config.features.dndWindow` 做降级提示）。
7. **治理台的两个状态必须分开（2026-11-01 更新）**：「授权是否仍有效」（`LeaseManager`）与
   「免打扰窗口是否仍在」（`DndManager.view()`）是两条独立状态；「当前沙箱档位」只是宿主实时读数
   （Guard 从不改写），读不到就是 `unknown`。**倒计时归零只表示结束，不得据此推断另外两个状态。**
8. **结算节拍 `sweepIntervalMs`（默认 30000，0 = 关闭）不是安全机制**：
   它只调用 `DndManager.sweep()` 让窗口的到期/档位漂移及时落到状态与审计上；授权有效性始终由 `LeaseManager` 实时判定。
9. **提示条槽位（`conversation.input.dock`）保留但当前不渲染**：`client.js` 的 `GuardDock` 直接返回 `null`
   （2026-10-31 项目所有者要求移除；信息由输入框模式 chip 与能力授权 tab 承担）。该槽位是 list +
   `replaceRisk: none`，日后恢复时仍可直接用 `sessionId`；提示条上不得做审批、签发或放宽。
   **输入框模式 chip（`conversation.input.left`）在完全访问档位隐藏**（2026-11-01 项目所有者要求）：
   判定集中在 `GuardModeChip.hiddenFor(mode)`，只有 `danger-full-access` 为真；该档位没有可放行的审批，
   隐藏**不修改**用户设置——切回其他档位后入口与原设置一起恢复；tab 里另显示一行「完全访问档位：无需授权」。
10. **会话内详情页挂在 `conversation.view`（2026-10-31 Inspect 实测，详情层）**：
    该槽位是 list，现有占位者是 `chat`(order 0) 与 `trajectory`(order 10)，我们的
    `guard`(order 20, label 能力授权) 就是**第三个 tab**；`replaceRisk: none`，不会顶掉前两个，
    同样直接拿到 `sessionId`。
    **全局入口已按项目所有者要求移除**：`main` 面板与 `sidebar.panellist` 图标不再注册（"先不做全局中台"）；
    独立 HTTP 页面保留，仅作排障与接口验证，不作为面向使用者的入口。
    显示规则（2026-10-31 改定）：输入框左侧的模式 chip 常驻显示"功能存在 + 当前模式 + 免打扰倒计时"；
    提示条没有可行动内容时整条隐藏。
11. **用户配置已搬到会话内「能力授权」tab（2026-11-01 更新）**：`settings.section` **不再注册**
    （放在设置页会误导成"全局另有入口"，且与产品决定冲突）。配置项收敛为：`enabled`（用户开关）+
    `reuseTtlSeconds` + `dndDurationSeconds`，经 `PATCH /api/config { settings: {...} }` 写入
    （与 `capability/settings.ts` 的 `GuardSettings` 一一对应，校验 Fail Closed）。
    **免打扰不再是设置里的 `mode` / `dndTargetMode`**：它是一次 `POST /api/dnd` 的窗口，窗口的开关、
    结束、延长各自是动作接口，不写设置。部署配置（`enabled` / `rules` / `defaultScopePaths` / `sweepIntervalMs`）
    仍然只能改 profile，页面只读。
12. **授权决策记录才是面向人的审计面（2026-10-31）**：`console/decisions.ts` 是**纯函数**，把 Lease + 审计事件
    折叠成「一条授权一份记录」（批准了什么 → 复用几次 → 怎么结束），由 `GET /api/decisions`
    与会话内 tab 共用；`PASSTHROUGH_*` / `TOOL_*` 属遥测，默认折叠在「原始事件（排障用）」里，
    不得再当作"审计"摆给用户看。会话统计中的 `savedApprovals` = 该会话 `LEASE_REUSED` 次数，
    它是**价值指标**（用户少点了几次批准），不是安全指标，不得用于任何权限判定。
13. **文案只有一份来源（2026-10-31，C 类收敛；2026-11-01 更新）**：审计决策的 id/类型/中文名在
    `audit/catalog.ts`（`AUDIT_DECISIONS` / `AuditDecision` / `AUDIT_DECISION_LABELS`），沙箱档位中文名在
    `capability/escalation.ts`（`SANDBOX_MODE_LABELS` / `sandboxModeLabel`），挡位菜单的中文名与说明在
    `capability/settings.ts`（`GUARD_MODE_LABELS` / `GUARD_MODE_SUMMARIES`，仅作 UI 目录，不再持久化）。
    接口负责把**结果文本**下发：`/api/config.catalog`（决策目录 + 沙箱档位目录 + 挡位菜单目录）、
    `/api/audit` 的 `decisionLabel`、`/api/snapshot` 的 `currentModeText` 与 `sessions[].dnd.recent[].requestedModeText`。
    **前端（`client.js` / `console-ui.ts`）禁止再维护任何决策、档位或模式的映射表**——新增一项只应改对应 catalog；
    历史缺陷正是"加一个决策要改三个文件，漏一处就静默不显示"。
14. **短期授权 + 免打扰窗口（2026-11-01 定稿，取代旧的"两档模式/提升档位"语义）**：
    - **短期授权**：`same-operation` 语义的 Lease 复用——命令前缀（程序 + 子命令；复合命令按 ALL 语义逐条都要有放行）+
      同一文件 / 同一目录（均带目标档位）+ 只读工具族；破坏性程序（rm/del/Remove-Item/mv/format…）与高危子命令
      （git push 等）**不产生任何族**。旧的 `same-family` 只作为**输入别名**保留，读入即归一成 `same-operation`。
    - **免打扰窗口**：用户显式开启的「限时完全访问」审批放行层（`capability/dnd.ts`）。窗口内只自动批准本会话
      带 `requestedMode` 的已记录沙箱升级（`allowed-once`，记 `DND_ALLOWED`）；**不改沙箱档位、不改审批策略、
      不签发 Lease**；`danger-full-access` 挡位下不可开启；到期 / 用户手动结束 / 原生挡位被改 / 插件卸载立即失效；
      窗口状态由 `DndManager` 单独投影为 `sessions[].dnd`，**不得伪装成 Lease 或混进授权列表**。
    - **不再有持久化 `mode` / `dndTargetMode`**；配置只有 `enabled` / `reuseTtlSeconds` / `dndDurationSeconds`。
    - `enabled=false`（用户开关关闭）时所有 hook 直接透传：不记 pending、不签发、不写档位、不写审计；免打扰窗口也不会被创建。
15. **审计持久化（2026-10-31）**：`audit/journal.ts` 把「审计事件」与「授权记录」以 **NDJSON 追加**写入
    `<用户目录>/.dsh/capability-guard/audit.ndjson`（可用 `auditFile` 覆盖，`persistAudit: false` 关闭），
    启动时重放回 `AuditService` 与 `MemoryLeaseStore`（同一 Lease 只保留最后状态）。
    文件超过 20 MB 轮转为 `.1`（只保留一代）；坏行跳过、写失败静默（**绝不影响审批主链路**）。
    日志里只有工具名 / scope 哈希 / 脱敏展示串，**没有任何参数原文与 Secret**。它只存在本机，不涉及任何远端。

## 7.2 当前验收基线

- **通用权限生命周期已跑通**：`adapter/src/integration/permission-lifecycle.test.ts` 在真 cordis 上覆盖
  ask → allowed-once → 签发 → 复用 → TTL 过期 / 撤销 → 重新询问，以及沙箱升级请求的
  「批准一次 → 同一条操作（不同 justification）不再惊动人类 → 到期恢复询问」，并验证治理视图里
  授权状态与宿主档位读数互不影响。
- **免打扰窗口已跑通（2026-11-01）**：`capability/dnd.test.ts`（窗口开启/到期/停止/延长/档位漂移/审计）+
  `universal-gate.test.ts` 的 5 条接线用例（窗口内只放行带 requestedMode 的升级、无窗口/无 requestedMode/
  到期/跨会话全部委派）+ `http-actions.test.ts` 的三组接口用例 + `console.test.ts` 的 `sessions[].dnd` 投影。
  语义见 7.1 第 14 条：免打扰是窗口，不是持久化模式，也不写沙箱档位。
- **沙箱档位提升/回滚已按项目决策整体移除（2026-11-01）**：`capability/sandbox-grant.ts`、
  `capability/sandbox-audit.ts`、`/api/window`、`action=restore-sandbox`、`sandbox-mode` Lease 种类、
  `sandbox-escalation` 范围挡位与 `SANDBOX_MODE_*` 审计决策均已删除；禁止以"历史保留"为由恢复。
  唯一会读宿主档位的地方是 `buildSandboxModeReader`（只读，用于展示与免打扰适用性判断）。
- **权限代理（Managed Broker 链路）已按项目决策整体移除（2026-10-30）**：`broker/`、`service/`、
  `sdk/typescript/`、`extensions/github-demo/` 均已删除（2026-10-31 清理空目录与残留文件）。
  当前交付面只有：通用短期授权、免打扰窗口、授权决策记录、治理界面。
- 治理界面的入口：输入框模式 chip（`conversation.input.left`）＋会话内「能力授权」tab
  （`conversation.view`），见 7.1 第 9、10 条；独立页面仅作排障，不注册全局面板。
- **敏感路径保护已接入（2026-11-01）**：`capability/sensitive-paths.test.ts` 覆盖路径规范化、前缀边界
  （`.ssh-backup` 不误伤）、`deny` / `deny-write` 语义、命令文本启发式、guard 异常回退；
  `index.test.ts` 覆盖默认注册、`sensitivePaths:false` 不注册、配置解析 Fail Closed；
  `console.test.ts` 覆盖 `/api/audit/export`。装配时写 `GUARD_APPLY` 自检事件。
- **免打扰到期提醒**：`client.js` 的 `GuardModeChip.endingSoon` 在剩余 ≤2 分钟时高亮（仅展示）。
- **工作区外访问记录已接入（2026-11-01）**：`capability/access-log.test.ts` 覆盖路径提取、工作区边界
  （同名前缀兄弟目录算外面）、目录聚合、会话隔离、有界淘汰；`console.test.ts` 覆盖 `sessions[].access` 投影；
  `console-ui.test.ts` 覆盖 tab 卡片文案。默认开启，`accessLog:false` 关闭。

## 8. 安全声明边界（README / 注释不得混淆）

- Universal Mode 可声明：短期授权、Session/Scope 绑定、TTL、撤销、授权决策记录、零改造集成；**不得**声明"第三方插件看不到 Credential / 网络被隔离"。
- **敏感路径保护不得被描述为安全边界或沙箱**：命令类工具只是文本扫描，可被刻意规避；它只防明显误操作。
- ~~Managed Broker Mode~~：该模式已随 2026-10-30 决策移除，不得再出现在 README / 文档 / 对外口径里。
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
