// 作用：操作族（② 同族模式的判据）——回答「两次调用是不是同一类事」。
//
// 三个内置族（2026-10-31 产品定稿）：
//   object  同一个对象：参数里"像路径"的值相同（所有工具都能用）
//   tool    同一个工具：只对**只读白名单**工具生效
//   command 同一类命令：从 command/script 里取「程序名 + 子命令」，只对**只读程序白名单**生效
//
// 【安全阀（硬编码，不做配置）】写/删类工具永不获得 tool / command 族——否则你批准一次 `rm a.txt`，
// 下一次 `rm -rf <项目>` 就会命中"同一工具"而被自动放行。只读类最坏情况只是多读一次，宽一点可以接受。
//
// 族的放行不是永久的：只有「最近一次人工批准 + TTL 内」有效（FamilyGrantStore），过期即重新询问。
import { sha256Scope } from "./canonical.js";
/** 只读工具白名单——只有它们能获得「同工具」族。 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "read_image", "grep", "glob", "list", "search", "fetch", "web_fetch", "web_search", "session_search", "session_event_read", "session_event_search"]);
/** 只读程序白名单——只有它们能获得「同类命令」族（写命令永不在内）。 */
export const READ_ONLY_PROGRAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "grep", "ls-files"])],
  ["rg", new Set<string>()],
  ["grep", new Set<string>()],
  ["findstr", new Set<string>()],
  ["dir", new Set<string>()],
  ["ls", new Set<string>()],
  ["cat", new Set<string>()],
  ["type", new Set<string>()],
  ["get-childitem", new Set<string>()],
  ["get-content", new Set<string>()],
  ["select-string", new Set<string>()],
]);
/** 「像路径」的判定：含分隔符 / 盘符 / 以 ~ 或 / 开头。纯字符串判断，绝不访问文件系统。 */
export function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("/")) return true;
  return /^[A-Za-z]:$/.test(value.slice(0, 2)) && value.length > 2;
}
export type FamilyKind = "object" | "dir" | "command" | "program" | "prefix" | "tool";
export interface FamilyRef {
  kind: FamilyKind;
  /** 族键（sha256）——只保存哈希，不保存参数原文 */
  key: string;
  /** 可展示的族名（例如 "同一文件" / "工具 read" / "命令 git status"） */
  label: string;
}
/** 作用：从一次调用算出它属于哪些族（可能为空 = 不参与族复用）。 */
export function identifyFamilies(toolName: string, args: unknown, mode?: string): FamilyRef[] {
  const families: FamilyRef[] = [];
  const obj = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  // 目标档位也是操作的一部分：同一条命令"升到完全访问"与"升到工作区可写"不能互相顶替。
  const requestedMode = mode ?? modeOfArgs(obj);
  // ① 对象族：参数里"像路径"的值（所有工具）
  for (const key of Object.keys(obj).sort()) {
    // command / script 是命令文本，不是路径参数——否则整条脚本会因为含 `\` 被误判成"同一对象"
    if (key === "command" || key === "script") continue;
    const value = obj[key];
    if (typeof value !== "string" || !looksLikePath(value)) continue;
    families.push({ kind: "object", key: sha256Scope({ family: "object", tool: toolName, arg: key, value: value.toLowerCase() }), label: `同一对象 ${value}` });
  }
  // ② 工具族：只读工具
  if (READ_ONLY_TOOLS.has(toolName)) {
    families.push({ kind: "tool", key: sha256Scope({ family: "tool", tool: toolName }), label: `同工具 ${toolName}` });
  }
  const command = typeof obj.command === "string" ? obj.command : typeof obj.script === "string" ? obj.script : undefined;
  if (command) {
    // ③ 前缀族（**任何模式都生效**）：把复合命令拆成子命令，每条各自算「程序 + 子命令」，
    // 与 Claude Code 一致：`a && b` 需要 a、b 都已被允许；批准时则为每个子命令各建一条。
    // 两条规则：
    //   - 某行**解析不出程序名**（表达式 `"x=" + (Test-Path $p)`、字符串、残留赋值）→ **忽略该行**，
    //     不能因为它作废整条脚本（实测：这类收尾行的存在会让多行脚本永远命中不了）；
    //   - 某行含**破坏性程序**（Remove-Item / del / mv / format…）→ **整条脚本不产生前缀族**，
    //     否则 `$p = ...; Remove-Item $p` 会靠 Join-Path 的前缀混过去（实测越权缺陷）。
    let blocked = false;
    const prefixList: { program: string; sub: string; text: string }[] = [];
    for (const piece of splitSubcommands(command)) {
      if (containsDestructive(piece)) {
        blocked = true;
        break;
      }
      const prefix = parseCommandPrefix(piece);
      if (prefix) prefixList.push(prefix);
    }
    if (!blocked && prefixList.length > 0) {
      const seen = new Set<string>();
      for (const prefix of prefixList) {
        const key = sha256Scope({ family: "prefix", program: prefix.program, sub: prefix.sub, mode: requestedMode ?? null });
        if (seen.has(key)) continue;
        seen.add(key);
        families.push({ kind: "prefix", key, label: `同前缀 ${prefix.text}${requestedMode ? " → " + requestedMode : ""}` });
      }
    }
    // ④ 命令族：只读程序 + 允许的子命令
    const parsed = parseReadOnlyCommand(command);
    if (parsed) families.push({ kind: "command", key: sha256Scope({ family: "command", program: parsed.program, sub: parsed.sub }), label: `同类命令 ${parsed.program}${parsed.sub ? " " + parsed.sub : ""}` });
    // ④ 目录族：写操作也能复用（破坏性程序永不参与，见 DESTRUCTIVE_PROGRAMS）。
    // 「同程序」不再单独成族——前缀族已经覆盖它，且前缀族带目标档位，不会把不同档位混在一起。
    const shape = parseCommandShape(command);
    if (shape && !DESTRUCTIVE_PROGRAMS.has(shape.program)) {
      for (const dir of shape.dirs) {
        families.push({ kind: "dir", key: sha256Scope({ family: "dir", program: shape.program, dir, mode: requestedMode ?? null }), label: `同目录 ${shape.program} @ ${dir}` });
      }
    }
  }
  return families;
}
/** 作用：从参数里读出目标档位——兼容 `sandbox_permissions: "x"` 与 `{ mode: "x" }` 两种写法。 */
function modeOfArgs(obj: Record<string, unknown>): string | undefined {
  const raw = obj.sandbox_permissions ?? obj.sandboxPermissions;
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object") {
    const mode = (raw as Record<string, unknown>).mode;
    if (typeof mode === "string") return mode;
  }
  return undefined;
}
/** 只有这些程序才把第二个 token 当作"子命令"——其余程序（New-Item / Get-ChildItem）的第二个 token
 *  是普通参数，硬当子命令会把 `Join-Path D:\x a` 和 `Join-Path D:\y b` 拆成两个不同前缀。 */
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set(["git", "npm", "pnpm", "yarn", "dotnet", "cargo", "go", "docker", "kubectl", "helm", "terraform", "gh", "pip", "uv", "poetry", "composer"]);
/** 破坏性程序：**永不**获得目录族 / 程序族（换参数必须重新问）。 */
export const DESTRUCTIVE_PROGRAMS: ReadonlySet<string> = new Set(["rm", "del", "erase", "rmdir", "rd", "remove-item", "mv", "move", "move-item", "format", "diskpart", "shutdown", "drop", "truncate", "mkfs", "dd", "git"]);
/** 前缀族也不能用的程序（比 DESTRUCTIVE_PROGRAMS 更保守的那一批）。 */
const NO_PREFIX_PROGRAMS: ReadonlySet<string> = new Set(["rm", "del", "erase", "rmdir", "rd", "remove-item", "mv", "move", "move-item", "format", "diskpart", "shutdown", "drop", "truncate", "mkfs", "dd"]);
/** 前缀族要按子命令再排除的高危组合（`git push` 不能被 `git log` 的批准放过）。 */
const PREFIX_EXCLUDED_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["push", "reset", "clean", "checkout", "rebase", "merge", "stash", "tag"])],
  ["npm", new Set(["publish", "unpublish"])],
  ["pnpm", new Set(["publish"])],
  ["yarn", new Set(["publish"])],
]);
/** 合法的程序名/子命令名：只允许字母数字与 . _ -（排除 `$p`、`=`、`(` 这类脚本语法）。 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** 作用：取第一行——多行脚本没有"单一程序"，不参与前缀归一化。 */
function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}
/** 作用：整条命令（含多行）里出现任何破坏性程序 → 一律不给前缀/目录/程序族。 */
function containsDestructive(command: string): boolean {
  const tokens = command.toLowerCase().split(/[^a-z0-9._-]+/);
  return tokens.some((token) => NO_PREFIX_PROGRAMS.has(token));
}
/**
 * 作用：把复合命令拆成子命令——按换行、`;`、`&&`、`||`、`|` 切分（与 Claude Code 的复合命令语义一致：
 * `a && b` 需要 a、b 都已被允许）。同时剥掉 PowerShell / JS 的变量赋值前缀（`$p = Join-Path ...`）。
 */
export function splitSubcommands(command: string): string[] {
  const pieces: string[] = [];
  for (const rawLine of command.split(/\r?\n/)) {
    for (const piece of rawLine.split(/;|&&|\|\||\|/)) {
      const cleaned = piece.trim().replace(/^(?:const\s+|let\s+|var\s+)?\$?[\w.:]+\s*=\s*(?=[\w$"'])/, "").trim();
      if (cleaned.length === 0 || cleaned.startsWith("#")) continue;
      pieces.push(cleaned);
    }
  }
  return pieces;
}
/**
 * 作用：解析「命令前缀」——程序名 + 子命令，等价于 Claude Code 的 `Bash(npm run *)`。
 * 这是"命令每次都不同"时唯一稳定的归一化：`npm run build` / `npm run test` 同属 `npm run`。
 * 破坏性程序与高危子命令返回 undefined（只能精确匹配）。
 */
export function parseCommandPrefix(command: string): { program: string; sub: string; text: string } | undefined {
  // 注意：本函数接收的是**单个子命令**（复合命令由 splitSubcommands 先拆开）
  const text = command.trim();
  if (text.length === 0) return undefined;
  // 变量赋值 / 子表达式开头：不是命令
  if (/^[$@(]/.test(text)) return undefined;
  if (containsDestructive(text)) return undefined;
  const tokens = text.split(/\s+/);
  const program = tokens[0]?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() ?? "";
  if (!NAME_RE.test(program) || NO_PREFIX_PROGRAMS.has(program)) return undefined;
  const sub = SUBCOMMAND_PROGRAMS.has(program)
    ? (tokens.slice(1).find((token) => !token.startsWith("-") && !token.startsWith("/") && !looksLikePath(token) && NAME_RE.test(token.toLowerCase())) ?? "").toLowerCase()
    : "";
  const excluded = PREFIX_EXCLUDED_SUBCOMMANDS.get(program);
  if (sub !== "" && excluded?.has(sub)) return undefined;
  return { program, sub, text: sub === "" ? program : `${program} ${sub}` };
}
/** 作用：命令展示前的脱敏——把可能夹带密钥的赋值替换掉，并截断到 120 字。 */
export function redactCommand(command: string, limit = 120): string {
  let text = command.replace(/((?:password|passwd|token|secret|api[-_]?key|access[-_]?key)\s*[=:]\s*)(\S+)/gi, "$1***");
  text = text.replace(/(--(?:password|token|secret|api-key)\s+)(\S+)/gi, "$1***");
  text = text.replace(/(Bearer\s+)[\w.\-]+/gi, "$1***");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
/** 作用：从命令里取出「程序名 + 出现过的目录」——用于目录族 / 程序族。 */
export function parseCommandShape(command: string): { program: string; dirs: string[] } | undefined {
  const text = firstLine(command);
  if (text.length === 0 || command.trim() !== text) return undefined;
  if (/^[$@(]/.test(text) || containsDestructive(command)) return undefined;
  const tokens = text.split(/\s+/);
  const program = tokens[0]?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() ?? "";
  if (!NAME_RE.test(program)) return undefined;
  const dirs = new Set<string>();
  for (const token of tokens.slice(1)) {
    const cleaned = token.replace(/^['"]|['"]$/g, "");
    if (!looksLikePath(cleaned)) continue;
    const separator = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
    if (separator <= 0) continue;
    dirs.add(cleaned.slice(0, separator).toLowerCase());
  }
  return { program, dirs: [...dirs].sort() };
}
/** 作用：解析命令的「程序名 + 子命令」——只读白名单之外一律返回 undefined（不给族）。 */
export function parseReadOnlyCommand(command: string): { program: string; sub: string } | undefined {
  const text = command.trim();
  if (text.length === 0) return undefined;
  // 简单切分：取第一个 token 作为程序名（去路径与 .exe/.cmd 后缀），第二个非选项 token 作为子命令
  const tokens = text.split(/\s+/);
  const first = tokens[0] ?? "";
  const program = first.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() ?? "";
  const allowed = READ_ONLY_PROGRAMS.get(program);
  if (!allowed) return undefined;
  const sub = (tokens.slice(1).find((token) => !token.startsWith("-") && !token.startsWith("/")) ?? "").toLowerCase();
  if (allowed.size > 0 && sub !== "" && !allowed.has(sub)) return undefined;
  return { program, sub };
}
export interface FamilyGrant {
  kind: FamilyKind;
  label: string;
  expiresAt: number;
  /** 建立这条族放行的授权 id——授权被撤销后族立即失效（否则「收回了还在免问」） */
  leaseId?: string;
}
/** 作用：族的放行窗口——只有「最近一次人工批准 + TTL 内」有效，过期立刻失效（不是安全机制之外的状态）。 */
export class FamilyGrantStore {
  private readonly grants = new Map<string, FamilyGrant>();
  grant(refs: readonly FamilyRef[], ttlSeconds: number, now: number, leaseId?: string): void {
    const expiresAt = now + ttlSeconds * 1000;
    for (const ref of refs) this.grants.set(ref.key, { kind: ref.kind, label: ref.label, expiresAt, leaseId });
  }
  match(refs: readonly FamilyRef[], now: number, kinds?: readonly FamilyKind[], isLive?: (leaseId: string) => boolean): FamilyGrant | undefined {
    // 作用：按「最具体优先」匹配——对象 > 目录 > 前缀 > 只读命令 > 程序 > 工具（越具体越先命中）。
    // 【前缀族是 ALL 语义】复合命令拆出来的每个子命令都必须已有放行，才允许整条脚本免问
    //（等价于 Claude Code：`a && b` 需要 a、b 都被允许）。
    const order: FamilyKind[] = kinds ? [...kinds] : ["object", "dir", "prefix", "command", "program", "tool"];
    const live = (grant: FamilyGrant | undefined): grant is FamilyGrant => {
      if (!grant) return false;
      if (grant.expiresAt <= now) return false;
      if (grant.leaseId !== undefined && isLive !== undefined && !isLive(grant.leaseId)) return false;
      return true;
    };
    for (const kind of order) {
      const ofKind = refs.filter((ref) => ref.kind === kind);
      if (ofKind.length === 0) continue;
      if (kind === "prefix") {
        const granted = ofKind.map((ref) => this.grants.get(ref.key));
        // 任一子命令没有有效放行 → 整条脚本不走前缀复用
        if (granted.every((grant) => live(grant))) return granted[0];
        continue;
      }
      for (const ref of ofKind) {
        const grant = this.grants.get(ref.key);
        if (live(grant)) return grant;
        if (grant) this.grants.delete(ref.key);
      }
    }
    return undefined;
  }
  clear(): void {
    this.grants.clear();
  }
  get size(): number {
    return this.grants.size;
  }
  gc(now: number): number {
    let removed = 0;
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
