import { describe, expect, it } from "vitest";
import {
  commandMentionsRule,
  createSensitivePathGuard,
  defaultSensitiveRules,
  judgeSensitivePath,
  matchSensitivePath,
  normalizePath,
  parseExtraRules,
  type SensitivePathContext,
} from "./sensitive-paths.js";
import type { ToolExecutionLike } from "./types.js";
const WIN: SensitivePathContext = { home: "C:\\Users\\tester", platform: "win32", workspaceRoot: "C:\\work\\proj" };
const POSIX: SensitivePathContext = { home: "/Users/tester", platform: "darwin", workspaceRoot: "/work/proj" };
const exec = (name: string, args: Record<string, unknown>): ToolExecutionLike => ({ callId: "c1", rootCallId: "c1", name, arguments: args, agent: { id: "s1" } });
const rules = defaultSensitiveRules(WIN);
describe("敏感路径规范化（跨平台语义由 platform 参数决定）", () => {
  it("展开 ~ 并统一分隔符；win32 统一小写", () => {
    expect(normalizePath("~/.ssh", WIN)).toBe("c:\\users\\tester\\.ssh");
    expect(normalizePath("~/.ssh/id_rsa", POSIX)).toBe("/Users/tester/.ssh/id_rsa");
    expect(normalizePath("C:/Users/Tester/.ssh/", WIN)).toBe("c:\\users\\tester\\.ssh");
  });
  it("相对路径按会话工作区根解析（无工作区根时用 cwd）", () => {
    expect(normalizePath("sub/file.txt", WIN)).toBe("c:\\work\\proj\\sub\\file.txt");
    expect(normalizePath("sub/file.txt", { platform: "linux", workspaceRoot: "/work/proj" })).toBe("/work/proj/sub/file.txt");
  });
});
describe("前缀匹配与 scope 语义", () => {
  it("目录本身与其子路径命中；同名前缀的兄弟目录不命中", () => {
    expect(matchSensitivePath("C:\\Users\\tester\\.ssh", rules, WIN)?.id).toBe("ssh-private-keys");
    expect(matchSensitivePath("C:\\Users\\tester\\.ssh\\id_rsa", rules, WIN)?.id).toBe("ssh-private-keys");
    expect(matchSensitivePath("C:\\Users\\tester\\.ssh-backup\\id_rsa", rules, WIN)).toBeUndefined();
    expect(matchSensitivePath("C:\\Users\\tester\\Desktop\\a.txt", rules, WIN)).toBeUndefined();
  });
  it("deny-write 只拦写：读工具放行、写工具拒绝", () => {
    expect(judgeSensitivePath(exec("read", { path: "C:\\Users\\tester\\.dsh\\settings.json" }), rules, WIN)).toBeUndefined();
    expect(judgeSensitivePath(exec("write", { path: "C:\\Users\\tester\\.dsh\\settings.json" }), rules, WIN)?.rule.id).toBe("dsh-config-write");
  });
  it("deny 规则读也拦：read 命中 SSH 私钥目录", () => {
    const hit = judgeSensitivePath(exec("read", { file_path: "C:\\Users\\tester\\.ssh\\id_rsa" }), rules, WIN);
    expect(hit).toMatchObject({ rule: { id: "ssh-private-keys" }, heuristic: false, operation: "read" });
  });
  it("没有路径参数 / 不认识的工具：不判定（交给 DSH 原生）", () => {
    expect(judgeSensitivePath(exec("read", { url: "https://example.com" }), rules, WIN)).toBeUndefined();
    expect(judgeSensitivePath(exec("web_fetch", { url: "https://example.com" }), rules, WIN)).toBeUndefined();
  });
});
describe("命令文本扫描（启发式）", () => {
  it("命中 ~ 形式与绝对路径形式", () => {
    expect(commandMentionsRule("Get-Content ~/.ssh/id_rsa", rules[0]!, WIN)).toBeTruthy();
    expect(commandMentionsRule("Set-Content C:\\Users\\tester\\.ssh\\authorized_keys x", rules[0]!, WIN)).toBeTruthy();
  });
  it("边界判断避免误伤：.ssh-backup / my.ssh / C:\\secrets-backup", () => {
    expect(commandMentionsRule("Get-Content C:\\Users\\tester\\.ssh-backup\\a", rules[0]!, WIN)).toBeUndefined();
    expect(commandMentionsRule("Get-Content my.ssh", rules[0]!, WIN)).toBeUndefined();
    const secrets = { id: "s", path: "C:\\secrets", scope: "deny" as const };
    expect(commandMentionsRule("type C:\\secrets-backup\\a.txt", secrets, WIN)).toBeUndefined();
    expect(commandMentionsRule("type C:\\secrets\\a.txt", secrets, WIN)).toBeTruthy();
  });
  it("命令类工具一律按 write 处理：deny-write 规则也会拦（宁严勿松）", () => {
    const hit = judgeSensitivePath(exec("pwsh", { command: "Get-Content ~/.dsh/settings.json" }), rules, WIN);
    expect(hit).toMatchObject({ rule: { id: "dsh-config-write" }, heuristic: true, operation: "write" });
  });
});
describe("guard 包装", () => {
  it("命中返回中文理由并回调审计；未命中返回 undefined", () => {
    const seen: string[] = [];
    const guard = createSensitivePathGuard({ rules, context: WIN, onDeny: (_exec, hit) => seen.push(hit.rule.id) });
    const reason = guard(exec("write", { path: "C:\\Users\\tester\\.ssh\\config" }));
    expect(reason).toContain("ssh-private-keys");
    expect(reason).toContain("不是沙箱");
    expect(seen).toEqual(["ssh-private-keys"]);
    expect(guard(exec("read", { path: "C:\\work\\proj\\a.ts" }))).toBeUndefined();
  });
  it("命令命中时理由必须标注启发式；审计回调抛错不影响拒绝", () => {
    const guard = createSensitivePathGuard({
      rules,
      context: WIN,
      onDeny: () => {
        throw new Error("audit down");
      },
    });
    const reason = guard(exec("pwsh", { command: "Remove-Item ~/.ssh/id_rsa" }));
    expect(reason).toContain("启发式");
    expect(reason).toContain("可被刻意规避绕过");
  });
  it("判定内部异常时返回 undefined（不因插件 bug 拒绝一切）", () => {
    const guard = createSensitivePathGuard({ rules, context: WIN });
    const hostile = { get name(): string { throw new Error("boom"); } } as unknown as ToolExecutionLike;
    expect(guard(hostile)).toBeUndefined();
  });
});
describe("配置解析与内置规则", () => {
  it("额外规则：非法项忽略，scope 缺省为 deny-write", () => {
    const parsed = parseExtraRules([
      { path: "D:\\secrets" },
      { path: "D:\\readonly", scope: "deny" },
      { path: "" },
      { path: "D:\\bad", scope: "allow" },
      null,
      "x",
    ]);
    expect(parsed).toEqual([
      { id: "custom-1", path: "D:\\secrets", scope: "deny-write" },
      { id: "custom-2", path: "D:\\readonly", scope: "deny" },
    ]);
  });
  it("内置规则覆盖 SSH / 云凭据 / 浏览器配置，且 DSH 配置目录只禁写", () => {
    const win = defaultSensitiveRules(WIN);
    const ids = win.map((rule) => rule.id);
    expect(ids).toEqual(expect.arrayContaining(["ssh-private-keys", "aws-credentials", "chrome-profile", "edge-profile"]));
    expect(win.find((rule) => rule.id === "dsh-config-write")?.scope).toBe("deny-write");
    expect(defaultSensitiveRules(POSIX).some((rule) => rule.path.includes("Library"))).toBe(true);
    expect(defaultSensitiveRules({ platform: "linux", home: "/home/t" }).some((rule) => rule.path.includes(".config/google-chrome"))).toBe(true);
  });
});
