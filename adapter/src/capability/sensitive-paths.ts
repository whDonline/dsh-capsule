import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ToolExecutionLike } from "./types.js";
// 作用：敏感路径静态保护（2026-11-01，参考 dsh-permission-control 的 denyRules / 内置保护）。
//
// 【定位】这不是沙箱，也不是安全边界：它只防「明显的手滑 / 模型走偏」，挡不住刻意规避。
// 真正的权限仍由 DSH 沙箱与审批决定；本模块只在工具执行前返回一个拒绝理由。
//
// 【为什么用 tools.guard】DSH 原生提供单调 guard：它在 tools/pre-execute 之后、工具体之前运行，
// 拿到完整参数，返回字符串即拒绝，任何监听器都无法把拒绝翻回允许（没有 allow 结果）。
// 因此我们不需要自己发明拦截器，也不新增 hook；guard 不可用时自动退化为不保护（Fail Open 到 DSH 原生）。
//
// 【命中规则】按参数里的路径做前缀匹配（文件系统工具），命令类工具只能扫命令文本（启发式）。
// `deny` 拦读也拦写；`deny-write` 只拦写（读放行）。对命令类工具一律按「写」处理，宁严勿松。
// 路径解析不跟随符号链接（不调用 realpath）：判定基于用户给出的字面路径，避免额外 IO 与误判。
export type SensitiveScope = "deny" | "deny-write";
export interface SensitivePathRule {
  /** 稳定 id：审计与拒绝理由里使用 */
  id: string;
  /** 绝对路径、`~` 开头或相对路径（相对路径按会话工作区根解析） */
  path: string;
  scope: SensitiveScope;
}
export interface SensitivePathContext {
  home?: string;
  platform?: NodeJS.Platform;
  /** 会话工作区根：相对路径与「工作区外」判断都用它；未提供时退回进程 cwd */
  workspaceRoot?: string;
  /** 额外的用户规则（来自插件配置） */
  extra?: readonly SensitivePathRule[];
}
export interface SensitiveHit {
  rule: SensitivePathRule;
  /** 命中位置（规范化后的路径，或命令文本里的匹配片段） */
  target: string;
  /** 是否来自命令文本扫描（启发式） */
  heuristic: boolean;
  /** 本次操作类别（命令类工具按 write 计） */
  operation: "read" | "write";
}
const FS_READ_TOOLS = new Set(["read", "glob", "grep"]);
const FS_WRITE_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["pwsh", "bash", "sh", "zsh"]);
/** 作用：按平台取路径 API——这样 win32/posix 语义由 platform 决定，与宿主 OS 无关，便于跨平台测试。 */
function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}
/** 作用：内置敏感路径规则（按平台补充浏览器配置目录）。默认开启，可用配置关闭。 */
export function defaultSensitiveRules(context: SensitivePathContext = {}): SensitivePathRule[] {
  const home = context.home ?? homedir();
  const platform = context.platform ?? process.platform;
  const p = pathApi(platform);
  const rules: SensitivePathRule[] = [
    { id: "ssh-private-keys", path: "~/.ssh", scope: "deny" },
    { id: "gnupg-keys", path: "~/.gnupg", scope: "deny" },
    { id: "aws-credentials", path: "~/.aws", scope: "deny" },
    { id: "kube-credentials", path: "~/.kube", scope: "deny" },
    { id: "gcloud-credentials", path: "~/.config/gcloud", scope: "deny" },
    { id: "gh-cli-credentials", path: "~/.config/gh", scope: "deny" },
    { id: "npmrc-token", path: "~/.npmrc", scope: "deny" },
    // DSH 自身配置目录：允许读（排障需要），禁止改写（避免把审批策略/凭据改坏）
    { id: "dsh-config-write", path: "~/.dsh", scope: "deny-write" },
  ];
  if (platform === "win32") {
    rules.push(
      { id: "chrome-profile", path: p.join(home, "AppData", "Local", "Google", "Chrome", "User Data"), scope: "deny" },
      { id: "edge-profile", path: p.join(home, "AppData", "Local", "Microsoft", "Edge", "User Data"), scope: "deny" },
      { id: "firefox-profile", path: p.join(home, "AppData", "Roaming", "Mozilla", "Firefox"), scope: "deny" },
    );
  } else if (platform === "darwin") {
    rules.push(
      { id: "chrome-profile", path: p.join(home, "Library", "Application Support", "Google", "Chrome"), scope: "deny" },
      { id: "firefox-profile", path: p.join(home, "Library", "Application Support", "Firefox"), scope: "deny" },
    );
  } else {
    rules.push(
      { id: "chrome-profile", path: p.join(home, ".config", "google-chrome"), scope: "deny" },
      { id: "firefox-profile", path: p.join(home, ".mozilla", "firefox"), scope: "deny" },
    );
  }
  return rules;
}
/** 作用：展开 `~` 与相对路径并规范化（win32 统一小写、统一分隔符）。 */
export function normalizePath(value: string, context: SensitivePathContext = {}): string {
  const home = context.home ?? homedir();
  const platform = context.platform ?? process.platform;
  const p = pathApi(platform);
  let text = value.trim();
  if (text === "~") text = home;
  else if (text.startsWith("~/") || text.startsWith("~\\")) text = p.join(home, text.slice(2));
  if (!p.isAbsolute(text)) text = p.resolve(context.workspaceRoot ?? process.cwd(), text);
  const normalized = trimTrailingSeparator(text.replace(/[\\/]+/g, p.sep), p.sep);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
/** 作用：判断路径是否命中规则（前缀匹配；大小写按平台）。 */
export function matchSensitivePath(target: string, rules: readonly SensitivePathRule[], context: SensitivePathContext = {}): SensitivePathRule | undefined {
  const normalized = normalizePath(target, context);
  const pathSep = pathApi(context.platform ?? process.platform).sep;
  for (const rule of rules) {
    const base = normalizePath(rule.path, context);
    if (normalized === base || normalized.startsWith(`${base}${pathSep}`)) return rule;
  }
  return undefined;
}
/** 作用：扫命令文本里是否出现规则路径（启发式；`~` 与绝对路径两种写法都认）。 */
export function commandMentionsRule(command: string, rule: SensitivePathRule, context: SensitivePathContext = {}): string | undefined {
  const platform = context.platform ?? process.platform;
  const pathSep = pathApi(platform).sep;
  // win32 上把命令里的两种分隔符统一后再匹配（`~/.ssh` 与 `~\.ssh` 都能命中）；posix 保持原样
  const rawCommand = platform === "win32" ? command.toLowerCase().replace(/[\\/]+/g, pathSep) : command;
  const normalizedCommand = rawCommand;
  const bases = new Set<string>([normalizePath(rule.path, context)]);
  // 命令里最常见的是 `~/.ssh` 这种写法：补一份规范化后的波浪号形式
  const raw = rule.path.trim();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const tail = raw.slice(2).replace(/[\\/]+/g, pathSep);
    bases.add(platform === "win32" ? `~${pathSep}${tail}`.toLowerCase() : `~${pathSep}${tail}`);
    bases.add(platform === "win32" ? tail.toLowerCase() : tail);
  }
  for (const base of bases) {
    if (base.length === 0) continue;
    const candidate = platform === "win32" ? base.toLowerCase() : base;
    const index = normalizedCommand.indexOf(candidate);
    if (index < 0) continue;
    const before = index === 0 ? "" : normalizedCommand.slice(index - 1, index);
    // 起始边界：避免 `my.ssh` 这类普通文件名命中 `.ssh`；`~\`、`/` 视为路径开头
    if (before !== "" && !/[\s"'`=:(/~\\]/.test(before)) continue;
    const after = normalizedCommand.slice(index + candidate.length, index + candidate.length + 1);
    // 结束边界：路径之后必须是分隔符、空白、引号、分号、管道、重定向或结尾
    if (after === "" || /[\s"'`;|&<>),/\\]/.test(after)) return command.slice(index, index + candidate.length);
  }
  return undefined;
}
/** 作用：一次工具调用的静态判定——命中返回原因文本，未命中/不适用返回 undefined。 */
export function judgeSensitivePath(exec: ToolExecutionLike, rules: readonly SensitivePathRule[], context: SensitivePathContext = {}): SensitiveHit | undefined {
  const toolName = typeof exec?.name === "string" ? exec.name : "";
  const args = exec?.arguments;
  if (FS_READ_TOOLS.has(toolName) || FS_WRITE_TOOLS.has(toolName)) {
    const target = readPathArgument(args);
    if (target === undefined) return undefined;
    const rule = matchSensitivePath(target, rules, context);
    if (!rule) return undefined;
    const operation = FS_WRITE_TOOLS.has(toolName) ? "write" : "read";
    if (rule.scope === "deny-write" && operation === "read") return undefined;
    return { rule, target: normalizePath(target, context), heuristic: false, operation };
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = readCommandArgument(args);
    if (command === undefined) return undefined;
    for (const rule of rules) {
      const hit = commandMentionsRule(command, rule, context);
      if (hit !== undefined) return { rule, target: hit, heuristic: true, operation: "write" };
    }
  }
  return undefined;
}
/** 作用：生成给宿主 `tools.guard()` 的判定函数——任何异常都返回 undefined（不因插件 bug 拒绝一切）。
 *  context 可以是固定值，也可以是「按本次执行取上下文」的函数（用于拿到会话工作区根）。 */
export function createSensitivePathGuard(options: {
  rules: readonly SensitivePathRule[];
  context: SensitivePathContext | ((exec: ToolExecutionLike) => SensitivePathContext);
  onDeny?: (exec: ToolExecutionLike, hit: SensitiveHit) => void;
}): (exec: ToolExecutionLike) => string | undefined {
  const contextOf = (exec: ToolExecutionLike): SensitivePathContext => {
    const ctx = options.context;
    return typeof ctx === "function" ? (ctx as (exec: ToolExecutionLike) => SensitivePathContext)(exec) : (ctx as SensitivePathContext);
  };
  return (exec) => {
    try {
      const hit = judgeSensitivePath(exec, options.rules, contextOf(exec));
      if (!hit) return undefined;
      try {
        options.onDeny?.(exec, hit);
      } catch {
        // 审计失败不影响拒绝本身
      }
      const scopeText = hit.rule.scope === "deny" ? "读写都禁止" : "只禁止写入";
      const heuristicText = hit.heuristic ? "（命令文本扫描，属启发式，可被刻意规避绕过）" : "";
      return `命中敏感路径保护「${hit.rule.id}」：${hit.target}（${scopeText}）${heuristicText}。这是本机静态保护，不是沙箱；确需操作请在配置里调整 sensitivePaths。`;
    } catch {
      return undefined;
    }
  };
}
/** 作用：解析额外的用户规则——路径必须非空，scope 只认闭集（非法项忽略）。 */
export function parseExtraRules(extra: unknown): SensitivePathRule[] {
  if (!Array.isArray(extra)) return [];
  const rules: SensitivePathRule[] = [];
  let index = 0;
  for (const item of extra) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = record.path;
    const scope = record.scope;
    if (typeof path !== "string" || path.trim().length === 0) continue;
    if (scope !== undefined && scope !== "deny" && scope !== "deny-write") continue;
    index += 1;
    rules.push({ id: `custom-${index}`, path, scope: scope ?? "deny-write" });
  }
  return rules;
}
function readPathArgument(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}
function readCommandArgument(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "script", "cmd"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
function trimTrailingSeparator(value: string, pathSep: string): string {
  // 作用：去掉末尾分隔符（根路径保留），保证前缀比较 `base + sep` 不会出现双分隔符
  let out = value;
  while (out.length > 1 && out.endsWith(pathSep)) out = out.slice(0, -1);
  if (/^[A-Za-z]:$/.test(out)) out += pathSep;
  return out.length === 0 ? pathSep : out;
}
