import type { ConsoleSessionDescriptor, ConsoleSessionDirectory } from "./types.js";
// 作用：把 DSH 的会话元数据（标题 / 工作目录）收敛成「会话显示名」，供治理台首屏展示。
// 【为什么单独一层】治理台只关心「这个 sessionId 叫什么」，而 DSH 的会话由 `ctx.sessions`（活跃会话表）
// 与 `ctx.sessionTitle`（日志折叠出的标题）两个可选服务提供；两者都可能不存在（headless / 精简组合），
// 因此这里全部按「能力可选」处理：任何一步失败都降级为短 ID，绝不抛错、绝不阻塞治理台。
// 【只读】只调用 get，不写入、不 rename、不触发标题生成（refresh）——治理台无权改动会话。
type HostLike = {
  get?(name: string): unknown;
};
/** 缓存时长（毫秒）——一次快照里同一会话可能被多次描述，短缓存足够；标题变化不频繁。 */
const CACHE_TTL_MS = 2_000;
/** 缓存条数上限（防止长时间运行后无界增长）。 */
const CACHE_LIMIT = 200;
export function createHostSessionDirectory(hostCtx: HostLike, now: () => number = Date.now): ConsoleSessionDirectory {
  const cache = new Map<string, { at: number; value: ConsoleSessionDescriptor }>();
  return {
    describe(sessionId: string): ConsoleSessionDescriptor {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { label: "未知会话", source: "id" };
      }
      const cached = cache.get(sessionId);
      if (cached && now() - cached.at < CACHE_TTL_MS) return cached.value;
      const value = resolveDescriptor(hostCtx, sessionId);
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (typeof oldest === "string") cache.delete(oldest);
      }
      cache.set(sessionId, { at: now(), value });
      return value;
    },
  };
}
function resolveDescriptor(hostCtx: HostLike, sessionId: string): ConsoleSessionDescriptor {
  // 作用：按「标题 → 工作目录 → 短 ID」三级降级解析会话显示名
  const session = findSession(hostCtx, sessionId);
  const cwd = sessionCwd(session);
  const title = sessionTitle(hostCtx, session);
  if (title) return { label: title, source: "title", cwd };
  if (cwd) return { label: basename(cwd), source: "cwd", cwd };
  return { label: `会话 ${sessionId.slice(0, 8)}`, source: "id" };
}
function findSession(hostCtx: HostLike, sessionId: string): unknown {
  // 作用：从 ctx.sessions（活跃会话表）取 Session 对象；服务或方法缺失、抛错一律返回 undefined
  const sessions = hostService(hostCtx, "sessions") as { get?: unknown } | undefined;
  if (!sessions || typeof sessions.get !== "function") return undefined;
  try {
    return (sessions.get as (id: string) => unknown).call(sessions, sessionId);
  } catch {
    return undefined;
  }
}
function sessionCwd(session: unknown): string | undefined {
  // 作用：读 SessionHeader.cwd（DSH 类型定义：Session.header.cwd?: string）——不存在就是没有
  if (!session || typeof session !== "object") return undefined;
  const header = (session as { header?: unknown }).header;
  if (!header || typeof header !== "object") return undefined;
  const cwd = (header as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}
function sessionTitle(hostCtx: HostLike, session: unknown): string | undefined {
  // 作用：读 ctx.sessionTitle.get(session) 的标题（SessionTitleSnapshot.title）；
  // 会话对象缺失、服务缺失或标题为空时返回 undefined
  if (!session) return undefined;
  const titles = hostService(hostCtx, "sessionTitle") as { get?: unknown } | undefined;
  if (!titles || typeof titles.get !== "function") return undefined;
  try {
    const snapshot = (titles.get as (s: unknown) => unknown).call(titles, session);
    if (!snapshot || typeof snapshot !== "object") return undefined;
    const title = (snapshot as { title?: unknown }).title;
    if (typeof title !== "string") return undefined;
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
function hostService(hostCtx: HostLike, name: string): unknown {
  // 作用：按 cordis 的方式解析宿主服务——只走 ctx.get(name)（缺失返回 undefined，不抛错）
  const get = hostCtx?.get;
  if (typeof get !== "function") return undefined;
  try {
    return get.call(hostCtx, name);
  } catch {
    return undefined;
  }
}
function basename(path: string): string {
  // 作用：取目录名（Windows / POSIX 两种分隔符都支持），空路径原样返回
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
