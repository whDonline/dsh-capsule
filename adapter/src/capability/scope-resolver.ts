import { canonicalize, sha256Scope } from "./canonical.js";
import { GuardError } from "./errors.js";
import { parseEscalation } from "./escalation.js";
import { operationFingerprint } from "./operation.js";
import type { ResolvedToolPolicy } from "./policy.js";
import type { CapabilityScope } from "./types.js";
// 作用：Scope Resolver（重构规格第 5.4 节）——用确定性规则生成 Scope，禁止 LLM/字符串启发式
// 猜测 Provider/Resource/Action；三种模式：exact-arguments（默认最保守）/ fields（用户显式配置）/
// tool（最宽）。
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|cookie|credential|api[_-]?key)/i;
const DISPLAY_MAX_LENGTH = 160;
export class ScopeResolver {
  resolve(input: { toolName: string; arguments: unknown }, policy: ResolvedToolPolicy): CapabilityScope {
    // 作用：按 policy.scope 生成 CapabilityScope；任何解析失败抛错（上层 Fail Closed：不接管、不签发 Lease）
    const mode = policy.scope.mode;
    if (mode === "exact-arguments") return this.resolveExactArguments(input.toolName, input.arguments);
    if (mode === "fields") return this.resolveFields(input.toolName, input.arguments, (policy.scope as { paths: string[] }).paths);
    if (mode === "tool") return this.resolveToolLevel(input.toolName);
    throw new GuardError("LEASE_SCOPE_INVALID", `unsupported scope mode ${String(mode)}`);
  }
  private resolveExactArguments(toolName: string, args: unknown): CapabilityScope {
    // 作用：默认零配置策略——复用单位就是「同一条操作」：工具名 + 参数（去掉模型自由文本 justification）
    // + 目标沙箱档位。与 tools/execute 记录的操作指纹逐字一致，因此 pre-execute 的复用判断与
    // approval/request 签发的授权永远指向同一个 key（2026-11-01 对齐；此前两条路径各算一套，互不命中）。
    const fingerprint = operationFingerprint(toolName, args, parseEscalation(args)?.requestedMode);
    return { kind: "exact-arguments", key: fingerprint.key, display: fingerprint.display };
  }
  private resolveFields(toolName: string, args: unknown, paths: string[]): CapabilityScope {
    // 作用：用户显式配置的宽 scope——只对指定字段生成 Scope，其余字段变化可复用（规格 5.4.2）；
    // 任一指定字段缺失即抛错（无法确定 Scope，Fail Closed 不签发）
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new GuardError("LEASE_SCOPE_INVALID", "fields scope requires object arguments");
    }
    const picked: Record<string, unknown> = {};
    for (const path of paths) {
      const value = (args as Record<string, unknown>)[path];
      if (value === undefined) {
        throw new GuardError("LEASE_SCOPE_INVALID", `fields scope missing field ${path}`);
      }
      picked[path] = value;
    }
    return {
      kind: "fields",
      key: sha256Scope({ tool: toolName, fields: picked }),
      display: `tool=${toolName} fields=${displayOf(picked)}`,
    };
  }
  private resolveToolLevel(toolName: string): CapabilityScope {
    // 作用：最宽模式——本 Session 内对该 Tool 全部放行；只允许用户显式配置，禁止作为默认（规格 5.4.3）
    return {
      kind: "tool",
      key: `tool:${toolName}`,
      display: `tool=${toolName}（本 Session 内该工具全部调用）`,
    };
  }
}
function displayOf(value: unknown): string {
  // 作用：生成脱敏后的展示文本——敏感 key 的字符串值替换为 ***，再 canonical 化并截断，
  // 确保 Approval reason 与 Audit 中不出现 Secret 原文（规格第 9 节）
  const text = canonicalize(redactForDisplay(value));
  return text.length > DISPLAY_MAX_LENGTH ? `${text.slice(0, DISPLAY_MAX_LENGTH)}…` : text;
}
function redactForDisplay(value: unknown): unknown {
  // 作用：递归复制并脱敏——命中敏感 key 正则的字符串值一律替换为 ***
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactForDisplay(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) && typeof v === "string" ? "***" : redactForDisplay(v);
    }
    return out;
  }
  throw new GuardError("LEASE_SCOPE_INVALID", "arguments contain non-JSON value");
}
