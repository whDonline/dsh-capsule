// 作用：按 callId 记录「这一次调用是什么操作」——approval/request 的载荷不含 tool arguments
//（集成基线第 2 条），所以只能在 tools/execute 阶段（arguments 可用）把指纹记下来，等审批到达时按
// callId 反查。记录有界、按时间回收：它只是短命上下文，不是持久状态。
import type { SandboxMode } from "./escalation.js";
import type { FamilyRef } from "./families.js";
export interface RecordedOperation {
  callId: string;
  sessionId: string;
  toolName: string;
  /** 操作指纹（与 Lease.scope.key 同一算法） */
  key: string;
  /** 可安全展示的描述（只有参数键名） */
  display: string;
  mode?: SandboxMode;
  /** 这次调用所属的操作族（② 同族模式用；可能为空） */
  families?: readonly FamilyRef[];
  /** 这条命令里含破坏性程序：本次调用**永不走族复用**（只能精确匹配） */
  blocked?: boolean;
  recordedAt: number;
}
/** 记录最长存活时间：一次调用的审批往返远小于它，超过即视为「工具早已结束、callId 被重放」。 */
export const OPERATION_RECORD_TTL_MS = 10 * 60_000;
export class OperationRegistry {
  private readonly byCallId = new Map<string, RecordedOperation>();
  constructor(private readonly limit = 512) {}
  set(record: RecordedOperation): void {
    // 作用：写入并做有界淘汰（Map 保持插入顺序，超限时丢最旧的一条）
    if (this.byCallId.size >= this.limit && !this.byCallId.has(record.callId)) {
      const oldest = this.byCallId.keys().next();
      if (!oldest.done) this.byCallId.delete(oldest.value);
    }
    this.byCallId.set(record.callId, record);
  }
  get(callId: string): RecordedOperation | undefined {
    return this.byCallId.get(callId);
  }
  delete(callId: string): void {
    this.byCallId.delete(callId);
  }
  clear(): void {
    this.byCallId.clear();
  }
  get size(): number {
    return this.byCallId.size;
  }
  gc(now: number, maxAgeMs: number = OPERATION_RECORD_TTL_MS): number {
    // 作用：回收超龄记录（低频调用即可，不做定时器）
    let removed = 0;
    for (const [callId, record] of this.byCallId) {
      if (now - record.recordedAt > maxAgeMs) {
        this.byCallId.delete(callId);
        removed += 1;
      }
    }
    return removed;
  }
}
