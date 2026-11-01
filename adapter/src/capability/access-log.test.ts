import { describe, expect, it } from "vitest";
import { AccessLog, directoryOf, isOutsideWorkspace, toolPathOf } from "./access-log.js";
const WIN = { home: "C:\\Users\\tester", platform: "win32" as const, workspaceRoot: "C:\\work\\proj" };
describe("工作区外访问：路径提取与边界", () => {
  it("只识别文件类工具与标准路径参数", () => {
    expect(toolPathOf("write", { path: "C:\\out\\a.txt" })).toEqual({ path: "C:\\out\\a.txt", operation: "write" });
    expect(toolPathOf("edit", { file_path: "C:\\out\\a.txt" })).toMatchObject({ operation: "write" });
    expect(toolPathOf("read", { filePath: "C:\\out\\a.txt" })).toMatchObject({ operation: "read" });
    expect(toolPathOf("pwsh", { command: "Set-Content C:\\out\\a" })).toBeUndefined();
    expect(toolPathOf("web_fetch", { url: "https://example.com" })).toBeUndefined();
    expect(toolPathOf("read", { url: "https://example.com" })).toBeUndefined();
  });
  it("工作区内/外判定：同名前缀的兄弟目录算外面", () => {
    expect(isOutsideWorkspace("C:\\work\\proj\\a.ts", "C:\\work\\proj", WIN)).toBe(false);
    expect(isOutsideWorkspace("C:\\work\\proj", "C:\\work\\proj", WIN)).toBe(false);
    expect(isOutsideWorkspace("C:\\work\\proj2\\a.ts", "C:\\work\\proj", WIN)).toBe(true);
    expect(isOutsideWorkspace("C:\\Users\\tester\\a.ts", "C:\\work\\proj", WIN)).toBe(true);
  });
  it("工作区根未知：不判定（返回 undefined，绝不猜）", () => {
    expect(isOutsideWorkspace("C:\\out\\a.ts", "", WIN)).toBeUndefined();
    expect(isOutsideWorkspace("C:\\out\\a.ts", "   ", WIN)).toBeUndefined();
  });
  it("目录聚合去掉文件名", () => {
    expect(directoryOf("C:\\out\\deep\\a.ts", WIN)).toBe("c:\\out\\deep");
    expect(directoryOf("C:\\out\\", WIN)).toBe("c:\\out");
  });
});
describe("AccessLog（内存、按会话、有界）", () => {
  it("同一目录多次访问聚合为一行，带次数与最近时间；不同会话隔离", () => {
    let now = 1_000;
    const log = new AccessLog(10, () => now);
    log.record({ sessionId: "s1", toolName: "read", dir: "c:\\out", operation: "read" });
    now = 2_000;
    log.record({ sessionId: "s1", toolName: "write", dir: "c:\\out", operation: "write" });
    now = 3_000;
    log.record({ sessionId: "s1", toolName: "read", dir: "d:\\other", operation: "read" });
    log.record({ sessionId: "s2", toolName: "read", dir: "e:\\x", operation: "read" });
    const view = log.view("s1");
    expect(view.total).toBe(3);
    expect(view.dirs).toEqual([
      { dir: "d:\\other", count: 1, lastAt: 3_000 },
      { dir: "c:\\out", count: 2, lastAt: 2_000 },
    ]);
    expect(log.view("s2").dirs).toEqual([{ dir: "e:\\x", count: 1, lastAt: 3_000 }]);
    expect(log.view("missing")).toEqual({ total: 0, dirs: [] });
  });
  it("有界淘汰：超过上限丢最旧记录；view 最多 12 个目录", () => {
    const log = new AccessLog(5, () => 1);
    for (let index = 0; index < 8; index += 1) {
      log.record({ sessionId: "s1", toolName: "read", dir: `d:\\dir${index}`, operation: "read" });
    }
    expect(log.size()).toBe(5);
    expect(log.view("s1").dirs.map((item) => item.dir)).not.toContain("d:\\dir0");
    const wide = new AccessLog(100, () => 1);
    for (let index = 0; index < 20; index += 1) {
      wide.record({ sessionId: "s1", toolName: "read", dir: `d:\\dir${index}`, operation: "read" });
    }
    expect(wide.view("s1").dirs).toHaveLength(12);
    wide.clear();
    expect(wide.view("s1")).toEqual({ total: 0, dirs: [] });
  });
});
