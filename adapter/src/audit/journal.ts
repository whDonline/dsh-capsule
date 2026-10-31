// 作用：审计持久化——把「事件」与「授权」追加写入本地 NDJSON，重启时重放回内存。
//
// 为什么需要：V1 的 AuditService 是内存 Ring Buffer（1000 条），DSH 一重启就全丢，
// 用户看不到「上周批准过什么、复用了几次」。持久化后重启仍能看到历史。
//
// 为什么是「事件 + 授权」两种记录：面向人的「授权决策记录」是由 Lease + 审计事件折叠出来的
// （console/decisions.ts），只存事件会让重启后的决策列表变空，所以两类都要留。
//
// 隐私：事件里本来就只有工具名 / scope 哈希 / 脱敏展示串，没有任何参数原文与 Secret；
// 展示串可能含路径（例如「同一对象 D:\proj\a.ts」），仍属于本机数据，不落任何远端。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { CapabilityLease } from "../capability/types.js";
import type { ToolAuditEvent } from "./types.js";
export type JournalRecord = { type: "event"; event: ToolAuditEvent } | { type: "lease"; lease: CapabilityLease };
/** 单文件上限：超过后轮转成 `<file>.1`（只保留一代），避免无限增长。 */
export const DEFAULT_JOURNAL_MAX_BYTES = 20 * 1024 * 1024;
export class AuditJournal {
  private warned = false;
  constructor(private readonly filePath: string, private readonly maxBytes: number = DEFAULT_JOURNAL_MAX_BYTES) {}
  append(record: JournalRecord): void {
    // 作用：追加一行 JSON——写失败只静默（绝不影响审批主链路），首次失败在 stderr 提一次
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`[dsh-guard] audit journal write failed: ${String(err)}\n`);
      }
    }
  }
  load(): JournalRecord[] {
    // 作用：读取并解析历史——坏行（半行 / 手动编辑）直接跳过，绝不因为一条脏数据丢掉全部历史
    if (!existsSync(this.filePath)) return [];
    const records: JournalRecord[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as JournalRecord;
        if (parsed && (parsed.type === "event" || parsed.type === "lease")) records.push(parsed);
      } catch {
        // 忽略坏行
      }
    }
    return records;
  }
  private rotateIfNeeded(): void {
    // 作用：超过上限就把当前文件改名为 <file>.1 再重新开始（只保留一代，够用且实现简单）
    try {
      const size = statSync(this.filePath).size;
      if (size >= this.maxBytes) renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // 文件不存在或改名失败：下次再试
    }
  }
}
