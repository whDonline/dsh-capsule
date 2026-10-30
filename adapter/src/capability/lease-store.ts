import type { CapabilityLease, LeaseKind } from "./types.js";
// 作用：LeaseStore 抽象与内存实现（重构规格第 5.6 节）——V1 用 MemoryLeaseStore 即可
//（Lease 是短生命周期权限，进程重启全部失效 = Fail Closed）；接口抽象保证未来可换
// DshStorageLeaseStore / SQLiteLeaseStore / JsonLeaseStore 而不改核心逻辑。
export interface LeaseQuery {
  sessionId: string;
  toolName: string;
  scopeKey: string;
  kind?: LeaseKind;
}
export interface LeaseStore {
  insert(lease: CapabilityLease): void | Promise<void>;
  findMatching(query: LeaseQuery): CapabilityLease | undefined | Promise<CapabilityLease | undefined>;
  get(id: string): CapabilityLease | undefined | Promise<CapabilityLease | undefined>;
  revoke(id: string, reason?: string): boolean | Promise<boolean>;
  revokeSession(sessionId: string, reason?: string): number | Promise<number>;
  list(): CapabilityLease[] | Promise<CapabilityLease[]>;
}
export class MemoryLeaseStore implements LeaseStore {
  private buckets = new Map<string, CapabilityLease[]>();
  private byId = new Map<string, CapabilityLease>();
  constructor(private readonly now: () => number = Date.now) {}
  insert(lease: CapabilityLease): void {
    // 作用：写入 Lease——同桶按插入序追加，桶尾即最新（findMatching 只认最新一条 ACTIVE）
    const bucketKey = bucketKeyOf(lease.sessionId, lease.toolName, lease.scope.key);
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      this.buckets.set(bucketKey, bucket);
    }
    bucket.push(lease);
    this.byId.set(lease.id, lease);
  }
  findMatching(query: LeaseQuery): CapabilityLease | undefined {
    // 作用：查找匹配 Lease——只看桶内最后一条且必须 ACTIVE；最新一条已撤销/过期即视为无 Lease
    //（Fail Closed：不回退复用更早的 ACTIVE 记录，撤销语义立即生效）
    const bucket = this.buckets.get(bucketKeyOf(query.sessionId, query.toolName, query.scopeKey));
    if (!bucket || bucket.length === 0) return undefined;
    const latest = bucket[bucket.length - 1];
    if (!latest || latest.status !== "ACTIVE") return undefined;
    if (query.kind !== undefined && latest.kind !== query.kind) return undefined;
    return latest;
  }
  get(id: string): CapabilityLease | undefined {
    return this.byId.get(id);
  }
  revoke(id: string, reason?: string): boolean {
    // 作用：按 id 撤销 ACTIVE Lease——立即生效；不存在或非 ACTIVE 返回 false
    const lease = this.byId.get(id);
    if (!lease || lease.status !== "ACTIVE") return false;
    lease.status = "REVOKED";
    lease.revokedAt = this.now();
    lease.revokeReason = reason;
    return true;
  }
  revokeSession(sessionId: string, reason?: string): number {
    // 作用：撤销某 Session 全部 ACTIVE Lease（Session disposed 时调用），返回撤销数量
    let count = 0;
    for (const lease of this.byId.values()) {
      if (lease.sessionId === sessionId && lease.status === "ACTIVE") {
        lease.status = "REVOKED";
        lease.revokedAt = this.now();
        lease.revokeReason = reason;
        count += 1;
      }
    }
    return count;
  }
  list(): CapabilityLease[] {
    return [...this.byId.values()];
  }
  gc(now: number = this.now(), maxAgeMs: number = 3_600_000): number {
    // 作用：低频内存回收——删除过期超过 1 小时的记录（规格第 5.8 节）；
    // GC 只是内存回收不是安全机制，正确性完全依赖 find/validate 时的实时时间比较
    const doomed: CapabilityLease[] = [];
    for (const lease of this.byId.values()) {
      if (lease.expiresAt + maxAgeMs <= now) doomed.push(lease);
    }
    for (const lease of doomed) this.remove(lease);
    return doomed.length;
  }
  private remove(lease: CapabilityLease): void {
    // 作用：从 byId 与所属桶中移除一条记录
    this.byId.delete(lease.id);
    const bucketKey = bucketKeyOf(lease.sessionId, lease.toolName, lease.scope.key);
    const bucket = this.buckets.get(bucketKey);
    if (!bucket) return;
    const index = bucket.indexOf(lease);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) this.buckets.delete(bucketKey);
  }
}
function bucketKeyOf(sessionId: string, toolName: string, scopeKey: string): string {
  // 作用：桶键——Session × Tool × Scope 三元组精确隔离（\u0000 分隔避免拼接歧义）
  return `${sessionId}\u0000${toolName}\u0000${scopeKey}`;
}
