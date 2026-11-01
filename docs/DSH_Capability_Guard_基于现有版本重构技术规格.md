# DSH Capsule → DSH Capability Guard 重构技术规格

> **当前项目决策（2026-10-30 / 2026-11-01，项目所有者明确要求）**：凭证代理相关代码已移除，包括 Broker / Provider、命令凭证绑定、Managed Capability Service、Managed Extension SDK 与 GitHub 示例。
> **2026-11-01 追加决策：移除「提升会话沙箱档位 + TTL 回滚」整条链路**——`SandboxGrantManager`、`/api/window`、`action=restore-sandbox`、`sandbox-mode` Lease、`sandbox-escalation` 范围挡位、`WINDOW_OPENED` / `SANDBOX_MODE_*` 审计决策与档位状态机全部删除；Guard **不再调用 `setSandboxMode`**。
> 当前仅保留：通用短期授权（同一条操作复用）、免打扰窗口、审计、治理台。下文旧定位中涉及 Managed/Broker、档位提升与回滚的实现、保留及测试要求已作废，禁止按历史条款恢复这些模块；凭证管理交由 DSH 原生或相关工具。通用授权的安全红线及测试要求继续有效。

## 基于现有 `dsh-capsule-main` 的可执行实现文档

> ## ⚠️ 修正声明（2026-09-14，务必先读）
>
> 本规格中**关于 DSH 运行时行为的假设已被源码核实证伪**，正文相应条款**不再有效**。
> 有效来源自此为：`AGENTS.md` 顶部的"集成基线"四条 ＋ `docs/集成基线-真实DSH行为.md`（含行号引用）。
>
> **已被证伪、不得再据以实现的条款：**
>
> | 位置 | 原假设 | 真实行为 |
> |---|---|---|
> | 第 6.2 节 / 第 34 节 | 下游 DSH 原生策略会返回 `ask`，Gate 在 `tools/pre-execute` 接管 | `tools/pre-execute` **落底决策就是 `allow`**；标准 profile 下无任何随产品交付的 listener 返回 `ask` |
> | 第 6.3 / 11 节 | approval 请求可用于推导参数 Scope | 沙箱升级的审批来自**工具体内部**，且 `approval/request` 载荷**不含 arguments** |
> | 第 24 节 Phase 1 | Guard 挂**三个** hook | 实为**四个**：新增 `tools/execute`（唯一能同时拿到 callId 与 arguments 的时机） |
> | 第 5.4 节 | Scope 只有 exact-arguments / fields / tool | ~~新增 `sandbox-escalation`~~（**2026-11-01 再次作废**：该挡位与档位提升链路一起删除，默认只剩 exact-arguments） |
> | —— | Lease 签发即授权生效 | ~~必须配合 `setSandboxMode` 提升会话模式并在 TTL 到期时回滚~~（**2026-11-01 作废**：Guard 不写档位，批准一次只放行当次调用并在 TTL 内代答同一条操作） |
>
> **仍然有效、必须继续遵守的部分**：Fail-Closed 原则、错误码体系、Secret 处理规则、Phase 顺序与测试要求。
>
> 正文保留原样，仅作为历史设计记录，**不作为实现依据**。

> 文档目标：本规格用于直接交给 Codex / Claude Code / Trae / 其他 Coding Agent，在**现有仓库基础上增量重构**，不得脱离当前代码另起炉灶。
>
> 目标产品：面向 DeepSeek Harness（DSH）的**通用 Tool 短期授权 + Managed Extension Broker** 插件。
>
> 核心原则：
>
> 1. **任意已有 DSH Tool Plugin 零代码改造**，只要原本会触发 DSH Approval，即可获得短期 Lease、复用、过期、撤销与审计能力。
> 2. 对遵循本项目标准开发的 **Managed Extension / Capability Extension**，进一步提供 `Capability Broker`，高权限操作不直接解析 Credential，而由 Guard 统一校验 Lease、解析 Credential、调用 Provider。
> 3. 默认主链路**不依赖 Docker、Python Runtime、Unix Domain Socket**，因此 Windows / macOS / Linux 均可使用。
> 4. 当前 Docker Capsule 代码**不得删除**，保留为 Legacy / Optional Isolated Runtime，为未来“不可信第三方代码”提供高级隔离后端。
> 5. 本项目不替代 DSH 原生 Approval、Credentials、Sandbox；本项目建立在这些能力之上。

---

# 0. AI 实现前必须理解的结论

## 0.1 当前版本已经实现了什么

现有仓库不是空项目，已有以下真实实现：

### TypeScript Adapter

当前：

```text
adapter/src/
├── index.ts
├── approval.ts
├── credentials.ts
├── rpc-client.ts
└── tool-loader.ts
```

`adapter/src/index.ts` 当前职责：

```text
DSH Plugin
   ↓
启动 PythonRuntime
   ↓
注册 host.approval.request_lease
   ↓
注册 host.credential.resolve
```

但：

```text
capsule.list_tools → ctx.tools.register()
```

仍是 TODO。

### Python Runtime

当前：

```text
runtime/dsh_capsule/
├── capsule/
├── lease/
├── broker/
├── storage/
├── rpc.py
└── main.py
```

已经实现：

- `LeaseService`
- `LeaseGateway`
- SQLite LeaseStore
- Docker CapsuleManager
- DockerBackend
- BrokerServer
- CredentialResolver
- GitHubProvider
- NDJSON RPC
- Fail-Closed 错误模型

### Capsule SDK

当前：

```text
sdk/python/dsh_capsule_sdk/
├── tool.py
└── broker.py
```

支持：

```text
CapsuleApp
@tool(...)
BrokerClient
```

### Capsule Demo

当前：

```text
capsules/
├── hello/
├── github-reader/
└── malicious-demo/
```

这些代码用于旧的 Docker Capsule 模型。

---

# 0.2 为什么要重构，而不是继续补 Docker

原版本的核心模型是：

```text
DSH
 ↓
TS Adapter
 ↓
Python Runtime
 ↓
Docker Capsule
 ↓
Broker
```

这对“不可信第三方代码”是合理的，但当前产品方向已经改变：

```text
目标 1：
对所有 DSH 已安装插件提供通用短期授权

目标 2：
对遵循 Guard 标准的高权限扩展提供 Broker

目标 3：
Windows / macOS / Linux 默认可运行
```

因此：

```text
Docker/Python Runtime
```

不应该继续成为默认主链路。

新的主链路：

```text
DeepSeek Harness
       │
       ├── 原生 Tool Pipeline
       ├── 原生 Approval
       └── 原生 Credentials
               │
               ▼
        DSH Capability Guard
               │
       ┌───────┴────────┐
       ▼                ▼
Universal Lease     Managed Broker
所有原生插件         Guard Extension
```

---

# 1. 产品定位

项目工作名继续保留：

```text
dsh-capsule
```

本次重构过程中**不要立即进行全仓库 Rename**，避免把功能重构和命名重构混在同一个 PR。

代码内部新模块统一使用：

```text
Capability Guard
Capability Service
Lease Manager
Managed Extension
```

等名称。

功能稳定后 README 可以重新定位为：

```text
DSH Guard
Capability Governance & Broker Layer for DeepSeek Harness
```

---

# 2. 目标产品形态

最终存在两种模式。

---

## 2.1 Universal Mode

适用于：

```text
任意已经安装的 DSH Plugin
```

第三方插件：

```text
无需修改代码
无需依赖本项目 SDK
无需知道 Guard 存在
```

仍然照常：

```ts
ctx.tools.register(...)
```

Guard 横切 DSH 原生 Tool Pipeline。

### 原始 DSH

```text
Agent
 ↓
Tool
 ↓
tools/pre-execute
 ↓
ASK
 ↓
User Approval
 ↓
Tool.execute()
```

### 安装 Guard 后

```text
Agent
 ↓
Tool
 ↓
tools/pre-execute
 ↓
下游策略返回 ASK
 ↓
Guard 查找 Lease
 │
 ├── 有有效 Lease → ALLOW
 │
 └── 无 Lease
        ↓
   保持 ASK
   并明确告知：
   “本次批准将签发 60 秒 Lease”
        ↓
   用户 allowed-once
        ↓
   Guard 创建 Lease
        ↓
   Tool.execute()
```

下一次：

```text
同 Session
+
同 Tool
+
同 Scope
+
Lease 未过期
```

则：

```text
ASK
 ↓
Guard 命中 Lease
 ↓
ALLOW
```

不重复打扰用户。

---

## 2.2 Managed Extension Mode

适用于：

```text
GitHub
AWS
Database
Jira
Slack
Kubernetes
```

等需要长期 Credential 或真实高权限操作的 Tool。

第三方开发者需要按照 Guard SDK 编写。

Managed Extension 不直接：

```text
ctx.credentials.resolve(...)
```

而是：

```text
ctx.capabilities.execute(...)
```

调用链：

```text
Managed Tool
      ↓
CapabilityService.execute()
      ↓
Lease Validation
      ↓
Provider Registry
      ↓
ctx.credentials.resolve()
      ↓
Provider.execute()
      ↓
External API
```

Managed Tool 只拿业务结果，不通过 Guard API 获取 Secret。

---

# 3. 与 DSH 原生机制的职责边界

必须保持以下关系。

## 3.1 DSH Approval

负责：

```text
用户是否同意当前敏感操作
```

Guard **不得替代 Approval**。

Guard 只增加：

```text
用户批准后
↓
生成一个明确 Scope + TTL 的短期 Lease
```

---

## 3.2 DSH Credentials

负责：

```text
Credential Reference
Credential Storage
Credential Resolution
Credential Rotation
```

Guard **不得自己重新存 Secret**。

Broker 只能：

```ts
await ctx.credentials.resolve(ref)
```

并且：

```text
每次 Provider Operation 重新 resolve
禁止跨 Operation 缓存 Secret
```

---

## 3.3 DSH Sandbox

默认执行环境继续交给 DSH。

Guard 不再强制：

```text
Docker
Linux Container
UDS
Python Runtime
```

旧 Docker Runtime 保留为未来：

```text
runtime.mode = isolated
```

的可选后端。

---

# 4. DSH 官方扩展点

实现必须围绕以下 DSH 原生扩展点。

## 4.1 `tools/pre-execute`

当前 DSH 的 `ToolExecution` 包含：

```ts
callId
rootCallId
name
arguments
agent
signal
```

Guard 必须使用：

```ts
ctx.on('tools/pre-execute', handler, { prepend: true })
```

`prepend: true` 的目的：

```text
让 Guard 成为外层 Middleware
↓
调用 next()
↓
获得其他 DSH Policy/Permission Plugin 的最终 PreToolDecision
```

Guard **不能自己判断某个 Tool 是否敏感**。

它只处理：

```text
下游已经决定 kind === 'ask'
```

的调用。

这样才能实现：

```text
“只增强原本就需要授权的 Tool”
```

而不是重新定义 DSH 权限体系。

---

## 4.2 `approval/request`

Guard 还必须注册：

```ts
ctx.on(
  'approval/request',
  handler,
  { prepend: true }
)
```

作用：

```text
human approval result
↓
allowed-once
↓
Guard 创建 Lease
```

注意：

DSH Approval 当前只有：

```text
allowed-once
rejected
cancelled
unavailable
```

Guard **禁止**在用户不知道的情况下：

```text
allowed-once
↓
偷偷变成 60 秒权限
```

因此 `tools/pre-execute` 在返回 Ask 时必须修改 `reason`：

```text
原始 reason
+
“DSH Guard：批准本次请求将为当前 Session
签发一个 Scope=xxx、TTL=60s 的短期 Lease；
Lease 可在到期前复用，可主动撤销。”
```

只有用户看到这个信息并返回 `allowed-once` 后，才允许创建 Lease。

---

## 4.3 `tools/result`

注册：

```ts
ctx.on('tools/result', ...)
```

用于：

```text
清理 pending call
记录最终结果
记录调用耗时
记录 Lease 是否被使用
```

不得修改结果。

---

## 4.4 Cordis Service

Guard 必须提供：

```text
ctx.capabilities
```

供 Managed Extension 使用。

实现方式使用 DSH/Cordis `Service`。

其他插件通过：

```ts
export const inject = [
  'tools',
  'capabilities'
]
```

使用。

---

# 5. Universal Mode 详细设计

---

# 5.1 关键原则

Universal Mode 必须满足：

```text
第三方插件代码零修改
```

但只承诺：

```text
短期授权
Lease
撤销
审计
```

不承诺：

```text
Secret 不进入第三方插件
第三方插件内部网络请求被 Broker 强制拦截
```

因为普通第三方插件的 `execute()` 仍由它自己实现。

README 和代码注释不得混淆这个边界。

---

# 5.2 Universal Lease 数据模型

新增：

```text
adapter/src/capability/types.ts
```

建议模型：

```ts
export type LeaseStatus =
  | 'ACTIVE'
  | 'REVOKED'
  | 'EXPIRED'

export type LeaseKind =
  | 'universal'
  | 'managed'

export interface CapabilityScope {
  kind:
    | 'exact-arguments'
    | 'fields'
    | 'tool'
    | 'managed'

  /**
   * 用于匹配的稳定 key。
   * 不允许包含 Secret 原文。
   */
  key: string

  /**
   * 给用户展示。
   * 必须经过脱敏。
   */
  display: string

  provider?: string
  resource?: string
  actions?: readonly string[]
}

export interface CapabilityLease {
  id: string
  kind: LeaseKind

  sessionId: string
  toolName: string
  scope: CapabilityScope

  issuedAt: number
  expiresAt: number

  status: LeaseStatus

  revokedAt?: number
  revokeReason?: string

  sourceCallId?: string
}
```

与旧 Python `CapabilityLease` 的对应关系：

```text
旧 capsule_instance_id
→ Universal Mode 删除

旧 provider/resource/actions
→ Managed Mode 保留

旧 session_id
→ exec.agent.id

旧 TTL
→ 保留

旧 ACTIVE/REVOKED/EXPIRED
→ 保留
```

---

# 5.3 Session ID 获取

统一：

```ts
const sessionId = exec.agent?.id
```

DSH 当前 Agent 的 `id` 就是该 Agent/Session 的 `SessionId`。

如果：

```text
exec.agent == undefined
```

则：

```text
禁止创建 Session Lease
```

处理方式：

```text
继续保持原始 ask/deny 语义
```

不得创建：

```text
global lease
anonymous lease
```

---

# 5.4 Scope Resolver

这是 Universal Mode 最重要的设计之一。

普通第三方插件没有：

```text
Provider
Resource
Action
```

语义。

Guard **禁止使用 LLM 或字符串猜测**自动推断：

```text
github_create_issue
→ provider=github
```

这种行为不可靠。

Scope 必须采用确定性规则。

---

## 5.4.1 默认规则：exact-arguments

对于没有任何 Guard 配置的 Tool：

```text
Scope =
toolName
+
canonical JSON(arguments)
```

但 Lease 中只保存：

```text
SHA-256 hash
```

例如：

```text
tool:
github_create_issue

arguments:
{
  repo: "company/backend",
  title: "bug"
}
```

canonical：

```json
{"repo":"company/backend","title":"bug"}
```

scope key：

```text
sha256(...)
```

Lease：

```text
Session S1
github_create_issue
argsHash=xxxx
TTL=60s
```

这意味着：

```text
完全相同调用
```

可以复用。

参数变化：

```text
重新 Ask
```

这是最保守、最通用的零配置策略。

---

## 5.4.2 配置规则：fields

用户可以为已有第三方 Tool 配置：

```yaml
github_create_issue:
  scope:
    mode: fields
    paths:
      - repo
  ttlSeconds: 120
```

则：

```text
repo 相同
title 可以变化
```

都复用同一个 Lease。

例：

```text
repo=company/backend
title=A
```

与：

```text
repo=company/backend
title=B
```

共享 Lease。

但：

```text
repo=company/payment
```

重新 Ask。

---

## 5.4.3 tool 模式

只允许用户显式配置：

```yaml
scope:
  mode: tool
```

代表：

```text
当前 Session
对整个 Tool
TTL 内均放行
```

这是权限最宽的模式。

禁止作为默认值。

---

## 5.4.4 Managed Mode

Managed Extension 注册语义 Capability 后：

```text
provider
resource
action
```

成为 Scope。

例如：

```text
github
repo:company/backend
issue.create
```

---

# 5.5 Canonical JSON

新增：

```text
adapter/src/capability/canonical.ts
```

必须实现稳定 JSON：

- object key 按字典序排序
- array 保持顺序
- string/number/boolean/null 正常编码
- 禁止 function/symbol/bigint
- 必须是 lossless JSON-compatible value

函数：

```ts
canonicalize(value: unknown): string
sha256Scope(value: unknown): string
```

测试必须覆盖：

```text
{a:1,b:2}
{b:2,a:1}
```

hash 必须相同。

---

# 5.6 LeaseStore

V1 不需要 SQLite。

原因：

```text
Lease 本来就是短生命周期权限
进程重启后全部失效
=
Fail Closed
```

因此第一版使用：

```text
MemoryLeaseStore
```

接口必须抽象：

```ts
export interface LeaseStore {
  insert(lease: CapabilityLease): void | Promise<void>

  findMatching(query: LeaseQuery):
    CapabilityLease | undefined
    | Promise<CapabilityLease | undefined>

  get(id: string):
    CapabilityLease | undefined
    | Promise<CapabilityLease | undefined>

  revoke(
    id: string,
    reason?: string
  ): Promise<boolean> | boolean

  revokeSession(
    sessionId: string,
    reason?: string
  ): Promise<number> | number

  list(): Promise<CapabilityLease[]> | CapabilityLease[]
}
```

这样后续可增加：

```text
DshStorageLeaseStore
SQLiteLeaseStore
JsonLeaseStore
```

而不改核心逻辑。

---

# 5.7 LeaseManager

新增：

```text
adapter/src/capability/lease-manager.ts
```

职责只允许：

```text
issue
validate
findMatching
revoke
revokeSession
list
```

禁止混入：

```text
Approval UI
Tool Hook
Credential
Provider
```

推荐 API：

```ts
class LeaseManager {
  issue(input: IssueLeaseInput): CapabilityLease

  findMatching(
    sessionId: string,
    toolName: string,
    scopeKey: string,
  ): CapabilityLease | undefined

  validate(...): CapabilityLease

  revoke(
    leaseId: string,
    reason?: string,
  ): boolean

  revokeSession(
    sessionId: string,
    reason?: string,
  ): number
}
```

---

# 5.8 过期策略

不要启动：

```text
setInterval every 1s
```

作为安全正确性的前提。

与旧 Python 实现一致：

```text
每次 find / validate
↓
比较 Date.now()
↓
过期则标记 EXPIRED
```

可以有低频 GC：

```text
每 5 分钟删除过期超过 1 小时的记录
```

但：

```text
GC 只是内存回收
不是安全机制
```

---

# 6. Universal Mode Hook 算法

新增：

```text
adapter/src/capability/universal-gate.ts
```

---

# 6.1 PendingExecution

```ts
interface PendingExecution {
  callId: string
  rootCallId: string

  sessionId: string
  toolName: string

  scope: CapabilityScope
  ttlSeconds: number

  startedAt: number

  leaseId?: string

  decision:
    | 'PENDING'
    | 'LEASE_REUSED'
    | 'ASKED'
    | 'APPROVED'
    | 'REJECTED'
}
```

维护：

```ts
Map<ToolCallId, PendingExecution>
```

不同 Tool 并行执行时绝不能使用：

```text
currentSession
currentTool
```

这正是旧 Python `BrokerServer._session_id/_tool_name`
必须使用 per-instance Lock 的原因。

新版本直接通过：

```text
callId
```

关联，每个调用上下文天然 request-scoped。

---

# 6.2 `tools/pre-execute` 算法

伪代码：

```ts
ctx.on(
  'tools/pre-execute',

  async (exec, next) => {
    // 1. 首先调用下游原生 DSH Policy
    const downstream = await next()

    // 2. Guard 永远不能覆盖 deny
    if (downstream.kind === 'deny') {
      return downstream
    }

    // 3. DSH 本来 allow 的 Tool
    // Guard 不强制制造新的 Approval
    if (downstream.kind === 'allow') {
      return downstream
    }

    // 4. 只有原本为 ASK 的调用才进入 Guard
    if (downstream.kind !== 'ask') {
      return downstream
    }

    // 5. 没有 agent/session，不创建 Lease
    if (!exec.agent) {
      return downstream
    }

    const policy = policyResolver.resolve(exec)
    const scope = scopeResolver.resolve(exec, policy)

    const lease = leaseManager.findMatching(
      exec.agent.id,
      exec.name,
      scope.key,
    )

    // 6. 有 Lease：把 ASK 转换为 ALLOW
    // 后面的 monotonic guard 仍然可以 DENY
    if (lease) {
      pending.set(exec.callId, {
        ...
        leaseId: lease.id,
        decision: 'LEASE_REUSED'
      })

      audit.record(...)
      return { kind: 'allow' }
    }

    // 7. 无 Lease：保存上下文
    pending.set(exec.callId, {
      ...
      decision: 'ASKED'
    })

    // 8. 明确告诉用户批准会创建 Lease
    return {
      kind: 'ask',
      reason: appendGuardReason(
        downstream.reason,
        scope,
        policy.ttlSeconds,
      )
    }
  },

  { prepend: true }
)
```

重要：

```text
Guard 返回 ALLOW
```

之后 DSH 的：

```text
monotonic guards
```

仍可 Deny。

因此 Guard 不得绕过 DSH 最终硬策略。

---

# 6.3 `approval/request` 算法

伪代码：

```ts
ctx.on(
  'approval/request',

  async (req, next) => {
    // 非 Tool Approval
    if (!req.callId) {
      return next()
    }

    const pendingExec =
      pending.get(req.callId)

    // 不是 Guard 管理的 ASK
    if (!pendingExec) {
      return next()
    }

    // 交给真正的 DSH human/machine answerer
    const outcome = await next()

    if (outcome === 'allowed-once') {
      const lease = leaseManager.issue({
        sessionId: pendingExec.sessionId,
        toolName: pendingExec.toolName,
        scope: pendingExec.scope,
        ttlSeconds: pendingExec.ttlSeconds,
        sourceCallId: req.callId,
      })

      pendingExec.leaseId = lease.id
      pendingExec.decision = 'APPROVED'

      audit.recordLeaseIssued(...)
    } else {
      pendingExec.decision = 'REJECTED'
      audit.recordApprovalRejected(...)
    }

    return outcome
  },

  { prepend: true }
)
```

注意：

DSH 的：

```text
approval policy = never
```

是在 ApprovalService 内部、answerer waterfall 前处理。

Guard 不能也不得绕过：

```text
never
```

---

# 6.4 `tools/result`

```ts
ctx.on(
  'tools/result',

  (exec, result) => {
    const current = pending.get(exec.callId)

    audit.recordInvocation({
      ...
      result: result.isError
        ? 'ERROR'
        : 'SUCCESS'
    })

    pending.delete(exec.callId)
  }
)
```

---

# 6.5 Pending Cleanup

还需要：

```text
AbortSignal
```

监听。

如果：

```text
exec.signal aborted
```

删除 pending。

增加：

```text
MAX_PENDING_AGE_MS = 10 min
```

作为兜底 GC。

不能让：

```text
异常中断的 callId
```

永久留在内存。

---

# 7. Universal Policy

新增：

```text
adapter/src/capability/policy.ts
```

建议配置：

```ts
export interface UniversalPolicyConfig {
  enabled: boolean

  defaultTtlSeconds: number
  maxTtlSeconds: number

  defaultScope:
    | 'exact-arguments'

  rules: ToolLeaseRule[]
}
```

规则：

```ts
export interface ToolLeaseRule {
  match: string

  enabled?: boolean

  ttlSeconds?: number

  scope?:
    | {
        mode: 'exact-arguments'
      }
    | {
        mode: 'fields'
        paths: string[]
      }
    | {
        mode: 'tool'
      }
}
```

V1：

```text
match
```

可以先只支持：

```text
精确 Tool Name
```

V1.1 再支持：

```text
glob
regex
```

避免一次做太复杂。

---

# 7.1 默认 TTL

Universal Mode 建议：

```text
default = 60 seconds
max = 1800 seconds
```

原因：

```text
普通第三方 Tool 的语义我们并不完全理解
```

所以默认必须短。

Managed Extension 可以显式声明更长 TTL。

---

# 8. Revocation

必须提供编程 API：

```ts
ctx.capabilities.revoke(leaseId)
ctx.capabilities.revokeSession(sessionId)
ctx.capabilities.listLeases()
```

V1 先不做完整 Web UI。

可以先提供：

```text
CLI / debug command / service method
```

当：

```text
Session disposed
```

时：

```text
自动 revokeSession(sessionId)
```

如果 DSH 当前版本提供 `session/disposed` Cordis Event，则监听。

如果版本 API 不一致：

```text
不要猜
```

以当前安装版本 TypeScript 定义为准。

即使没有自动事件：

```text
Lease TTL
```

仍能保证最终失效。

---

# 9. Audit 模型

新增：

```text
adapter/src/audit/
├── types.ts
└── audit-service.ts
```

第一版内存 Ring Buffer 即可。

数据：

```ts
interface ToolAuditEvent {
  id: string
  timestamp: number

  sessionId?: string

  callId: string
  rootCallId: string

  toolName: string

  scopeKey?: string
  scopeDisplay?: string

  leaseId?: string

  decision:
    | 'PASSTHROUGH_ALLOW'
    | 'PASSTHROUGH_DENY'
    | 'ASK'
    | 'LEASE_REUSED'
    | 'LEASE_ISSUED'
    | 'APPROVAL_REJECTED'
    | 'TOOL_SUCCESS'
    | 'TOOL_ERROR'
}
```

禁止默认记录：

```text
完整 Tool Arguments
Credential
Authorization Header
Token
Cookie
Password
```

Args 仅：

```text
scope hash
+
脱敏后的 scope display
```

---

# 10. Managed Extension / Broker Mode

这是 V2。

---

# 10.1 CapabilityService

新增：

```text
adapter/src/service/capability-service.ts
```

使用 Cordis：

```ts
class CapabilityService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'capabilities')
  }
}
```

并声明 Context 类型扩展：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilities: CapabilityService
  }
}
```

---

# 10.2 对 Managed Extension 暴露的 API

建议：

```ts
interface ManagedCapabilityDefinition {
  toolName: string

  provider: string

  action: string

  resource:
    (args: unknown) => string

  ttlSeconds?: number
}

interface BrokerOperation {
  provider: string
  resource: string
  action: string
  input: JsonValue
}

class CapabilityService {
  register(
    definition: ManagedCapabilityDefinition
  ): () => void

  execute(
    run: ToolRunContext,
    operation: BrokerOperation
  ): Promise<JsonValue>

  revoke(
    leaseId: string,
    reason?: string
  ): boolean

  revokeSession(
    sessionId: string
  ): number

  listLeases(): readonly CapabilityLease[]
}
```

---

# 10.3 为什么 `execute()` 必须传 ToolRunContext

禁止：

```ts
ctx.capabilities.execute({
  sessionId: 'xxx'
})
```

由 Extension 自己传 Session ID。

因为：

```text
Extension 不应该自己声明身份
```

必须从 DSH Tool Runtime 产生的：

```text
ToolRunContext
```

取：

```text
run.agent.id
run.callId
run.name
run.arguments
run.signal
```

这样：

```text
身份来自可信 Runtime
```

而不是 Tool 自报。

---

# 10.4 Managed Capability 注册

例：

```ts
ctx.capabilities.register({
  toolName: 'github_create_issue',

  provider: 'github',

  action: 'issue.create',

  resource: args =>
    `repo:${args.repo}`,

  ttlSeconds: 120,
})
```

Universal Gate 在：

```text
tools/pre-execute
```

看到：

```text
github_create_issue
```

时优先使用该定义生成：

```text
provider=github
resource=repo:company/backend
action=issue.create
```

作为 Scope。

这样：

```text
Approval
↓
Lease
↓
Broker
```

使用完全一致的语义。

---

# 10.5 Broker 双重校验

当：

```ts
ctx.capabilities.execute(run, operation)
```

时：

1. 读取 `run.agent.id`
2. 读取 `run.name`
3. 查找该 Tool 的 ManagedCapabilityDefinition
4. 使用 `run.arguments` 重新计算 expected resource
5. 检查：

```text
operation.provider == definition.provider
operation.action == definition.action
operation.resource == expected resource
```

任意不一致：

```text
CAPABILITY_MISMATCH
```

Fail Closed。

然后：

```text
LeaseManager.validate(
  session,
  tool,
  semantic scope
)
```

只有通过才进入 Provider。

---

# 11. Provider Registry

新增：

```text
adapter/src/broker/
├── provider.ts
├── registry.ts
├── broker.ts
└── providers/
    └── github.ts
```

---

# 11.1 Provider Interface

```ts
interface ProviderAdapter {
  readonly id: string

  readonly credentialRef: string

  readonly allowedActions:
    readonly string[]

  execute(
    input: {
      credential: string
      action: string
      resource: string
      payload: JsonValue
      signal: AbortSignal
    }
  ): Promise<JsonValue>
}
```

---

# 11.2 Provider 是 Trusted Code

非常重要：

```text
Provider Adapter
```

会真正拿到 Credential。

因此：

```text
任意 Managed Extension
```

**不允许自己注册会获得 Secret 的 Provider 实现**，否则：

```text
Secret 不进入 Extension
```

这个承诺失效。

V2 第一版：

```text
Provider 由 Guard Core 内置/审核
```

例如：

```text
GitHubProvider
```

未来如果允许第三方 Provider：

必须区分：

```text
Managed Tool Extension
Trusted Provider Extension
```

README 要明确两个 Trust Tier。

---

# 11.3 Credential Resolution

Provider 执行前：

```ts
const resolved =
  await ctx.credentials.resolve(
    provider.credentialRef
  )
```

如果：

```text
undefined
```

返回：

```text
CREDENTIAL_NOT_CONFIGURED
```

不得把 Secret 放入：

```text
Error
Logger
Audit
Lease
Result Metadata
```

每次 operation：

```text
重新 resolve
```

禁止缓存。

---

# 12. GitHub Provider 迁移

现有：

```text
runtime/dsh_capsule/broker/github.py
```

可以作为逻辑参考。

不要继续从 Python RPC 调用。

重写 TypeScript：

```text
adapter/src/broker/providers/github.ts
```

V2 最小 Action：

```text
issues.read
issues.create
```

不要一次迁移所有 GitHub API。

---

# 13. Managed Extension SDK

新增 workspace：

```text
sdk/typescript/
```

package：

```text
@dsh-capsule/extension-sdk
```

第一版只提供类型和 helper。

例如：

```ts
export function registerManagedCapability(
  ctx,
  definition
) {
  return ctx.capabilities.register(definition)
}
```

不要在 SDK 中复制：

```text
Lease
Broker
Credential
```

逻辑。

这些必须只存在 Guard Core。

---

# 14. Managed GitHub Extension 示例

新增：

```text
extensions/github-demo/
```

它本身不接触 Token。

伪代码：

```ts
export const inject = [
  'tools',
  'capabilities',
]

export function apply(ctx) {
  ctx.capabilities.register({
    toolName: 'guard_github_create_issue',
    provider: 'github',
    action: 'issues.create',
    resource: args =>
      `repo:${args.repo}`,
    ttlSeconds: 120,
  })

  ctx.tools.register(
    defineTool({
      name: 'guard_github_create_issue',
      ...

      async execute(args, run) {
        return await ctx.capabilities.execute(
          run,
          {
            provider: 'github',
            resource:
              `repo:${args.repo}`,
            action: 'issues.create',
            input: {
              title: args.title,
              body: args.body,
            },
          }
        )
      },
    })
  )
}
```

Extension 不允许：

```text
inject credentials
```

作为项目标准。

注意：

没有 Docker 隔离时，这属于：

```text
Architectural Contract
```

而不是：

```text
不可绕过的 OS Security Boundary
```

文档必须如实说明。

如果未来要防恶意 Extension 绕过：

```text
再启用旧 Docker / Remote Executor
```

---

# 15. 新目录结构

目标：

```text
dsh-capsule-main/
│
├── adapter/
│   └── src/
│       ├── index.ts
│       │
│       ├── capability/
│       │   ├── types.ts
│       │   ├── canonical.ts
│       │   ├── scope-resolver.ts
│       │   ├── policy.ts
│       │   ├── lease-store.ts
│       │   ├── lease-manager.ts
│       │   ├── pending.ts
│       │   └── universal-gate.ts
│       │
│       ├── service/
│       │   └── capability-service.ts
│       │
│       ├── broker/
│       │   ├── errors.ts
│       │   ├── provider.ts
│       │   ├── registry.ts
│       │   ├── broker.ts
│       │   └── providers/
│       │       └── github.ts
│       │
│       ├── audit/
│       │   ├── types.ts
│       │   └── audit-service.ts
│       │
│       └── legacy/
│           ├── rpc-client.ts
│           ├── approval.ts
│           └── credentials.ts
│
├── sdk/
│   ├── python/                 # 旧版保留
│   └── typescript/
│
├── extensions/
│   └── github-demo/
│
├── runtime/                    # 旧 Python Runtime 保留
├── capsules/                   # 旧 Docker Demo 保留
│
└── tests/
```

注意：

旧代码：

```text
runtime/
capsules/
sdk/python/
```

本阶段禁止删除。

---

# 16. `adapter/src/index.ts` 重构

当前：

```text
spawn Python Runtime
```

改为：

```text
直接挂载 Guard Service + Hook
```

新的逻辑：

```ts
export const name = 'dsh-capability-guard'

export const inject = [
  'tools',
  'approval',
  // V2 broker 才要求 credentials
]

export function apply(ctx) {
  // register CapabilityService
  // install universal gate
  // install approval listener
  // install result observer
  // install cleanup
}
```

V1 不应该：

```text
spawn python
ping runtime
连接 Docker
```

---

# 17. 现有代码迁移表

| 当前文件 | 新版本处理 |
|---|---|
| `adapter/src/index.ts` | 重写为 Guard Plugin 入口 |
| `adapter/src/rpc-client.ts` | 移入 `legacy/`，默认不加载 |
| `adapter/src/approval.ts` | 旧 RPC Approval 逻辑移入 legacy；新 Approval 直接使用 DSH Event |
| `adapter/src/credentials.ts` | 旧 RPC Handler 移入 legacy；Broker 直接调用 `ctx.credentials` |
| `adapter/src/tool-loader.ts` | 旧 Capsule Tool Loader 移入 legacy |
| `runtime/dsh_capsule/lease/*` | 作为 TS LeaseManager 语义参考 |
| `runtime/dsh_capsule/broker/*` | 作为 TS Broker/Provider 语义参考 |
| `runtime/dsh_capsule/capsule/*` | 保留 Optional Isolated Runtime |
| `sdk/python/*` | 保留 Legacy Isolated Extension SDK |
| `capsules/*` | 保留 Docker Demo，不进入默认启动链 |
| `cli/capsulectl.py` | 暂时保留；V3 再替换成 TS Guard CLI |

---

# 18. Error Codes

V1/V2 统一：

```text
LEASE_REQUIRED
LEASE_EXPIRED
LEASE_REVOKED
LEASE_SESSION_MISMATCH
LEASE_SCOPE_MISMATCH
LEASE_NOT_FOUND

CAPABILITY_NOT_REGISTERED
CAPABILITY_MISMATCH
CAPABILITY_DENIED

PROVIDER_NOT_FOUND
ACTION_NOT_ALLOWED
CREDENTIAL_NOT_CONFIGURED
PROVIDER_TIMEOUT
PROVIDER_ERROR
```

用户可见错误不得包含：

```text
Credential Value
Authorization Header
Raw Secret
```

---

# 19. Fail-Closed 规则

以下情况必须：

```text
DENY / 不签发 Lease
```

### Universal Mode

- `agent` 缺失，无法确定 Session
- Scope Resolver 抛错
- TTL <= 0
- TTL > max
- Lease status 不合法
- Approval rejected
- Approval cancelled
- Approval unavailable

### Broker Mode

- Managed Capability 未注册
- Provider 不一致
- Resource 不一致
- Action 不一致
- Lease 缺失
- Lease 过期
- Lease 撤销
- Credential 未配置
- Provider 未注册

---

# 20. 不允许 Guard 覆盖的 DSH 决策

这是安全要求。

## 原决策为 DENY

Guard：

```text
必须 DENY
```

绝不能：

```text
Lease exists
→ ALLOW
```

---

## Monotonic Guard

即使：

```text
Guard Lease → ALLOW
```

后面的 DSH：

```text
ctx.tools.guard()
```

仍然能够 Deny。

不得绕过。

---

## Approval Policy `never`

Guard 不得：

```text
自动创建 Lease
自动批准
```

---

# 21. 默认跨平台要求

V1 默认运行路径禁止使用：

```text
docker
python
unix socket
chmod
UID/GID
/run/*
Linux capability
```

因此：

```text
Windows
macOS
Linux
```

全部只依赖：

```text
Node.js
DSH
Cordis
```

测试 CI 必须至少：

```text
ubuntu-latest
windows-latest
macos-latest
```

跑：

```text
pnpm build
pnpm test
```

旧 Docker tests：

```text
只在 Linux optional job
```

---

# 22. V1 测试清单

新增：

```text
adapter/src/capability/*.test.ts
```

必须覆盖。

---

## 22.1 原 DSH ALLOW 不受影响

```text
downstream = allow
```

结果：

```text
allow
无 Lease
无 Approval
```

---

## 22.2 原 DSH DENY 永远不能被 Lease 覆盖

即使存在有效 Lease：

```text
downstream = deny
```

仍：

```text
deny
```

---

## 22.3 ASK + 无 Lease

```text
ask
↓
reason 包含 TTL/Scope
↓
human allowed-once
↓
签发 Lease
```

---

## 22.4 ASK + rejected

不得签发 Lease。

---

## 22.5 ASK + cancelled

不得签发 Lease。

---

## 22.6 ASK + unavailable

不得签发 Lease。

---

## 22.7 Lease Reuse

第一次：

```text
allowed-once
```

第二次：

```text
相同 Session
相同 Tool
相同 Scope
TTL 内
```

Guard：

```text
ask → allow
```

不进入 human answerer。

---

## 22.8 Session Isolation

Session A Lease：

```text
Session B
```

不能复用。

---

## 22.9 Scope Isolation

exact args：

```text
args A
```

不能授权：

```text
args B
```

---

## 22.10 TTL

模拟时间：

```text
expiresAt <= now
```

必须重新 Ask。

---

## 22.11 Revoke

```text
revoke(lease)
```

下一次重新 Ask。

---

## 22.12 Parallel Calls

同时：

```text
call A
call B
```

pending 按：

```text
callId
```

隔离。

不能串 Session / Tool / Scope。

---

## 22.13 Cancellation

Approval 中取消：

```text
pending 清理
无 Lease
```

---

## 22.14 Canonical JSON

Object key 顺序不同：

```text
相同 Hash
```

---

# 23. V2 Broker 测试

必须覆盖：

1. Managed Tool 正常注册
2. 未注册 Tool 调 Broker → DENY
3. Provider mismatch → DENY
4. Resource mismatch → DENY
5. Action mismatch → DENY
6. Lease missing → DENY
7. Lease expired → DENY
8. Lease revoked → DENY
9. Credential missing → DENY
10. Provider execute success
11. Provider timeout
12. Credential 每次 operation 都重新 resolve
13. Audit/log 中不存在 Secret
14. Tool 返回值中不存在 Credential
15. 并行不同 Session Broker Call 不串上下文

---

# 24. 实现阶段

---

## Phase 0：冻结旧 Docker Runtime

目标：

```text
旧代码保留
但不进入默认启动路径
```

操作：

1. 将 `rpc-client.ts / approval.ts / credentials.ts / tool-loader.ts`
   移动到：

```text
adapter/src/legacy/
```

2. 保证旧测试仍能独立运行。
3. README 标记：

```text
Legacy Isolated Runtime
```

验收：

```text
默认 Guard Plugin 启动时不 spawn Python
```

---

## Phase 1：Universal Short-lived Authorization

实现：

```text
types
canonical
scope resolver
policy
MemoryLeaseStore
LeaseManager
PendingExecution
tools/pre-execute hook
approval/request hook
tools/result audit
```

不实现：

```text
Broker
Dashboard
Provider
Docker
```

验收：

```text
任意已有 DSH Tool
只要原本返回 ASK
在不改插件代码的情况下
获得短期 Lease
```

---

## Phase 2：Managed Capability Service

实现：

```text
ctx.capabilities
register()
semantic capability scope
execute()
```

验收：

```text
Managed Extension 可注册
Provider/Resource/Action
```

---

## Phase 3：Credential Broker

实现：

```text
ProviderRegistry
GitHubProvider
ctx.credentials per-operation resolve
Broker enforcement
```

验收：

```text
github-demo
不直接读取 Credential
可以完成 GitHub Operation
```

---

## Phase 4：Governance Console / Observability

后续实现：

```text
Plugins
Tools
Activity
Capabilities
Audit
```

这不是当前 MVP 阻塞项。

---

## Phase 5：Optional Isolated Runtime

重新接回已有：

```text
Python Runtime
Docker Capsule
```

但作为：

```text
Managed Extension optional backend
```

不是默认依赖。

---

# 25. V1 完成后的用户体验

用户已经安装：

```text
github-plugin
jira-plugin
dsh-capability-guard
```

第三方代码完全没有改。

用户：

```text
帮我调用某个原本需要 Ask 的 GitHub Tool
```

DSH 原本：

```text
ASK
```

Guard：

```text
No Lease
↓
保持 ASK
↓
Reason 显示：
“批准将生成 60 秒精确参数 Lease”
```

用户批准。

Guard：

```text
Lease ACTIVE
```

60 秒内相同 Scope 再次发生：

```text
DSH Policy → ASK
↓
Guard → Lease Hit
↓
ALLOW
```

如果：

```text
参数变化
Session 变化
Lease 过期
Lease 被撤销
```

重新 Ask。

---

# 26. V2 完成后的用户体验

用户安装：

```text
dsh-capability-guard
+
guard-github-extension
```

Extension 注册：

```text
github_create_issue
↓
github
repo:{repo}
issues.create
```

首次：

```text
ASK
↓
Lease
```

Tool 内：

```text
ctx.capabilities.execute()
```

Guard：

```text
Lease Validate
↓
ctx.credentials.resolve(GITHUB_TOKEN)
↓
GitHubProvider
↓
GitHub API
```

Tool 只得到：

```text
Issue Result
```

不通过 Capability API 获得 Token。

---

# 27. 当前版本最值得复用的代码思想

不要因为技术栈迁移就丢掉现有实现里的好设计。

必须复用以下思想：

### 来自 `LeaseService`

```text
ACTIVE / REVOKED / EXPIRED
validate 时实时判断 TTL
revokeSession
Fail Closed
```

### 来自 `LeaseGateway`

```text
有 Lease → 复用
无 Lease → Approval
Approval 后 → 签发
TTL 上限
```

### 来自 `BrokerPolicy`

```text
Provider/Action 不匹配 → 拒绝
```

### 来自 `CredentialResolver`

```text
per-operation resolve
不缓存 Secret
```

### 来自 `BrokerServer`

```text
Lease
→ Credential
→ Provider
```

新 TypeScript 版本是在：

```text
保留安全语义
```

的前提下：

```text
去掉不再必要的 Python/Docker 主链路
```

而不是重新设计一套完全不同的东西。

---

# 28. 当前版本必须修掉的旧设计假设

### 旧：

```text
Lease 必须绑定 capsule_instance_id
```

新 Universal Mode 没有 Capsule Instance。

改为：

```text
Session
× Tool
× Scope
× TTL
```

Managed Mode：

```text
Session
× Tool
× Provider
× Resource
× Action
× TTL
```

---

### 旧：

```text
BrokerServer 保存 current session/tool
+
Manager 用 asyncio.Lock 串行
```

新版本禁止这种全局/current context。

全部使用：

```text
callId
ToolRunContext
```

显式传递。

因此支持 DSH 并行 Tool Call。

---

### 旧：

```text
Secret TS → Python Runtime
```

新版本：

```text
Broker 本身在 DSH/TypeScript 可信侧
```

不再需要 RPC 传 Secret。

---

# 29. 安全声明边界

README 必须准确。

## Universal Mode 可以声明

```text
短期授权
Session Scope
Scope Binding
TTL
Revocation
Audit
Zero-code-change integration
```

不能声明：

```text
普通第三方插件看不到 Credential
普通第三方插件无法绕过 Broker
普通第三方插件网络被隔离
```

---

## Managed Broker Mode 可以声明

```text
按照 Guard SDK 编写的 Tool
不需要直接解析 Credential
Broker 统一完成 Provider Operation
```

但因为默认没有 OS Sandbox：

不能宣称：

```text
恶意 Managed Extension 绝对无法自行读环境变量/联网
```

它是：

```text
受管扩展协议
```

不是：

```text
恶意代码强隔离边界
```

如果未来需要该保证：

```text
启用旧 Container Isolated Runtime
```

---

# 30. Coding Agent 强制执行规则

将以下内容直接放入给 Coding Agent 的 Prompt。

---

## MUST

1. 必须基于当前仓库增量修改。
2. 必须先运行现有 TypeScript tests。
3. 必须读取当前安装 DSH 版本的 TypeScript 类型。
4. 必须以 DSH 当前真实：
   - `tools/pre-execute`
   - `approval/request`
   - `tools/result`
   - Cordis Service
   API 为准。
5. 必须保留旧 Python/Docker Runtime。
6. Universal V1 默认路径不得 spawn Python。
7. Universal V1 默认路径不得依赖 Docker。
8. Lease 必须绑定 Session。
9. 默认 Universal Scope 必须是 exact-arguments。
10. Lease 复用不能覆盖原始 DENY。
11. 用户必须在 Approval reason 中明确看到 TTL/Scope。
12. 只有 `allowed-once` 才能签发 Lease。
13. Credential 不得写入日志、Lease、Audit。
14. Broker 每次 Operation 必须重新 resolve Credential。
15. 并行调用必须通过 callId/request context 隔离。
16. 所有关键失败路径 Fail Closed。
17. Windows/macOS/Linux build/test 必须通过。

---

## MUST NOT

1. 不得删除 `runtime/`、`capsules/`、`sdk/python/`。
2. 不得把原 DSH `deny` 改成 allow。
3. 不得绕过 DSH `approval policy=never`。
4. 不得自动猜测未知 Tool 的 Provider/Resource/Action。
5. 不得把 Tool Name 字符串启发式当作安全边界。
6. 不得把 `allowed-once` 静默扩展成 Lease。
7. 不得默认使用 tool-level broad scope。
8. 不得缓存 Credential。
9. 不得将 Credential 暴露给 Managed Tool API。
10. 不得通过 global `currentSession/currentTool` 管理并行上下文。
11. 不得在 V1 顺手实现 Dashboard。
12. 不得在同一个 Phase 大规模 Rename 整个仓库。
13. 不得为通过测试而删除安全断言。

---

# 31. Definition of Done

## Phase 1 完成

必须证明：

```text
第三方 DSH Plugin
零源码修改
```

在：

```text
其原始 DSH Permission 返回 ASK
```

时：

```text
第一次：
Human Approval

第二次：
同 Session + 同 Scope + TTL 内
自动 Lease Reuse

过期/撤销/换 Session/换 Scope：
重新 Approval
```

并且：

```text
Windows/macOS/Linux
```

不需要 Docker。

---

## Phase 3 完成

必须证明：

```text
Managed GitHub Extension
```

只调用：

```text
ctx.capabilities.execute()
```

能够：

```text
Lease Validate
↓
Credential Resolve
↓
GitHub Provider
```

完成请求。

并且：

```text
Managed Tool API
日志
Lease
Audit
```

中均不存在真实 GitHub Token。

---

# 32. 建议第一轮让 AI 实现的内容

不要一次把整份规格全部交给 AI 然后要求：

```text
“全部实现”
```

第一轮只要求：

```text
Phase 0 + Phase 1
```

具体 Prompt：

```text
请严格按照
《DSH Capsule → DSH Capability Guard 重构技术规格》

仅实现：

Phase 0：
冻结旧 Python/Docker Runtime，不删除代码，
默认插件启动不再 spawn Python。

Phase 1：
Universal Short-lived Authorization。

要求：
1. 使用 DSH tools/pre-execute waterfall。
2. 使用 prepend outer middleware。
3. 只处理下游返回 ASK 的 Tool。
4. 使用 DSH approval/request 捕获 allowed-once。
5. Approval reason 必须明确说明 Lease TTL 和 Scope。
6. 默认 exact-arguments scope。
7. 使用 in-memory LeaseStore。
8. 支持 TTL、Session 隔离、Revoke。
9. 使用 callId 管理并行上下文。
10. tools/result 做 cleanup/audit。
11. 不实现 Broker。
12. 不实现 Dashboard。
13. 不删除旧 Docker/Python 代码。
14. 补全所有规格要求的单元测试。
15. 在修改前先核对当前 DSH TypeScript API，禁止凭猜测写接口。
```

Phase 1 验收通过后，再交第二轮：

```text
Phase 2 + Phase 3
```

这样最稳。

---

# 33. 面试层面的最终技术叙事

实现完成后，项目可以这样解释：

```text
DSH 原生 Approval 是 one-shot，
对于频繁调用敏感 Tool 的 Agent Workflow，
要么每次确认，
要么放宽长期权限。
```

本项目增加：

```text
Approval
↓
Short-lived Scoped Capability Lease
↓
Reuse / Expire / Revoke / Audit
```

同时：

```text
所有已有 DSH Plugin
零改造获得 Universal Lease
```

对于高权限 Managed Extension：

```text
Tool
↓
Capability Broker
↓
DSH Credential
↓
Provider
```

从而形成：

```text
Universal Governance
+
Deep Broker Integration
```

两级模型。

一句话：

> **对现有 DSH 插件提供零侵入的短期能力治理；对遵循 Guard 协议的高权限扩展进一步提供 Brokered Capability Execution。**

---

# 34. 官方 API 校验基线（2026-09-14）

Coding Agent 在实际编码前仍必须核对当前安装版本；截至本规格编写时，官方 master 文档/源码确认：

1. `tools/pre-execute` 是 waterfall，可返回 `allow / deny / ask`。
2. `ToolExecution` 包含 `callId / rootCallId / name / arguments / agent / signal`。
3. `tools/result` 是执行完成后的只读观察事件。
4. `ctx.tools.guard()` 是 monotonic deny-only guard，Guard Plugin 不应绕过。
5. `ctx.approval.request()` 返回闭合结果：
   `allowed-once / rejected / cancelled / unavailable`。
6. `approval/request` 是 waterfall。
7. Approval Request 包含 `agent / toolName / callId / reason / signal`，但不复制 arguments。
8. `Agent.id` 是该 Agent/Session 的 `SessionId`。
9. Cordis `ctx.on()` 支持 `prepend`。
10. Cordis Plugin 可以通过 `Service` 向其他 Plugin 暴露新服务。
11. `ctx.credentials.resolve(ref)` 返回 `{ value, source } | undefined`，并要求 consumer 每个 operation 重新解析、不跨 operation 缓存。

如果实际安装版本与以上任何接口不同：

```text
停止硬编码
↓
以安装版本类型定义修正规格适配层
```

但：

```text
Universal Lease 的安全语义
Managed Broker 的边界
```

不得因为 API 差异而弱化。
