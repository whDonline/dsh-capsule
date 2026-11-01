import { posix, win32 } from "node:path";
import { normalizePath, type SensitivePathContext } from "./sensitive-paths.js";
// 作用：工作区外访问记录（2026-11-01，P1）——回答「开了权限之后，AI 到底碰过工作区外的哪些地方」。
//
// 【隐私】只记录**目录**（不记文件名、不记完整参数），且只记工作区外的访问；默认开启，可用
// `accessLog: false` 关闭。日志只在本机内存 + 审计事件里（审计同样只写目录），不会联网。
// 【定位】这是可观测性，不是安全机制：它不参与任何允许/拒绝判定，也不能替代沙箱。
// 【边界】只覆盖文件路径类工具（read / write / edit / glob / grep）；命令类工具无法可靠拿到目标路径，
// 不记录（避免把命令里的任意字符串误当成路径）。
export interface AccessEntry {
  at: number;
  sessionId: string;
  toolName: string;
  /** 规范化后的目录（不含文件名） */
  dir: string;
  operation: "read" | "write";
}
export interface AccessDirSummary {
  dir: string;
  count: number;
  lastAt: number;
}
export interface AccessLogView {
  /** 工作区外访问总次数（只统计被记录的） */
  total: number;
  /** 按目录聚合，最近访问在前（最多 12 条，避免快照无限增长） */
  dirs: readonly AccessDirSummary[];
}
const FS_READ_TOOLS = new Set(["read", "glob", "grep"]);
const FS_WRITE_TOOLS = new Set(["write", "edit"]);
const VIEW_DIR_LIMIT = 12;
/** 作用：按平台取路径 API（与 sensitive-paths 一致，便于跨平台测试）。 */
function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}
/** 作用：从文件类工具的参数里取目标路径与操作类别；非文件工具返回 undefined。 */
export function toolPathOf(toolName: string, args: unknown): { path: string; operation: "read" | "write" } | undefined {
  const operation = FS_READ_TOOLS.has(toolName) ? "read" : FS_WRITE_TOOLS.has(toolName) ? "write" : undefined;
  if (!operation || typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return { path: value, operation };
  }
  return undefined;
}
/** 作用：判断目标是否在工作区之外；工作区根未知时返回 undefined（不猜测，也不记录）。 */
export function isOutsideWorkspace(target: string, workspaceRoot: string, context: SensitivePathContext = {}): boolean | undefined {
  const platform = context.platform ?? process.platform;
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) return undefined;
  const p = pathApi(platform);
  const root = normalizePath(workspaceRoot, { ...context, platform });
  const path = normalizePath(target, { ...context, platform, workspaceRoot });
  if (root.length === 0 || path.length === 0) return undefined;
  return !(path === root || path.startsWith(`${root}${p.sep}`));
}
/** 作用：取目录（用于聚合；不含文件名）。 */
export function directoryOf(target: string, context: SensitivePathContext = {}): string {
  const platform = context.platform ?? process.platform;
  const p = pathApi(platform);
  const normalized = normalizePath(target, { ...context, platform });
  // 调用方以分隔符结尾时，明确表示"这是目录"——不要再多取一层父目录
  if (/[\\/]$/.test(target.trim())) return normalized;
  const dir = p.dirname(normalized);
  return dir === "." ? normalized : dir;
}
/** 作用：有界的会话级访问记录——内存态，进程退出即消失；只做展示与审计，不参与判定。 */
export class AccessLog {
  private readonly entries: AccessEntry[] = [];
  private readonly now: () => number;
  constructor(
    private readonly limit = 500,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }
  record(entry: Omit<AccessEntry, "at">): void {
    // 作用：追加一条记录并做有界淘汰（只保留最近 limit 条）
    this.entries.push({ ...entry, at: this.now() });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }
  view(sessionId: string): AccessLogView {
    // 作用：按会话聚合到目录级——同一目录多次访问只占一行，附次数与最近时间
    const bucket = new Map<string, AccessDirSummary>();
    let total = 0;
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      total += 1;
      const existing = bucket.get(entry.dir);
      if (existing) {
        existing.count += 1;
        existing.lastAt = Math.max(existing.lastAt, entry.at);
      } else {
        bucket.set(entry.dir, { dir: entry.dir, count: 1, lastAt: entry.at });
      }
    }
    const dirs = [...bucket.values()].sort((a, b) => b.lastAt - a.lastAt || b.count - a.count).slice(0, VIEW_DIR_LIMIT);
    return { total, dirs };
  }
  size(): number {
    return this.entries.length;
  }
  clear(): void {
    this.entries.length = 0;
  }
}
