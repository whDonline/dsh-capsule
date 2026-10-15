# DSH Capsule：第三方插件隔离执行与短期可撤销授权技术规格（MVP）

> 文档用途：本文件是一份可直接交给 AI 编程助手执行的技术规格。实现者应严格按本文范围开发，不自行扩大目标。
>
> 目标版本：MVP / V0.1～V0.4
>
> 推荐项目名：`dsh-capsule`
>
> 一句话定位：**为 DeepSeek Harness 的第三方工具能力提供“隔离执行 + 短期可撤销授权”，使不可信插件无需接触宿主环境和长期凭证，也能安全地为 Agent 提供外部工具。**

---

# 1. 先用小白能懂的话解释：我们到底在做什么？

DeepSeek Harness（下文简称 DSH）可以安装插件。插件可以给 Agent 增加新工具，例如：

- GitHub 工具；
- 云盘工具；
- 浏览器工具；
- 数据库工具；
- 各种第三方 API 工具。

问题在于：**插件本身是一段真正会运行的代码。**

如果我们安装了一个不可信插件，它不仅可能“提供一个工具”，还可能尝试做额外的事情，例如：

```text
读取 ~/.ssh/id_rsa
读取宿主机环境变量
读取 DSH 的 API Key
访问任意公网地址
启动额外进程
修改宿主文件
```

DSH 已经有 Sandbox、Approval、Credentials 等安全底座，但这些能力主要保护的是 Agent 的工具调用和文件/命令执行，并不等价于“第三方插件代码本身被真正隔离”。DSH 官方安全说明也明确指出，Sandbox、审批和权限控制只能降低风险，并不能保证真正隔离；对于不可信 workload，应优先使用容器、虚拟机或专用环境。

因此本项目解决两个核心问题：

## 问题 A：第三方插件和宿主 DSH 权限离得太近

我们希望把第三方插件放进一个独立 Docker 容器中：

```text
DSH Host
   │
   │ 只运行可信 Adapter
   ↓
Python Capsule Runtime
   │
   ↓
Docker Container
   │
   └── 第三方插件代码
```

容器默认：

- 看不到宿主文件；
- 看不到宿主环境变量；
- 没有公网网络；
- 没有 Docker Socket；
- 非 root；
- 只读根文件系统；
- 有 CPU、内存、进程数限制。

这样，即使插件代码有问题，也不会直接等价于“宿主 DSH 被攻破”。

## 问题 B：插件要访问 GitHub 等服务时，不能把长期 Token 直接交给它

例如宿主保存：

```text
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxx
```

传统插件可能直接拿到这个 Token，然后自己请求 GitHub。

本项目不允许这样做。

插件只能说：

```text
我需要读取 repo/foo 的 Issue
```

宿主侧 Broker 判断：

```text
这个插件是谁？
当前是哪个 DSH Session？
用户是否允许？
这个授权过期了吗？
允许 read 还是 write？
允许访问哪个 repo？
```

只有检查全部通过，**Broker 自己使用真正的 GITHUB_TOKEN 调 GitHub**，然后把结果返回给容器。

第三方插件始终看不到真正 Token。

这就是本项目的核心思想：

> **插件有能力，但没有宿主权限；插件能访问外部服务，但没有长期凭证。**

---

# 2. 项目定位

## 2.1 项目名称

推荐：

```text
DSH Capsule
```

副标题：

```text
Isolated Plugin Runtime with Revocable Capability Leases for DeepSeek Harness
```

中文：

```text
DeepSeek Harness 第三方插件隔离运行与短期授权运行时
```

## 2.2 这不是一个什么项目

本项目 **不是**：

- 一个杀毒软件；
- 一个插件静态扫描器；
- 一个 Docker 管理面板；
- 一个完整 Zero Trust 平台；
- 一个 Credential Manager；
- 一个通用 API Gateway；
- 一个新的 Agent Framework；
- DSH 的 Fork；
- 用 Docker 重写全部 DSH 插件系统。

## 2.3 这是什么项目

本项目是 DSH 的一个可信 Host 插件，它提供一个新的“安全第三方工具运行时”：

```text
Agent
 ↓
DSH Tool Registry
 ↓
DSH Capsule Adapter（可信）
 ↓
Python Capsule Runtime（可信）
 ↓
隔离 Docker Capsule（不可信）
 ↓
Credential/Capability Broker（可信）
 ↓
External API
```

项目只解决两个问题：

1. **第三方 Tool Plugin 隔离执行**；
2. **第三方 Tool Plugin 使用短期、可撤销、最小权限的 Capability Lease 访问外部能力。**

---

# 3. 为什么这个问题真实存在？

截至 2026-09-02，DSH 官方安全文档明确说明：DSH 可以运行模型生成代码、加载第三方插件，并访问配置给它的网络、进程、凭据与文件；不可信插件可能导致宿主文件、数据或凭据受损。官方同时强调现有 Sandbox/Approval/Permission 不能保证真正隔离。

DSH 当前 Process Sandbox 的核心模式主要约束“文件系统写入效果”，官方文档明确指出网络访问与进程可见性并没有因此形成通用安全边界。

DSH 当前 workflow worker thread 也明确声明：Worker Thread 用来防止脚本阻塞主 event loop，但**不是 security sandbox**。即使 `node:vm` 放在 Worker 中，也只是 API 形状约束，不是防恶意代码的安全边界。

另外，DSH 社区已经有人公开讨论第三方插件与 DSH Host 共享核心进程和安全服务的信任边界问题，也有人反馈单个插件加载失败可能影响整个插件树，并提出 per-plugin isolation 的需求。

因此本项目不是为了简历硬造一个“安全概念”，而是针对 DSH 插件生态中一个明确存在的 Trust Boundary 问题做工程化补充。

---

# 4. DSH 已经有什么？我们为什么不重复造轮子？

## 4.1 DSH 已有 Approval

DSH 的 `ctx.approval` 解决的是：

```text
“这一次具体动作，允许还是拒绝？”
```

它是 one-shot 的：

```text
allowed-once
rejected
cancelled
unavailable
```

它非常适合作为我们签发 Lease 前的人类确认入口。

我们不重写 Approval。

## 4.2 DSH 已有 Credentials

DSH 的 `ctx.credentials` 已经实现：

```text
配置里只保存 CredentialRef
真实 Secret 由 Credential Provider 持有
消费者每次 operation 重新 resolve
```

因此 Secret 轮换后，不需要重启插件，下一个 operation 就能使用新值。

我们不重写 Credential Store。

我们的改进是：

```text
原有模式：
Third-party Plugin
    ↓
ctx.credentials.resolve()
    ↓
真实 Secret 进入 Plugin

本项目：
Third-party Capsule
    ↓
Broker Request
    ↓
Trusted Broker
    ↓
ctx.credentials.resolve()
    ↓
Broker 使用 Secret 发请求
    ↓
只把结果返回 Capsule
```

**核心变化：真实 Secret 不再穿过第三方插件信任边界。**

## 4.3 DSH 已有 Sandbox

现有 Sandbox 继续负责 DSH 原有 Tool/Bash/FS 的权限策略。

本项目解决的是不同问题：

```text
DSH Sandbox：
Agent 执行 Bash/FS 时怎么限制？

DSH Capsule：
第三方插件代码本身放在哪里运行？
```

两者不冲突。

---

# 5. MVP 范围必须写死

## 5.1 第一版必须支持

只支持：

- Linux；
- Docker Engine；
- 一个 DSH Host Plugin；
- 一个 Python Runtime；
- 一种自定义 Capsule Plugin 协议；
- GitHub Reader Demo Capsule；
- Capability Lease；
- TTL；
- Manual Revoke；
- Session Binding；
- Docker 隔离；
- DSH Approval 集成；
- DSH Credentials 集成。

## 5.2 第一版明确不支持

**禁止实现以下功能，除非 MVP 全部验收完成：**

- 任意现有 Cordis Plugin 无修改隔离；
- 任意 npm 插件自动搬进 Docker；
- 插件签名；
- Sigstore；
- SBOM；
- 完整 Capability Manifest 审计；
- 通用 HTTP Proxy；
- 通用任意域名网络访问；
- Windows 容器；
- macOS 容器兼容；
- Kubernetes；
- Firecracker/microVM；
- eBPF；
- seccomp 自定义规则生成；
- 完整审计平台；
- Web 管理后台；
- 多租户；
- SaaS。

如果实现 AI 开始加入上述功能，应立即停止并回到本规格。

---

# 6. 一个非常重要的边界：不兼容“任意现有 DSH 插件”

DSH 普通 Cordis 插件默认可以直接使用：

```text
ctx.tools
ctx.credentials
ctx.settings
ctx.fs
ctx.approval
ctx.xxx
```

如果把它原封不动丢进 Docker，这些同进程 Context Service 都不存在。

如果为了兼容任意插件而远程代理整个 Cordis Context，项目复杂度会非常高。

所以 MVP 不做这一点。

MVP 定义一种新的插件类型：

```text
Capsule Tool Plugin
```

它是一种“为 DSH 提供 Tool 的隔离插件”，而不是完整 Cordis Plugin。

用户安装的是：

```text
dsh-capsule     ← 真正 DSH 插件
```

然后 `dsh-capsule` 可以加载多个：

```text
Capsule A
Capsule B
Capsule C
```

它们全部运行在 DSH Host 进程之外。

---

# 7. 总体架构

```text
┌─────────────────────────────────────────────┐
│            DeepSeek Harness Host            │
│                                             │
│  Agent                                      │
│    ↓                                        │
│  ctx.tools                                  │
│    ↓                                        │
│  dsh-capsule-adapter (TypeScript)           │
│    │                                        │
│    ├── 注册 Capsule Tools                   │
│    ├── 获取 ToolExecution / Agent / Session │
│    ├── 调用 ctx.approval                    │
│    └── 调用 ctx.credentials                 │
└──────────────────┬──────────────────────────┘
                   │
          Bidirectional NDJSON RPC
                   │
┌──────────────────▼──────────────────────────┐
│         Python Capsule Runtime              │
│                                             │
│  CapsuleManager                             │
│  DockerBackend                              │
│  LeaseService                               │
│  CredentialBroker                          │
│  ProviderRegistry                           │
│  SQLite                                     │
└───────────────┬─────────────────┬───────────┘
                │                 │
        Unix Domain Socket        │ resolve credential
                │                 │ / approval callback
                │                 │
┌───────────────▼─────────────┐   │
│     Isolated Container      │   │
│                             │   │
│  github-reader capsule      │   │
│                             │   │
│  network = none             │   │
│  no host credentials        │   │
│  no host filesystem         │   │
│  read-only rootfs           │   │
└───────────────┬─────────────┘   │
                │ broker.sock     │
                ▼                 │
        Credential Broker ────────┘
                │
                ▼
          GitHub REST API
```

---

# 8. 为什么 TypeScript 不能完全不要？

DSH 原生插件基于 Cordis/TypeScript。

因此最合理的设计是：

```text
Thin TypeScript Adapter
+
Python Core
```

TypeScript 只负责“贴着 DSH 的部分”：

- 插件生命周期；
- `ctx.tools.register()`；
- 获取当前 ToolExecution；
- 调用 `ctx.approval`；
- 调用 `ctx.credentials`；
- 把请求转给 Python。

真正的大部分逻辑放 Python：

- Docker 管理；
- Capsule 生命周期；
- Lease；
- Broker；
- SQLite；
- GitHub Provider；
- UDS RPC；
- 安全检查；
- 资源限制；
- 测试。

因此这是一个**以 Python 为主体、TypeScript 为 DSH 适配层**的项目。

---

# 9. 推荐技术栈

## TypeScript Adapter

- TypeScript；
- 当前 DSH/Cordis 版本；
- `@deepseek-ai/dsh-tools`；
- DSH `ctx.approval`；
- DSH `ctx.credentials`；
- Node `child_process.spawn`；
- NDJSON RPC。

## Python Runtime

推荐 Python 3.11+。

依赖：

```text
pydantic
pyyaml
docker
httpx
aiosqlite
```

MVP 不需要：

```text
FastAPI
Redis
PostgreSQL
Celery
Kafka
```

原因：Runtime 是本地 daemon，不是 Web SaaS。

---

# 10. 目录结构

实现 AI 应优先创建以下结构：

```text
dsh-capsule/
│
├── package.json
├── pnpm-workspace.yaml
├── README.md
│
├── adapter/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── rpc-client.ts
│       ├── tool-loader.ts
│       ├── approval.ts
│       └── credentials.ts
│
├── runtime/
│   ├── pyproject.toml
│   └── dsh_capsule/
│       ├── __init__.py
│       ├── main.py
│       ├── rpc.py
│       │
│       ├── capsule/
│       │   ├── manager.py
│       │   ├── manifest.py
│       │   ├── instance.py
│       │   └── docker_backend.py
│       │
│       ├── lease/
│       │   ├── models.py
│       │   ├── repository.py
│       │   └── service.py
│       │
│       ├── broker/
│       │   ├── server.py
│       │   ├── policy.py
│       │   └── providers/
│       │       ├── base.py
│       │       └── github.py
│       │
│       ├── storage/
│       │   └── sqlite.py
│       │
│       └── security/
│           ├── limits.py
│           └── redaction.py
│
├── sdk/
│   └── python/
│       └── dsh_capsule_sdk/
│           ├── client.py
│           ├── broker.py
│           └── tool.py
│
├── capsules/
│   ├── github-reader/
│   │   ├── capsule.yaml
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── app.py
│   │
│   └── malicious-demo/
│       ├── capsule.yaml
│       ├── Dockerfile
│       └── app.py
│
├── cli/
│   └── capsulectl.py
│
└── tests/
    ├── unit/
    ├── integration/
    └── security/
```

---

# 11. Capsule Manifest

每一个隔离插件必须有：

```text
capsule.yaml
```

MVP 示例：

```yaml
apiVersion: dsh-capsule/v1
kind: Capsule

metadata:
  id: github-reader
  version: 0.1.0
  description: Read GitHub issues through the DSH credential broker.

runtime:
  image: dsh-capsule/github-reader:0.1.0
  command:
    - python
    - /app/app.py

resources:
  memory_mb: 256
  cpus: 0.5
  pids: 64

credentials:
  - provider: github
    credential_ref: GITHUB_TOKEN
    allowed_actions:
      - issues.read
    default_ttl_seconds: 600
    max_ttl_seconds: 1800

tools:
  - name: github_get_issue
    description: Read one GitHub issue from a repository.
    parameters:
      type: object
      additionalProperties: false
      required:
        - repo
        - issue_number
      properties:
        repo:
          type: string
          description: owner/repo
        issue_number:
          type: integer
          minimum: 1
```

注意：

`credential_ref` 只是告诉可信 Host：

```text
需要从 ctx.credentials 解析哪个 CredentialRef
```

**绝对不能把真实 credential 写入 manifest。**

---

# 12. Capsule Docker 隔离策略

创建容器时必须使用以下原则。

等价 Docker 参数：

```text
--read-only
--network none
--cap-drop ALL
--security-opt no-new-privileges
--memory 256m
--pids-limit 64
--cpus 0.5
--tmpfs /tmp:rw,noexec,nosuid,size=64m
```

另外：

- 非 root 用户运行；
- 不 mount `/home`；
- 不 mount DSH workspace；
- 不 mount `~/.dsh`；
- 不 mount Docker Socket；
- 不使用 host network；
- 不使用 privileged；
- 不使用 host PID namespace；
- 不把宿主环境变量批量传入；
- 只注入必要的非敏感运行变量。

Python `docker-py` 创建容器时，应显式设置这些参数，而不是依赖默认值。

## 12.1 容器允许看到什么？

只允许：

```text
/app                Capsule 自己的代码
/tmp                临时目录
/run/capsule/        当前 Capsule 的 IPC 目录
```

## 12.2 容器不允许看到什么？

```text
宿主 $HOME
宿主 workspace
~/.ssh
~/.dsh
宿主 API Key
Docker Socket
其他 Capsule IPC
```

---

# 13. IPC 设计

本项目有两层 IPC。

## 13.1 TypeScript ↔ Python

使用：

```text
Bidirectional NDJSON JSON-RPC over stdin/stdout
```

原因：

- 不需要开端口；
- 不依赖 Web Server；
- 容易让 TS 启动/停止 Python；
- stdout 可以作为严格协议通道；
- Python 日志全部写 stderr。

请求：

```json
{"jsonrpc":"2.0","id":"1","method":"capsule.list_tools","params":{}}
```

返回：

```json
{"jsonrpc":"2.0","id":"1","result":[...]}
```

必须支持**双向 RPC**。

Python 可以反过来请求 TS：

```json
{
  "jsonrpc":"2.0",
  "id":"py-10",
  "method":"host.credential.resolve",
  "params":{"ref":"GITHUB_TOKEN"}
}
```

或者：

```json
{
  "jsonrpc":"2.0",
  "id":"py-11",
  "method":"host.approval.request_lease",
  "params":{...}
}
```

TS 返回结果。

## 13.2 Python ↔ Capsule Container

使用 Unix Domain Socket。

每个 Capsule 实例独享：

```text
/run/dsh-capsule/<instance-id>/
```

其中：

```text
plugin.sock   Host → Capsule tool invocation
broker.sock   Capsule → Host Broker
```

这个目录只 bind mount 到当前 Capsule。

禁止所有 Capsule 共用同一个可互访目录。

---

# 14. Tool 注册机制

DSH 官方 `ctx.tools.register()` 可以动态注册 Tool，MCP Tool 也是通过这个机制进入 Tool Registry。

启动时：

```text
DSH Adapter
 ↓
Python: capsule.list_tools
 ↓
读取每个 capsule.yaml
 ↓
返回 Tool Schema
 ↓
Adapter 调 ctx.tools.register()
```

DSH 模型看到的是正常工具：

```text
github_get_issue
```

模型不应该看到：

```text
lease_id
credential_ref
broker socket
container_id
```

这些全部属于内部实现。

Tool `execute()`：

```text
Model Tool Call
 ↓
Adapter execute(args, exec)
 ↓
提取 callId / Agent / Session Identity
 ↓
RPC → Python capsule.invoke
 ↓
Python → Container plugin.sock
 ↓
Capsule 执行
 ↓
需要外部 API → broker.sock
 ↓
Broker → Lease 检查
 ↓
Host Approval / Credential Resolve
 ↓
Provider Request
 ↓
Result
 ↓
Capsule
 ↓
Python
 ↓
Adapter
 ↓
DSH Tool Result
```

---

# 15. Capability Lease 到底是什么？

这是本项目最重要的概念。

Lease 不是一定等于“第三方服务真的签发了一个临时 Token”。

MVP 使用的是：

```text
Host-side Authorization Lease
```

例如：

```text
Lease ID: L001
Capsule: github-reader
Session: S100
Provider: github
Resource: repo:foo/bar
Actions: issues.read
Expires: 10 minutes later
Status: ACTIVE
```

这个 Lease 表示：

> 在有效期内，`github-reader` 这个隔离实例，只能代表当前 Session，对 `foo/bar` 做 `issues.read`。

真正 GitHub Token 仍然由 Host 保管。

## 15.1 为什么不直接把临时 Token 放进容器？

因为只要 Token 进入容器：

```text
恶意插件
 ↓
print(token)
 ↓
外泄
```

所以 MVP 更安全的方案是：

```text
插件只提交 Broker Request
Broker 自己拿 Secret 请求 GitHub
```

## 15.2 未来扩展

如果某 Provider 原生支持真正的 scoped short-lived token，例如 STS/OAuth token exchange，则未来可以增加：

```text
Native Ephemeral Credential Mode
```

但这不是 MVP。

---

# 16. Lease 数据模型

SQLite 表：

```sql
CREATE TABLE leases (
    id TEXT PRIMARY KEY,
    capsule_id TEXT NOT NULL,
    capsule_instance_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    resource TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    revoked_at INTEGER,
    revoke_reason TEXT
);
```

状态只允许：

```text
ACTIVE
REVOKED
EXPIRED
```

Python Model：

```python
class CapabilityLease(BaseModel):
    id: str
    capsule_id: str
    capsule_instance_id: str
    session_id: str
    provider: str
    resource: str
    actions: set[str]
    issued_at: datetime
    expires_at: datetime
    status: Literal["ACTIVE", "REVOKED", "EXPIRED"]
```

---

# 17. Lease 必须满足的安全规则

一次 Broker 请求只有同时满足以下条件才能放行：

```text
Lease exists
AND status == ACTIVE
AND now < expires_at
AND lease.capsule_instance_id == caller_instance
AND lease.session_id == current_session
AND lease.provider == requested_provider
AND requested_action in lease.actions
AND requested_resource matches lease.resource
```

任意条件失败：

```text
DENY
```

不能“尽量执行”。

安全系统必须 Fail Closed。

---

# 18. Lease 签发流程

第一次调用：

```text
用户：
“查看 foo/bar 的 Issue #10”

Agent
 ↓
github_get_issue(repo="foo/bar", issue_number=10)
 ↓
Capsule 请求：
provider=github
action=issues.read
resource=repo:foo/bar
 ↓
Broker 查 Lease
 ↓
没有 Lease
 ↓
Python → TS：host.approval.request_lease
 ↓
DSH ctx.approval
 ↓
用户看到：

github-reader 请求：
- Provider: GitHub
- Resource: foo/bar
- Permission: issues.read
- Duration: 10 minutes

允许？
 ↓
allowed-once
 ↓
Python 创建 Lease
 ↓
继续执行 GitHub Request
```

这里 DSH 的 one-shot approval 不是“10 分钟里每个 GitHub 请求都逐个批准”。

它批准的是：

> **签发这一张明确 Scope、明确 TTL 的 Lease。**

---

# 19. Lease 复用

10 分钟内，同一：

```text
Capsule Instance
+
Session
+
Provider
+
Resource
+
Action
```

再次调用时：

```text
查到 ACTIVE Lease
 ↓
不再弹 Approval
 ↓
直接走 Broker
```

不能跨 Session 复用。

Session A 的 Lease：

```text
S100
```

Session B 即使调用同一个工具，也必须重新授权。

---

# 20. Revoke

至少实现：

```text
capsulectl leases
capsulectl revoke <lease-id>
capsulectl revoke-session <session-id>
capsulectl revoke-capsule <capsule-id>
```

撤销后：

```text
status = REVOKED
```

下一次调用立即返回：

```text
LEASE_REVOKED
```

绝对不能等到 DSH 重启才生效。

---

# 21. TTL / Expiration

每次 Broker 校验时都检查：

```python
if now >= expires_at:
    mark_expired()
    deny()
```

不要依赖后台定时任务才能过期。

后台 cleanup 只负责清理数据库，不负责安全正确性。

换句话说：

```text
即使 cleanup thread 死了，过期 Lease 也必须不能使用。
```

---

# 22. Credential Broker

Broker 不允许实现：

```text
generic_http_request(url, headers, body)
```

否则恶意插件可以借 Broker 访问任意网络，整个隔离设计失去意义。

必须实现**Provider + Action Allowlist**。

接口：

```python
class ProviderAdapter(Protocol):
    name: str

    async def execute(
        self,
        *,
        credential: str,
        action: str,
        resource: str,
        payload: dict,
    ) -> dict:
        ...
```

MVP 只实现：

```text
GitHubProvider
```

支持：

```text
issues.read
```

对应：

```text
GET /repos/{owner}/{repo}/issues/{issue_number}
```

不要第一版实现：

```text
repo.delete
workflow.write
contents.write
admin
```

先只做 Read-only。

---

# 23. GitHub Provider 请求流程

```text
Capsule
 ↓
Broker Request
 ↓
LeaseService.validate()
 ↓
ProviderRegistry.get("github")
 ↓
Python 请求 TS：
host.credential.resolve("GITHUB_TOKEN")
 ↓
TS：ctx.credentials.resolve(...)
 ↓
Secret 仅返回 Trusted Python Runtime
 ↓
GitHubProvider 使用 httpx
 ↓
GitHub
 ↓
Response
 ↓
过滤敏感 Headers
 ↓
限制 Response 大小
 ↓
返回 Capsule
```

Python Runtime 属于 Trusted Computing Base，因此可以短暂在内存中得到 Secret。

但必须：

- 不写 SQLite；
- 不打印日志；
- 不进入异常 stack；
- operation 结束后不缓存；
- 下次 operation 再 resolve。

保持与 DSH Credentials “per-operation resolve”理念一致。

---

# 24. Session Binding

每次 DSH Tool Call 都属于某个 Agent/Session。

Adapter 在 `execute(args, exec)` 时获取当前 Agent/Session identity，并把：

```text
session_id
call_id
agent identity
```

传给 Python。

不要通过猜：

```text
./.sessions/xxxx
```

也不要解析文件名来判断 Session。

必须使用当前 DSH 公共 Agent/Session API。

由于 DSH Developer Preview API 可能继续变化，实现 AI 在编码时应以当前安装版本 TypeScript 类型定义为准，不硬编码本文未确认的属性名。

MVP 对“Session Scoped”的最低要求是：

> Lease 只能在创建它的 session_id 下验证通过。

即使暂时没有可靠的“Session 被删除”生命周期钩子，只要 TTL + session_id 检查生效，安全语义已经成立。

如果可以获取 session dispose/delete event，再增加自动 `revoke_session()`。

---

# 25. Python Capsule SDK

为了不让每个 Capsule 自己写 UDS 协议，提供一个极小 SDK。

示意：

```python
from dsh_capsule_sdk import CapsuleApp

app = CapsuleApp()

@app.tool("github_get_issue")
async def github_get_issue(args, ctx):
    return await ctx.broker.call(
        provider="github",
        action="issues.read",
        resource=f"repo:{args['repo']}",
        payload={
            "repo": args["repo"],
            "issue_number": args["issue_number"],
        },
    )

app.run()
```

注意：

Capsule 开发者不需要：

```text
requests.get("https://api.github.com")
```

而是：

```text
ctx.broker.call(...)
```

这就是受控能力访问入口。

---

# 26. GitHub Reader Capsule

`capsules/github-reader/app.py` 的职责只做：

1. 接收 `github_get_issue` 调用；
2. 校验 `repo` 格式；
3. 调 Broker；
4. 取回结果；
5. 返回结构化字段。

返回：

```json
{
  "number": 10,
  "title": "...",
  "state": "open",
  "author": "alice",
  "body": "...",
  "html_url": "..."
}
```

不要把 GitHub Token 放在 Capsule 内。

---

# 27. malicious-demo Capsule

必须实现一个故意“作恶”的测试 Capsule。

它至少提供以下测试动作：

```text
try_read_host_ssh
try_read_env_secret
try_direct_network
try_access_docker_socket
try_unauthorized_broker_action
```

用于证明隔离确实存在。

## 预期结果

### 读取 SSH

```python
open("/home/<host-user>/.ssh/id_rsa")
```

必须失败。

### 读取 GITHUB_TOKEN

```python
os.getenv("GITHUB_TOKEN")
```

必须得到：

```text
None
```

### 直接联网

```python
httpx.get("https://api.github.com")
```

必须失败，因为：

```text
network=none
```

### Docker Socket

```text
/var/run/docker.sock
```

必须不存在。

### 越权 Broker

Lease：

```text
issues.read
```

请求：

```text
repo.delete
```

必须返回：

```text
CAPABILITY_DENIED
```

---

# 28. 错误码

统一错误码，不要返回杂乱字符串。

至少包括：

```text
CAPSULE_NOT_FOUND
CAPSULE_START_FAILED
CAPSULE_UNAVAILABLE
CAPSULE_TIMEOUT
CAPSULE_PROTOCOL_ERROR

LEASE_REQUIRED
LEASE_REJECTED
LEASE_NOT_FOUND
LEASE_EXPIRED
LEASE_REVOKED
LEASE_SESSION_MISMATCH
LEASE_CAPSULE_MISMATCH
CAPABILITY_DENIED
RESOURCE_DENIED

CREDENTIAL_NOT_CONFIGURED
PROVIDER_NOT_FOUND
PROVIDER_TIMEOUT
PROVIDER_ERROR
BROKER_PROTOCOL_ERROR
```

所有错误必须：

- 不包含 Secret；
- 不包含完整 Host 路径；
- Agent 能理解下一步怎么处理。

---

# 29. Fail Closed 原则

以下情况必须拒绝：

```text
Python Runtime 不可用
Docker 不可用
Capsule 启动失败
Manifest 非法
Approval 不可用
Credential 不存在
Lease 数据库异常
无法确定 Session
Broker 校验异常
Provider 未注册
未知 Action
未知 Resource 格式
```

绝对禁止：

```text
“校验失败了，那先放过去吧”
```

---

# 30. 宿主与 Capsule 的信任边界

## Trusted

```text
DSH Core
DSH Capsule TypeScript Adapter
Python Capsule Runtime
SQLite Lease DB
Provider Adapters
```

## Untrusted

```text
Capsule Container
Capsule Code
Capsule Dependencies
Capsule Input
```

## External / Semi-trusted

```text
GitHub API
Docker Engine
```

这个边界必须在 README 画出来。

---

# 31. 威胁模型

假设攻击者完全控制 Capsule 代码。

攻击者可以：

- 在容器内执行任意代码；
- 在容器内启动子进程；
- 读取自己的容器文件；
- 发送任意 Broker 请求；
- 构造恶意参数；
- 无限循环；
- 输出超大数据；
- 故意崩溃。

系统需要限制：

- 不能读取 Host Secret；
- 不能读取 Host 私有文件；
- 不能直接联网；
- 不能访问其他 Capsule；
- 不能拿 Session A 的权限给 Session B 用；
- 不能做 Lease 未授权的 action；
- 不能在 Lease 过期后继续访问；
- 一个 Capsule 崩溃不能拖垮 DSH；
- 一个 Capsule 卡死不能永久占用资源。

MVP 明确不防：

- Linux Kernel 0-day；
- Docker Runtime 0-day；
- Host 已被 root 控制；
- 恶意 Docker daemon；
- 供应链镜像签名问题；
- CPU cache 等高级 side channel。

README 必须诚实写出这些边界，不能宣传“绝对安全”。

---

# 32. 资源限制

每个 tool invocation：

```text
默认 timeout：30s
```

Provider 请求：

```text
默认 timeout：15s
```

Response：

```text
设置最大字节数，例如 2 MB
```

Container：

```text
memory = 256 MB
cpus = 0.5
pids = 64
```

如果 Capsule 超时：

```text
取消 invocation
必要时 kill container
返回 CAPSULE_TIMEOUT
```

---

# 33. TypeScript Adapter 详细职责

Adapter 是 DSH 的唯一原生插件代码。

它必须做到：

## 启动

```text
apply(ctx)
 ↓
spawn Python Runtime
 ↓
RPC health check
 ↓
capsule.list_tools
 ↓
ctx.tools.register(...)
```

如果 Python 启动失败：

```text
只让 dsh-capsule unavailable
不能导致整个 DSH Crash
```

## Tool Execute

```text
execute(args, exec)
 ↓
获取 session identity
 ↓
RPC capsule.invoke
 ↓
等待结果
 ↓
映射为 DSH Tool Result
```

## Python 反向调用：Approval

Python：

```text
host.approval.request_lease
```

TS：

```text
找到正在执行的 ToolExecution
 ↓
ctx.approval.request({
  agent,
  toolName,
  callId,
  reason
})
```

只接受：

```text
allowed-once
```

其他结果全部拒绝。

## Python 反向调用：Credential

Python：

```text
host.credential.resolve
```

TS：

```text
ctx.credentials.resolve(ref)
```

返回给 Python。

TS 不能打印 Secret。

---

# 34. Python Runtime 详细模块

## CapsuleManager

负责：

```text
manifest discovery
manifest validate
container create
container start
container health
invoke
stop
remove
```

## DockerBackend

只负责 Docker，不懂 Lease。

接口建议：

```python
class DockerBackend:
    async def start(self, manifest) -> CapsuleInstance: ...
    async def stop(self, instance_id: str) -> None: ...
    async def invoke(self, instance_id: str, request: dict) -> dict: ...
    async def health(self, instance_id: str) -> bool: ...
```

## LeaseService

负责：

```text
find_matching_lease
issue
validate
revoke
revoke_session
expire
```

## BrokerServer

负责接收 UDS Request。

不要把策略写死在 Socket Handler 里。

## BrokerPolicy

负责：

```text
caller identity
session
provider
action
resource
lease
```

## ProviderRegistry

```python
providers = {
    "github": GitHubProvider(...)
}
```

---

# 35. SQLite 为什么足够？

MVP 是本地单用户运行时。

Lease 数量很小。

SQLite 已经足够支持：

```text
TTL
Status
Revoke
Lookup
Session Binding
```

不要第一版引入 Redis/PostgreSQL。

数据库位置建议：

```text
~/.dsh/capsule/capsule.db
```

权限：

```text
0600
```

注意：数据库中不能存长期 Secret。

---

# 36. 最小可用流程（最终 Demo）

## 第一步

用户已经在 DSH Credentials 中配置：

```text
GITHUB_TOKEN
```

## 第二步

安装 `dsh-capsule`。

启动时注册：

```text
github_get_issue
```

## 第三步

用户问：

```text
帮我查看 deepseek-ai/deepseek-harness 的 issue #5106
```

Agent 调：

```text
github_get_issue
```

## 第四步

首次访问弹出：

```text
github-reader 请求 10 分钟授权

资源：deepseek-ai/deepseek-harness
权限：issues.read

Allow / Reject
```

## 第五步

用户 Allow。

Runtime 创建 Lease。

GitHub Token 不进入容器。

Broker 请求 GitHub。

Issue 返回 Agent。

## 第六步

再次读同 Repo Issue：

```text
Lease 仍 ACTIVE
```

不再询问。

## 第七步

运行：

```text
capsulectl revoke L001
```

## 第八步

再次访问：

```text
LEASE_REVOKED
```

重新授权才能继续。

---

# 37. 安全 Demo（这是项目最重要的演示）

启动 malicious-demo。

依次演示：

```text
1. 读取宿主 SSH Key → 失败
2. 读取 GITHUB_TOKEN → None
3. curl GitHub → Network unreachable
4. 找 docker.sock → 不存在
5. issues.read → 成功
6. repo.delete → CAPABILITY_DENIED
7. Lease revoke 后 issues.read → LEASE_REVOKED
8. Session B 尝试复用 Session A Lease → LEASE_SESSION_MISMATCH
9. malicious-demo crash → DSH 主进程仍正常
```

如果这 9 个效果全部演示成功，这个 MVP 已经成立。

---

# 38. 测试要求

## Unit Tests

至少覆盖：

```text
Lease issue
Lease active
Lease expire
Lease revoke
Capsule mismatch
Session mismatch
Provider mismatch
Action denied
Resource denied
```

## Integration Tests

```text
TS ↔ Python RPC
Python ↔ Container UDS
Container lifecycle
GitHub Provider mock
Approval allow
Approval reject
Credential missing
Runtime restart
```

## Security Negative Tests

```text
Host file read
Host env read
Direct network
Docker socket
Cross-capsule IPC
Unauthorized action
Expired lease
Revoked lease
Oversized output
Infinite loop
Container crash
```

安全测试不能只测试“正常功能能用”。

---

# 39. 验收标准

MVP 完成必须同时满足：

- [ ] DSH 能看到 `github_get_issue` 工具；
- [ ] Tool 实际代码运行在 Docker，而不是 DSH Host；
- [ ] Container 无公网网络；
- [ ] Container 看不到 `GITHUB_TOKEN`；
- [ ] Container 看不到宿主 `$HOME`；
- [ ] Container 没有 Docker Socket；
- [ ] 第一次 GitHub 访问会请求 Lease Approval；
- [ ] Allow 后成功访问；
- [ ] 同 Session + 同 Scope + TTL 内可复用；
- [ ] 不同 Session 不可复用；
- [ ] Revoke 后立即失效；
- [ ] TTL 到期立即失效；
- [ ] 未声明 Action 一律拒绝；
- [ ] Credential 未配置时 Fail Closed；
- [ ] Python Runtime Crash 不得泄露 Secret；
- [ ] Capsule Crash 不得带崩 DSH；
- [ ] malicious-demo 负向测试全部通过。

---

# 40. 开发阶段

## Phase 0：项目骨架

完成：

```text
TS Adapter 能启动 Python
NDJSON ping/pong
Python health
```

验收：

```text
DSH 启动
Python Runtime READY
DSH 关闭
Python Runtime 被正确回收
```

## Phase 1：Docker Capsule Runtime

完成：

```text
Manifest
DockerBackend
UDS plugin.sock
hello tool
```

先不要做 GitHub。

验收：

```text
DSH → hello_capsule → Docker → "hello"
```

## Phase 2：隔离策略

完成：

```text
network none
read-only
non-root
cap-drop all
resource limits
malicious-demo
```

验收：

宿主文件、环境变量、网络、Docker Socket 全部失败。

## Phase 3：Lease

完成：

```text
SQLite
LeaseService
TTL
Revoke
Session Binding
```

先写纯 Python Unit Test。

## Phase 4：DSH Approval + Credentials

完成：

```text
Python reverse RPC
ctx.approval
ctx.credentials
```

验收：

首次请求授权；凭据始终不进入 Container。

## Phase 5：GitHub Reader

完成：

```text
GitHub Provider
issues.read
github_get_issue
```

## Phase 6：最终安全 Demo

跑完第 37 节的 9 个测试。

达到这里即可停止 MVP，不要继续加功能。

---

# 41. 给 AI 编程助手的强制实现规则

将本技术文档交给 AI 时，同时附上以下指令：

```text
你正在实现 dsh-capsule MVP。

严格遵守技术规格，不擅自扩大范围。

必须遵守：
1. 不修改 DeepSeek Harness Core 源码。
2. 以独立 DSH Plugin 接入。
3. TypeScript 只做薄 Adapter。
4. 核心 Runtime 使用 Python。
5. 目标平台先只支持 Linux + Docker。
6. 不兼容任意现有 Cordis Plugin，只支持 Capsule Tool Plugin。
7. 不实现通用 HTTP Proxy。
8. Container 默认 network none。
9. 长期 Secret 永远不能进入 Container。
10. 所有授权 Fail Closed。
11. 所有 Lease 必须绑定 capsule_instance_id + session_id + provider + resource + action + TTL。
12. Credential 每次 Provider operation 通过 DSH ctx.credentials 重新 resolve，不跨 operation 缓存。
13. stdout 如果用于 NDJSON RPC，不得打印普通日志；普通日志写 stderr。
14. 不记录 Secret 到日志、SQLite、Tool Result、异常信息。
15. 每完成一个 Phase，先补齐测试并运行通过，再进入下一 Phase。
16. MVP 完成前不要实现 Web UI、签名、SBOM、Kubernetes、microVM、Redis、PostgreSQL。
17. 遇到 DSH API 属性名与本文不一致时，以当前安装版本的官方 TypeScript 类型定义和官方文档为准，不通过猜测 Session 文件路径绕过。
```

---

# 42. 实现 AI 第一个任务应该是什么？

不要让 AI 一次生成整个项目。

第一个任务只给它：

```text
阅读本技术规格。
先完成 Phase 0：

1. 创建 monorepo 目录结构；
2. 创建最小 DSH TypeScript 插件；
3. TypeScript 使用 child_process.spawn 启动 Python Runtime；
4. 实现双向 NDJSON RPC 基础协议；
5. 实现 system.ping；
6. DSH plugin dispose 时正确终止 Python；
7. stdout 严格保留给 RPC，Python 日志使用 stderr；
8. 为 RPC 编写自动测试；
9. 不实现 Docker、Lease、GitHub。

完成后输出：
- 修改文件列表；
- 如何运行；
- 测试结果；
- 尚未实现的 Phase。
```

Phase 0 验收后，再让 AI 做 Phase 1。

这会比“一句话让 AI 把整个系统写完”稳定很多。

---

# 43. README 应该怎么描述项目

推荐首页第一段：

```text
DSH Capsule is an isolated tool-plugin runtime for DeepSeek Harness.

Third-party Capsule code runs outside the Harness process in a restricted Docker container. Capsules do not receive host credentials or direct network access. When a Capsule needs an external capability, the trusted host broker mediates the operation through a short-lived, session-bound, revocable capability lease.
```

中文：

```text
DSH Capsule 是面向 DeepSeek Harness 的隔离式第三方 Tool Plugin Runtime。

第三方 Capsule 代码不会直接运行在 Harness 主进程中，而是在受限 Docker 容器中执行；容器无法读取宿主长期凭据，也默认不能直接访问网络。当插件确实需要访问 GitHub 等外部资源时，由宿主 Broker 在用户授权后签发短期、Session 绑定、可撤销的 Capability Lease，并由 Broker 代为完成外部请求。
```

---

# 44. 简历定位

不要写成：

```text
做了一个 Docker 安全插件。
```

推荐定位：

```text
DSH Capsule｜Agent 第三方工具隔离运行时
```

可以提炼成：

```text
【Plugin Runtime】针对 DSH 第三方插件与 Host 共享运行权限的问题，设计 Thin TS Adapter + Python Runtime 架构，将非可信 Tool Plugin 下沉至受限 Docker 容器执行，实现宿主文件、环境变量与公网访问隔离。

【Credential Lease】基于 DSH Credentials/Approval 构建 Session-scoped Capability Lease，由可信 Broker 代理外部 API 请求，使第三方插件无需接触长期 Secret，并支持 TTL、Scope 校验与即时撤销。

【安全闭环】构建恶意插件负向测试集，覆盖宿主文件读取、凭据窃取、直接联网、越权 Action、跨 Session 复用及插件崩溃等场景，验证单插件异常不扩散至 Harness 主进程。
```

这个项目在面试里应该强调的是：

```text
Agent Tool Runtime
Plugin Architecture
Trust Boundary
Capability-based Authorization
Credential Management
Session Lifecycle
Isolation
Fail-closed Design
```

而不是把自己包装成做传统网络安全产品。

---

# 45. 最终一句话总结

本项目不是“让 DSH 更安全”这样空泛的口号。

它解决的是一个非常具体的问题：

```text
第三方插件需要给 Agent 提供真实能力，
但我们不希望：

安装一个插件
=
把宿主文件、进程、网络和长期凭证一起信任给它。
```

因此我们增加一层：

```text
Third-party Tool
        ↓
Isolated Capsule
        ↓
Revocable Capability Lease
        ↓
Trusted Broker
        ↓
External Capability
```

最终目标：

> **插件可以做事，但插件不需要拥有宿主。**

---

# 46. 官方/社区实现依据（编码时优先核对当前版本）

实现前应核对 DeepSeek Harness 当前版本以下官方文档/源码位置：

```text
SAFETY.md

docs/subsystems/sandbox.md
packages/workflow/workflow-worker-thread/README.md

docs/subsystems/credentials.md
packages/credentials/credentials/README.md

docs/subsystems/approval.md

packages/core/tools/README.md
docs/subsystems/tools.md
docs/cookbook/adding-a-tool.md

docs/user/develop/framework/service.md

docs/user/guide/python-sdk.md
```

与需求背景相关的社区讨论可重点查看：

```text
Discussion #587
第三方插件与 Host 核心进程、配置与凭据的信任边界问题。

Discussion #5106
单插件加载失败缺乏 fault isolation，社区提出 per-plugin isolation。
```

由于 DSH 当前仍处于快速演进阶段，编码时：

> **架构原则以本文为准，具体 API 名称以当前官方类型与源码为准。**

