import { randomUUID } from "node:crypto";
import type { ToolAuditEvent } from "./types.js";
// 作用：内存 Ring Buffer 审计服务（重构规格第 9 节）——V1 第一版内存实现即可；
// 事件结构由 ToolAuditEvent 类型约束，Secret/原始参数在类型层就不存在。
export class AuditService {
  private events: ToolAuditEvent[] = [];
  constructor(
    private readonly capacity: number = 1000,
    /** 可选：每条事件的落盘回调（审计持久化）——抛错绝不打断记录 */
    private readonly onRecord?: (event: ToolAuditEvent) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("AUDIT_INVALID: capacity must be a positive integer");
    }
  }
  record(event: Omit<ToolAuditEvent, "id" | "timestamp">): ToolAuditEvent {
    // 作用：记录一条审计事件（自动生成 id 与 timestamp），超出容量时丢弃最旧记录
    const full: ToolAuditEvent = { ...event, id: randomUUID(), timestamp: Date.now() };
    this.events.push(full);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    if (this.onRecord) {
      try {
        this.onRecord(full);
      } catch {
        // 落盘失败不影响审计内存记录
      }
    }
    return full;
  }
  list(limit?: number): ToolAuditEvent[] {
    // 作用：读取审计事件（最新在前返回最近 limit 条；不传即全量拷贝）
    if (limit === undefined) return [...this.events];
    return this.events.slice(Math.max(0, this.events.length - limit));
  }
  restore(events: readonly ToolAuditEvent[]): void {
    // 作用：从持久化日志重放历史事件（保留原始 id 与 timestamp），超出容量同样丢最旧
    for (const event of events) this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }
}
