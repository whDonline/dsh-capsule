import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditService } from "./audit-service.js";
import { AuditJournal } from "./journal.js";
import type { CapabilityLease } from "../capability/types.js";
function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-guard-journal-")), "audit.ndjson");
}
const lease: CapabilityLease = {
  id: "lease-1",
  sessionId: "s1",
  toolName: "pwsh",
  kind: "universal",
  scope: { kind: "exact-arguments", key: "k1", display: "pwsh(command)" },
  status: "ACTIVE",
  issuedAt: 1_000,
  expiresAt: 301_000,
};
describe("审计持久化（NDJSON 追加 + 启动重放）", () => {
  it("事件与授权都能落盘并读回（顺序保持）", () => {
    const journal = new AuditJournal(tempFile());
    journal.append({ type: "lease", lease });
    journal.append({ type: "event", event: { id: "e1", timestamp: 1_000, callId: "c1", rootCallId: "c1", toolName: "pwsh", decision: "LEASE_ISSUED", sessionId: "s1" } });
    const records = journal.load();
    expect(records.map((item) => item.type)).toEqual(["lease", "event"]);
    expect(records[1]).toMatchObject({ type: "event", event: { decision: "LEASE_ISSUED" } });
  });
  it("坏行（半行 / 非法 JSON）跳过，不丢其余历史", () => {
    const file = tempFile();
    const journal = new AuditJournal(file);
    journal.append({ type: "lease", lease });
    writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"event"\n`, "utf8");
    journal.append({ type: "event", event: { id: "e2", timestamp: 2_000, callId: "c2", rootCallId: "c2", toolName: "read", decision: "ASK" } });
    expect(journal.load()).toHaveLength(2);
  });
  it("超过上限时轮转成 .1（只保留一代）", () => {
    const file = tempFile();
    const journal = new AuditJournal(file, 64);
    for (let index = 0; index < 8; index += 1) {
      journal.append({ type: "event", event: { id: `e${index}`, timestamp: index, callId: `c${index}`, rootCallId: `c${index}`, toolName: "pwsh", decision: "ASK" } });
    }
    expect(existsSync(`${file}.1`)).toBe(true);
    // 轮转后的新文件仍然可读（历史不会因为轮转变成非法文件）
    expect(journal.load().length).toBeGreaterThan(0);
  });
  it("AuditService.restore 保留原始 id 与时间戳，并遵守容量上限", () => {
    const service = new AuditService(2);
    service.restore([
      { id: "a", timestamp: 1, callId: "c1", rootCallId: "c1", toolName: "t", decision: "ASK" },
      { id: "b", timestamp: 2, callId: "c2", rootCallId: "c2", toolName: "t", decision: "ASK" },
      { id: "c", timestamp: 3, callId: "c3", rootCallId: "c3", toolName: "t", decision: "ASK" },
    ]);
    expect(service.list().map((event) => event.id)).toEqual(["b", "c"]);
  });
  it("record 会触发落盘回调（审计持久化的接线点）", () => {
    const written: string[] = [];
    const service = new AuditService(10, (event) => written.push(event.id));
    const event = service.record({ callId: "c1", rootCallId: "c1", toolName: "pwsh", decision: "ASK" });
    expect(written).toEqual([event.id]);
  });
});
