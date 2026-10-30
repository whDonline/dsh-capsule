<p align="center">
  <b>DSH Capsule · Capability Guard</b>
</p>

<p align="center">
  <a href="README.md"><b>简体中文</b></a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-4F46E5?style=flat-square" alt="DeepSeek Harness Plugin" />
  <img src="https://img.shields.io/badge/status-Developer_Preview-F59E0B?style=flat-square" alt="Developer Preview" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/Runtime_Dependencies-0-12B76A?style=flat-square" alt="No runtime dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-12B76A?style=flat-square" alt="MIT" />
</p>

<p align="center">
  <b>让 Agent 的临时授权有期限、可收回、可审计。</b>
</p>

<p align="center">
  DSH Capsule 是面向 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的 <b>Capability Guard</b>：<br/>
  为已有审批增加短期 Lease，并管理沙箱模式提升、到期回滚与审计。
</p>

> [!IMPORTANT]
> **项目定位已经变化。** 当前仓库是纯 TypeScript 的 Capability Guard，不再包含旧版 Python / Docker / Unix Domain Socket 隔离 Runtime。本文只描述当前代码真实存在的能力。2026-10-30 按项目决策移除凭证代理、命令凭证绑定及 Managed SDK/示例，当前聚焦通用短期授权。

> [!WARNING]
> **Developer Preview。** 核心链路（Lease、沙箱升级有界授权、Audit、Console）已在仓库实现，有**真 cordis 集成测试**守护 hook 接线与完整权限生命周期，并已在本机 desktop profile 中实跑。
>
> DSH 本身仍在快速迭代：本仓库与本机安装版源码的核对结论记录在 `docs/集成基线-真实DSH行为.md`，**升级 DSH 后请重跑该文档第 10 节的检查清单**。

---

## 为什么需要它？

DSH 原生的权限体系有两层，中间是空的：

| DSH 原生 | 粒度 | 代价 |
|---|---|---|
| `permission-presets`（会话级沙箱 + 审批组合） | 一次生效、覆盖面广 | 粗：一放开就是整个会话 |
| `allowed-once`（单次审批） | 精确到这一次调用 | 细但每次都要问 |

缺的那一层是：**「这个 Session 内、这个工具、这类操作，在一段时间内已经批过了」**——既有界、又能复用、还能撤销与审计。

DSH Capsule 补的就是这一层：

| 问题 | DSH Capsule 的处理方式 |
|---|---|
| 同一个安全操作反复弹审批 | `allowed-once` 后签发短期 Lease，在相同 Scope + Session 内复用 |
| 授权范围太宽 | Lease 绑定 `Session × Tool × Scope × TTL` |
| 授权无法自动收回 | TTL 到期回收；沙箱模式提升还会**回滚到批准前的档位** |
| 发生了什么难以追踪 | Secret-safe Audit + 只读 Governance Console（放宽/回滚都会留痕） |
| 安全失败被静默放行 | 关键路径统一 **Fail Closed** |

一句话理解：

> **把一次明确批准变成有 Session、Scope 与 TTL 边界的短期授权。**

---

## 通用短期授权

### Universal Mode — 已有插件零改造获得短期授权

Guard 工作在 DSH 原生工具管线的**四个** hook 上（`tools/pre-execute` / `tools/execute` / `approval/request` / `tools/result`），原始语义保持不变：

- 原始 `deny`：始终保持 `deny`，Lease **不能覆盖拒绝**；
- 原始 `allow`：直接透传，Guard 不制造新的 Approval；
- 原始 `ask`：先查找匹配 Lease；命中则临时 `allow`，否则继续 `ask`；
- 用户返回 `allowed-once` 后，Guard 才签发带 Scope 与 TTL 的 Lease；
- `rejected` / `cancelled` / `unavailable` 均不签发。

> **沙箱升级（sandbox escalation）是当前最有价值的一条链路。** 它经过了与本机安装版 DSH 源码的逐行核对（结论见 `docs/集成基线-真实DSH行为.md`）：
>
> DSH 的 `tools/pre-execute` **落底决策就是 `allow`**，标准 profile 下没有任何随产品交付的监听器会返回 `ask`。真实审批来自 pwsh/bash/fs **工具体内部**的 `approveEscalation → ctx.approval.request(...)`（例如文件写入越出工作区时，模型带 `sandbox_permissions` + `justification` 重试）。
>
> 因此 Guard 的接入点是：在 `tools/execute`（工具体之前、参数仍可用）识别这次升级并按 **`(toolName, 目标模式)`** 生成语义 Scope；用户批准一次后签发 `sandbox-mode` Lease，并**提升该会话的沙箱模式**——后续同类升级不会被沙箱拒绝，也就**不再需要审批**。
>
> 到期或撤销时，模式会**回滚到批准前的档位**；若用户在此期间手动改过模式，Guard 跳过回滚并记录审计，**绝不覆盖用户的选择**。

这意味着 Universal Mode 的价值是**减少重复审批，同时保持 DSH 原有权限语义不变**。

<p align="center">
  <img src="assets/universal-lease-cn.svg" alt="Universal Mode Lease Flow" width="100%" />
</p>

## 整体架构

Guard 接在 DSH 原生工具与审批管线上，保持原有审批与沙箱职责。

- UniversalGate：四个 hook，关联 callId、观察审批、签发与复用 Lease。
- ScopeResolver / PolicyResolver：确定性范围解析与 TTL 配置。
- LeaseManager / MemoryLeaseStore：Session 绑定、有效期与撤销。
- SandboxGrantManager：会话沙箱模式提升、失效回滚与用户改动冲突检测。
- AuditService / GovernanceConsole：脱敏审计、授权剩余时间与运行期策略。

### 与 DSH 原生机制的边界

DSH Capsule **不是第二套 Harness**。它有意复用 DSH 已有机制：

- Approval 仍由 DSH 原生 `approval/request` Answerer 决定（Guard 只观察结果，**从不合成**）；
- Tool 最终是否允许执行仍受 DSH 其他 Gate / Guard 约束；
- 凭证管理仍由 DSH 原生服务或相关工具负责，Guard 不解析或注入凭证；
- 进程 / 文件 / 网络隔离仍由 DSH Sandbox 或外部安全机制负责；
- 沙箱档位本身仍由 DSH 的会话状态承载，Guard 只是**给它的变更加上时间边界与回滚**。

Guard 只新增一件事：**把一次明确的授权变成受 Scope、Session 与 TTL 约束的短期 Capability。**

---

## Capability Lease

一份 Lease 的核心身份不是“这个插件被允许了”，而是：

```text
Session × Tool × Scope × TTL
```

默认 Scope 按工具名与 canonical JSON 参数生成 SHA-256；沙箱升级按工具名与目标模式生成 Scope。

### Lease 生命周期

```text
ASK
 └─ allowed-once
      └─ ISSUE ────────┐
                       │
                  ACTIVE
                   ├─ match → REUSE
                   ├─ TTL   → EXPIRED
                   └─ revoke→ REVOKED
```

- TTL 在 `find` / `validate` 时通过当前时间实时判断，正确性不依赖后台定时器；
- Lease 始终绑定 Session；缺少可信 `agent.id` 时不会创建匿名 / 全局 Lease；
- `revoke(leaseId)` 可撤销单条 Lease；
- `revokeSession(sessionId)` 可一次撤销整个 Session 的 Lease；
- 当前默认存储是 `MemoryLeaseStore`，重启后不会保留。

---

## Scope：决定“授权可以复用到哪里”

### `exact-arguments` — 默认

默认 Scope：

```text
SHA-256(toolName + canonical JSON(arguments))
```

只有 Tool 与参数完全一致时才能复用，是 Universal Mode 最保守的零配置策略。

### `fields` — 显式放宽

只把指定字段纳入 Scope。例如只按 `repo` 与 `branch` 授权，其他参数变化不会重新 Ask。

### `tool` — 最宽

同一 Session 内只按 Tool Name 复用。它必须显式配置，不能成为默认行为。

### `sandbox-escalation` — 沙箱升级语义 Scope

只对带 `sandbox_permissions` + `justification` 的调用生效，Scope Key 为：

```text
SHA-256(toolName + 目标沙箱模式)
```

**刻意不把 `justification` 或参数原文纳入 Scope**：前者是模型每次现写的自由文本，纳入就等于把安全边界建立在模型输出上，且措辞一变授权立即失效；后者在升级场景里复用率几乎为零。按 `(工具, 目标模式)` 取键，语义恰好是「本会话内该工具可以升到这一档」。

启用方式（默认**不启用**，不配置就完全不改变 DSH 行为）：

```jsonc
{
  "rules": [
    { "match": "pwsh", "scope": { "mode": "sandbox-escalation" }, "ttlSeconds": 300 }
  ]
}
```

授权真正生效依赖宿主服务（`ctx.sessionProjections` + `session.append("sandbox/mode", …)`）；服务缺失时该链路自动降级为"不提升"，即回到 DSH 原生逐次审批，**不会越权**。

## Governance Console

<p align="center">
  <img src="assets/governance-console-cn.svg" alt="Governance Console Preview" width="100%" />
</p>

治理界面按「先会话、后全局」组织；前两个入口都挂在**会话作用域**上，组件直接拿到宿主传入的 `sessionId`，
因此显示的一定是当前会话：

1. **【一眼】对话内常驻提示条**：输入框上方（`conversation.input.dock`），打开会话就能看到
   「放开了什么 / 还剩多久 / 到期会怎样 / 提前收回」，**不需要点开任何东西**；
2. **【详情】会话内「能力授权」标签页**：排在 对话 / 轨迹 之后的第三个 tab（`conversation.view`，order 20），
   整页展示本会话的每条授权、权限级别状态、到期后果、技术详情与本会话最近记录；
3. **【排障】独立只读页面**：`http://127.0.0.1:8787/`，用于没有 Web GUI 的组合或接口排障，
   不再是面向使用者的入口。

> 2026-10-31 按项目所有者要求调整：**先不做全局中台**。原先挂在左侧栏的「能力授权」面板与图标已移除，
> 全局视图（全部会话 / 审计 / 挡位设置）暂时只在独立页面提供。

对话内提示条长这样（**没有授权时也保留一行**，否则用户会以为功能不存在）：

```text
● 本会话临时放开：pwsh 可以免审批升到「完全访问」
  还剩 4 分 12 秒 · 到期后会自动收回，之后同类操作会再问你一次。        [ 提前收回 ]

⚠ 临时授权已经到期，但权限还停在「完全访问」，没有收回。
  点「现在收回」可以立刻恢复；不点的话，下次执行命令时也会自动收回。    [ 现在收回 ]

✓ 已收回：本会话的临时授权结束了，权限已回到「工作区可写」。
```

该槽位是 **session 作用域**，组件直接拿宿主传入的 `sessionId`，所以提示条显示的**一定是当前会话**（不是「最近有授权的会话」那种推断）。提示条上唯一的写操作是「提前收回」（纯收缩），审批与签发仍然只走 DSH 原生流程。

独立页面（与上面的会话内 tab 共用同一份数据源）的视图：

```text
当前会话       会话名 · 授权状态与剩余时间 · 沙箱档位是否已恢复 · 到期后会怎样 · 立即收回 / 立即回滚档位
全部会话       本进程内出现过的授权会话，点会话名可切换聚焦
审计           按 sessionId / toolName / decision 过滤的治理事件流（含档位提升、回滚与收回）
设置           默认范围挡位、TTL 上下限、只读部署规则、运行信息
```

**授权状态与沙箱档位是两个独立状态**，页面分行显示，绝不合并成一个倒计时：

| 授权状态 | 含义 |
|---|---|
| 生效中 / 即将到期 | 还有可复用的短期授权（≤30s 标为即将到期） |
| 已到期 / 已撤销 | 授权已失效，接下来的同类调用会重新询问 |

| 沙箱档位状态 | 含义 |
|---|---|
| 已提升：完全访问 | Guard 提升过档位，且授权仍有效 |
| 未改动（本来就够宽） | 授权有效，但档位本来就够宽，Guard 没动过 |
| 由你设定 | 档位是你自己改的，Guard 不会覆盖你的选择 |
| **待回滚** | **授权已失效，但档位还没收回**——倒计时归零并不等于恢复完成，页面会明确显示并提供「立即回滚档位」 |
| 已恢复 | 授权已失效，档位已回滚 |
| 无法确认 | 读不到宿主档位（能力缺失），页面不会假装已恢复 |
| 不涉及沙箱档位 | 本会话只有普通工具授权 |

原始 `Lease ID`、`sessionId`、Scope 哈希与完整 Scope 串只出现在「技术详情」展开区；会话名来自 DSH 的会话标题（`ctx.sessionTitle`），读不到时降级为工作目录名或短 ID。

档位自动回滚（`sweepIntervalMs`，默认 **30000**，`0` 表示关闭）：

```ts
{
  sweepIntervalMs: 30000,   // 每 30s 结算一次「授权已失效但档位还没收回」的会话
  console: { enabled: true, host: "127.0.0.1", port: 8787 }
}
```

> 定时器**不是安全机制**：授权是否有效始终在读写时实时判定；关掉它只会让回滚推迟到「下次任意工具调用」或用户点按钮。

配置（默认**已开启**；端口被占用时自动回退到系统分配的随机端口，实际地址写在 stderr 里）：

```ts
{
  console: {
    enabled: true,
    host: "127.0.0.1",
    port: 8787,
  }
}
```

只提供：

```text
GET   /                 前端页面（独立入口；支持 ?session=<id> 聚焦会话）
GET   /console.js       共享前端脚本（面板与独立页面复用）
GET   /api/snapshot     治理快照（会话视图 + 每条授权的剩余毫秒；可带 ?session=<id>）
GET   /api/audit        审计过滤查询
GET   /api/config       运行期策略 + 挡位目录 + 收缩动作可用性 + 自动回滚节拍
PATCH /api/config       写接口：defaultScope / defaultTtlSeconds / maxTtlSeconds
POST  /api/revoke       收缩型动作：action=revoke（撤销本会话全部授权）| restore-sandbox（只回滚档位）
```

此外，插件会尝试把同一组接口挂到 DSH Web 服务器上的**同源**前缀 `/guard/…`（`registerGuardWebRoutes`）。
同源入口可用时面板优先走它（无跨源请求）；不可用时回落到独立端口（Console 对 loopback 来源开放 CORS）。
`/guard/` 与独立端口**互为备份**，任一可用治理台就能工作。

### 范围挡位（默认匹配范围）

治理台里可选的挡位，同时也是 `rules[].scope.mode` 的取值：

| 挡位 | 复用范围 | 可否作为默认值 |
|---|---|---|
| `exact-arguments` | 工具名 + 参数逐字节一致 | ✅（零配置默认） |
| `fields` | 只按指定字段取键 | ✅（未配置字段时使用兜底字段集合） |
| `sandbox-escalation` | 工具名 + 目标沙箱档位 | ✅ |
| `tool` | 同一 Session 内该工具的全部调用 | ❌ 必须按工具显式配置 |

> `tool` 被刻意排除在默认值之外（规格第 7 条）：默认值决定了「任意一次批准能复用多大范围」，
> 不允许它悄悄变成整个工具。

### 治理台的写权限边界

- 策略写接口只能改 `defaultScope` / `defaultTtlSeconds` / `maxTtlSeconds`；
- `enabled` 与 `rules` **接口层不可写**（返回 400）——页面不能关掉 Guard，也不能凭空新增授权规则；
- 运行期改动**不落盘**：Guard 不改写 profile 的 `cordis.patch.yml`，重启后回到 profile 配置值；
- **收缩型动作**（`POST /api/revoke`）只有两个方向，且都只能让权限变小：
  - `action=revoke`：撤销该会话仍有效的全部授权，并回滚会话沙箱档位；
  - `action=restore-sandbox`：只结算该会话中**已经失效**的授权并回写档位，仍有效的授权原样不动。
  - 两者都写审计（`LEASE_REVOKED` / `SANDBOX_MODE_RESTORED`），都遵守「用户手动改过档位则跳过回滚」的红线；
  - 页面仍然**不做任何审批与签发**动作（那些必须走 DSH 原生审批与 API）。

安全属性：

- 默认仅监听 `127.0.0.1`；Host 头必须是 loopback（DNS rebinding 防护）；
- 跨源只回显 loopback 来源，非 loopback 来源直接 403；
- 写接口要求自定义头（`x-dsh-guard`）＋ `application/json`，靠浏览器预检挡住 CSRF；
- 响应使用 `no-store`、`nosniff` 与 CSP；前端所有动态数据通过 `textContent` 渲染；
- 只展示白名单投影，不包含 Credential、Authorization Header 或原始 Tool Arguments。

---

## 快速开始

### 环境要求

- Node.js `22`
- pnpm `11.25.0`（仓库 `packageManager` 已固定版本）
- Windows / macOS / Linux 均可运行核心 TypeScript 代码；CI 已配置三平台矩阵

> [!NOTE]
> `@dsh-capsule/adapter` 现已声明 `dsh.bundle.patch`（见 `adapter/cordis.patch.yml`），因此可以作为一个 profile bundle 层被 DSH 装载；但**尚未在真实 profile 中做过端到端实跑**，也没有发布到 registry。下面的"源码开发方式"与"接入 DSH profile"两段都请按 Developer Preview 对待。

```bash
git clone <your-repository-url>
cd dsh-capsule

pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Workspace：

```text
@dsh-capsule/adapter
```

### 接入 DSH profile

插件包的 `package.json` 声明了 bundle patch，因此用 DSH 自带的 profile 插件管理命令即可接入：

```bash
# 把本仓库的 adapter 作为一个 bundle 装进目标 profile（web / desktop / …）
dsh plugin --profile web add <本仓库 adapter 目录的绝对路径>

# 装载前先离线检查组合结果（不 boot、不执行任何插件代码）
dsh --profile web --dump-config

# 启动
dsh web
```

安装后 Guard 会注册四个观察型 hook，并默认打开治理台。开箱默认行为：

- 默认范围挡位 `exact-arguments`（可在治理台里切换）；
- 为 `pwsh` / `bash` 打开沙箱升级复用（`sandbox-escalation`，TTL 300s）——
  **只有**带 `sandbox_permissions` + `justification` 的调用会进入这条链路，其余调用完全不受影响；
- 治理台监听 `127.0.0.1:8787`。

要按自己的偏好覆盖，在 profile 的 `cordis.patch.yml` 中按 `id` 覆盖该行（patch 会替换整行 config，请重述要保留的字段）：

```yaml
- id: capability-guard
  name: '@dsh-capsule/adapter'
  config:
    defaultTtlSeconds: 60
    maxTtlSeconds: 1800
    defaultScope: exact-arguments
    console: { enabled: true, host: 127.0.0.1, port: 8787 }
    rules:
      - match: pwsh
        ttlSeconds: 300
        scope: { mode: sandbox-escalation }
      - match: deploy.preview
        ttlSeconds: 120
        scope: { mode: fields, paths: [project, environment] }
```

> 本仓库的 `adapter/cordis.patch.yml` 可用 `dsh --profile <name> --dump-config --patch <该文件路径>` 单独验证语法，无需真正安装。
>
> 改完插件代码后需要**重启 DSH**：profile 的 HMR 只重组配置，不会重新加载已装载模块的新一代 JavaScript。

### 默认策略

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: []
}
```

其中 `defaultScope`（默认范围挡位）与两个 TTL 可以在 DSH Web GUI 的治理台里运行期切换；
`enabled` 与 `rules` 属于部署配置，只能在 profile patch 里改。

### Tool 级规则

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: [
    {
      match: "deploy.preview",
      ttlSeconds: 120,
      scope: {
        mode: "fields",
        paths: ["project", "environment"]
      }
    },
    {
      // 沙箱升级：本会话内该工具可升到 danger-full-access，批准一次后 300 秒内免问，
      // 到期回滚到批准前的档位。默认不配置 = 完全不改变 DSH 行为。
      match: "pwsh",
      ttlSeconds: 300,
      scope: { mode: "sandbox-escalation" }
    },
    {
      match: "dangerous.admin",
      enabled: false
    }
  ]
}
```

当前 V1 的 `match` 是**精确 Tool Name 匹配**，不是 glob / regex。

---

## Fail-Closed 错误模型

关键安全失败使用结构化错误码，而不是静默降级：

```text
LEASE_REVOKED
LEASE_EXPIRED
LEASE_TTL_INVALID
LEASE_SCOPE_INVALID
LEASE_POLICY_INVALID
```

核心原则：

> **无法校验身份、Scope 或 TTL 时，不签发或复用 Lease，保留原生审批语义。**

沙箱升级链路同样遵循这一原则，且可审计的治理事件是完整的（放宽与收回都有记录）：

```text
SANDBOX_MODE_RAISED                  会话沙箱模式被提升（含工具与目标档位）
SANDBOX_MODE_RESTORED                Lease 结束，模式已回滚
SANDBOX_MODE_SKIPPED_USER_OVERRIDE   检测到用户已手动改动模式，跳过回滚并交还控制权
```

---

## 安全边界与非目标

这是当前项目最重要的边界说明：

### Universal Mode 能承诺什么

- 为原本触发 `ask` 的 Tool（以及沙箱升级）增加短期 Lease；
- Session / Tool / Scope / TTL 绑定；
- 过期、撤销、复用与审计；
- 沙箱模式提升会在 Lease 结束后**回滚**，且不覆盖用户的手动改动；
- 不覆盖 DSH 原始 `deny`；
- 不修改已有 Tool 代码即可接入。

### Universal Mode **不能**承诺什么

- 不能保证任意第三方插件看不到 Credential；
- 不能阻止插件自己发网络请求；
- 不提供进程、容器、VM 或 microVM 级恶意代码隔离；
- **不能阻止其他插件认领 `approval/request`**：这是 DSH 的开放瀑布事件，"谁认领谁说了算"。任何插件都可以零交互返回 `allowed-once`，也可以抢先认领从而遮蔽 Guard 的观察位置。这是 DSH 事件模型的固有性质，不属于本插件能防御的范围；
- **不能阻止其他插件直接改写会话权限状态**：`setSandboxMode(session, mode)`、`ctx.permissionPresets.set(...)`、`ctx.approval.setPolicy(...)` 在 DSH 中都是公开 API，Guard 只是选择"只用其中最小的一档并加上边界"。

## 当前状态

| 能力 | 状态 |
|---|---|
| Universal Lease Gate（四 hook） | ✅ 已实现 |
| Session / Scope / TTL / Revoke | ✅ 已实现 |
| 沙箱升级有界授权（`sandbox-escalation` + 模式提升与回滚） | ✅ 已实现 |
| 真 cordis 集成测试（真实 `Context` / `waterfall` / `emit`） | ✅ 已实现 |
| 权限生命周期端到端集成测试（ask→签发→复用→过期/撤销） | ✅ 已实现（`integration/permission-lifecycle.test.ts`） |
| DSH 行为基线核实（逐行核对已安装版本源码） | ✅ 已完成（`docs/集成基线-真实DSH行为.md`） |
| 治理台：会话视图 / 授权剩余时间 / 两状态（授权有效 vs 档位已恢复）/ 审计 / 范围挡位 | ✅ 已实现（Web GUI 面板 + 独立页面 + `/guard/` 同源路由） |
| 治理台收缩型动作：立即收回 / 立即回滚档位（只收缩，带审计） | ✅ 已实现（`POST /api/revoke`） |
| 档位自动回滚（`sweepIntervalMs`，默认 30s，可关） | ✅ 已实现（非安全机制，只负责及时性） |
| Secret-safe Audit | ✅ 已实现 |
| Ubuntu / Windows / macOS CI workflow | ✅ 已配置 |
| 在真实 profile 中安装并实跑（hook 挂载 + 治理台 + 面板注册） | ✅ 已完成（本机 desktop profile） |
| 可直接安装的公开 DSH Release Package（`dsh.bundle.patch`） | ✅ 已具备（`dsh.bundle.patch` + `dsh.client`） |
| Durable Lease Store | 🗺️ Roadmap |

DeepSeek Harness 本身也处于 Developer Preview 并快速迭代，因此正式接入时应始终以当前安装版本的 TypeScript 类型为准，而不是把事件签名硬编码为长期兼容承诺。**升级 DSH 后请重跑 `docs/集成基线-真实DSH行为.md` 第 10 节的检查清单。**

---

## 仓库结构

```text
adapter/
├── client.js                 # DSH 治理台面板与侧栏入口
├── cordis.patch.yml          # 插件配置与默认沙箱升级规则
└── src/
    ├── index.ts              # 插件装配与宿主适配（含 30s 档位结算节拍）
    ├── capability/           # 四个 hook、Scope、Lease、沙箱提升与回滚、回滚审计
    ├── integration/          # 真 cordis 接线与权限生命周期测试
    ├── audit/                # 脱敏审计
    └── console/              # 会话视图 / 共享前端 / HTTP 接口 / 收缩型动作 / 会话名解析
scripts/smoke-console.mjs     # 治理台冒烟脚本（示例数据 + 真实收缩动作）
.github/workflows/ci.yml      # Windows / macOS / Linux 构建与测试
```

---

## 设计原则

**Preserve DSH semantics.** Guard 只增强 `ask`，不覆盖 `deny`，不重新发明 Approval。

**Short-lived authority.** 权限必须有明确 Session、Scope 与 TTL，而不是永久授权。

**Deterministic scope.** 安全边界来自确定性规则，不让 LLM 猜授权范围。

**Fail closed.** 身份、Scope 或 TTL 无法验证时不签发或复用授权。

**Secret-safe observability.** Audit 与 Console 只保留治理所需的白名单字段。

**Small trusted core.** 核心只负责短期授权生命周期，不代管凭证或执行外部业务。

---

## FAQ

### 这和 RBAC 有什么区别？

RBAC 更适合回答“这个角色通常拥有什么权限”。Capability Lease 回答的是：**这个 Session 在当前 TTL 内，是否允许这个 Tool 对这个 Scope 执行当前操作。** 它更适合 Agent 的动态、短时工作流。

### Universal Mode 能保护所有第三方插件吗？

它可以零改造地为**原本会触发 DSH `ask`** 的 Tool，以及**沙箱升级**，增加短期 Lease；但不能阻止其他插件认领 `approval/request`，也不能阻止插件访问其进程本身已经拥有的资源。

### 为什么默认 Scope 是 `exact-arguments`？

因为零配置情况下无法可靠猜测某个第三方 Tool 的业务资源语义。默认只复用完全相同的参数，宁可多问一次，也不扩大授权面。

**但要说实话**：在同一路径上，LLM 很少两次生成逐字节相同的参数，所以零配置的 `exact-arguments` 实际收益有限。真正省事的是显式配置 `fields`（按业务字段）或 `sandbox-escalation`（按工具与目标档位）——**收益来自显式配置，而不是默认值**。

### 沙箱升级为什么不把 `justification` 算进 Scope？

因为它是模型每次现写的自由文本。把它纳入 Scope 等于把安全边界建立在模型输出上，而且措辞一变授权立即失效、复用率几乎为零。Guard 只按 `(toolName, 目标模式)` 取键——这也符合"禁止用字符串启发式猜测安全边界"的项目规则。`justification` 只用于给人看（截断后展示）。

### 沙箱升级会不会把用户手动设的权限冲掉？

不会。回滚前会做冲突检测：如果当前模式已不是 Guard 最后写入的值（说明用户手动改过），Guard **跳过回滚**并写入 `SANDBOX_MODE_SKIPPED_USER_OVERRIDE` 审计，把控制权交还用户。

### 支持 Windows / macOS / Linux 吗？

当前主链路是纯 TypeScript，没有 Python / Docker / Unix Domain Socket 依赖；仓库 CI 也配置了三平台矩阵。真实 DSH 集成仍需按具体 DSH 版本做兼容性验证。

---

## Roadmap

近期聚焦授权范围与状态展示、生命周期异常恢复、审计与 DSH 版本兼容性。新增撤销界面、续期或更细范围前，需先更新规格并验证宿主执行边界；当前不承诺这些功能已经实现。

---

## Contributing

安全基础设施最需要的是**负向测试与清晰边界**。欢迎贡献：

- Lease / Scope / Session 隔离测试；
- 并发 `callId`、取消与生命周期 Race 测试；
- 审计脱敏回归测试；
- DSH 版本兼容性验证；
- 文档、Demo 与可复现集成样例。

如果一个改动会扩大可信计算面、引入凭证执行链路，或试图绕开 DSH 原生 Approval / Sandbox，请先讨论设计再实现。

---

## License

MIT License. See [`LICENSE`](LICENSE).

<p align="center">
  <b>DSH Capsule</b><br/>
  <sub>Short-lived authorization · Sandbox rollback · Fail-closed by design</sub>
</p>
