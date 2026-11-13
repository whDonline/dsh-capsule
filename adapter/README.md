# @dsh-capsule/adapter

**DSH Capability Guard** 的宿主端插件包：把重复审批变成有期限、可撤销、可追溯的短期授权，并提供用户显式开启的免打扰窗口。

完整说明见 [DSH Capsule 仓库 README](https://github.com/whDonline/dsh-capsule/blob/main/README.md)（[English](https://github.com/whDonline/dsh-capsule/blob/main/README.en.md)）。

## 安装

```bash
dsh plugin --profile web add @dsh-capsule/adapter
dsh --profile web --dump-config
dsh web
```

`web` 可替换为你的目标 profile。修改宿主端代码并重新构建后必须重启 DSH；profile 配置 HMR 不会重新加载已装载的宿主 JavaScript。

## 它做什么

- **短期授权**：人工批准后签发绑定 Session × Tool × Scope × TTL 的 Lease；命中有效授权时减少重复询问。
- **免打扰窗口**：由用户显式开启的限时审批放行层，只自动批准本会话已记录的沙箱升级请求；**不签发 Lease、不改沙箱档位、不改审批策略**。
- **敏感路径保护**：通过 DSH 原生 `ctx.tools.guard()` 注册，命中即拒绝；只收紧、不放开。
- **工作区外访问记录**：按目录汇总文件类工具在工作区外的读/写，只记目录、不记文件名。
- **本地可追溯**：授权决策记录与审计默认追加保存在本机，可导出 JSON。

Guard **始终不改写会话沙箱档位**。原始 `allow` / `deny` 保持原语义；`deny` 永远不能被 Lease 覆盖。

## 安全边界

- 敏感路径保护是静态拒绝，**不是沙箱**；命令类工具只做命令文本扫描，属启发式，可被刻意规避。
- 治理接口是本机 loopback 上的无鉴权面；不信任本机进程时请把 `console.enabled` 设为 `false`。
- 免打扰窗口内，符合条件的沙箱升级请求会自动获批，目标可能是完全访问；请只在信任当前会话工作内容时开启。
- 本包不访问云端、不收集遥测、不需要 API Key；审计只写本机 `<用户目录>/.dsh/capability-guard/audit.ndjson`（可用 `auditFile` 覆盖，`persistAudit: false` 关闭）。

## 要求

- Node.js >= 22
- DeepSeek Harness `>=0.1.5-0 <0.3.0`

## 许可证

MIT
