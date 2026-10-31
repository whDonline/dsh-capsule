// 作用：操作指纹——回答「两次调用是不是同一条操作」。这是 ① 同操作模式（默认档）的唯一判据。
//
// 组成：工具名 + 参数（**去掉 justification**）+ 目标沙箱档位。
// 为什么去掉 justification：那是模型每次现写的理由文字，同一句命令换个措辞就会变，
// 带上它等于永远命中不了（历史 README 里已有同样结论）。
// 为什么带上目标档位：同一条命令「升到工作区可写」和「升到完全访问」是两件事，不能互相复用。
//
// 隐私：只对外暴露「参数键名 + 指纹前缀」，不输出参数值——参数里可能夹着 Token / 密码。
import { canonicalize, sha256Scope } from "./canonical.js";
import type { SandboxMode } from "./escalation.js";
export interface OperationFingerprint {
  /** 匹配用：sha256(工具 + 参数去 justification + 目标档位) */
  key: string;
  /** 展示用：工具名 + 参数键名（不含任何参数值）+ 目标档位 */
  display: string;
  mode?: SandboxMode;
}
export function operationFingerprint(toolName: string, args: unknown, mode?: SandboxMode): OperationFingerprint {
  const cleaned = stripVolatile(args);
  const key = sha256Scope({ tool: toolName, args: cleaned, mode: mode ?? null });
  return { key, display: describeOperation(toolName, cleaned, mode), mode };
}
/** 作用：去掉每次都会变的字段——目前只有 justification（模型写的批准理由）。 */
function stripVolatile(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args ?? null;
  const { justification: _ignored, ...rest } = args as Record<string, unknown>;
  return rest;
}
/** 作用：可安全展示的操作描述——只列参数键名，绝不输出参数值。 */
function describeOperation(toolName: string, args: unknown, mode?: SandboxMode): string {
  const keys = args !== null && typeof args === "object" && !Array.isArray(args) ? Object.keys(args as Record<string, unknown>).sort() : [];
  const shape = keys.length > 0 ? `(${keys.join(", ")})` : "";
  const modeText = mode ? ` → ${mode}` : "";
  // canonical 只用于给出长度与稳定性校验，避免把值写进展示串
  const size = canonicalize(args ?? null).length;
  return `${toolName}${shape}${modeText} [${size}B]`;
}
