import { randomUUID } from "node:crypto";
import { GuardError } from "./errors.js";
import type { LeaseStore } from "./lease-store.js";
import type { CapabilityLease, CapabilityScope } from "./types.js";// 作用：LeaseManager（重构规格第 5.7 节）——只负责 issue / validate / findMatching / revoke /
// revokeSession / list；禁止混入 Approval UI、Tool Hook、Credential、Provider 逻辑。
export interface IssueLeaseInput {
  sessionId: string;
  toolName: string;
  scope: CapabilityScope;
  ttlSeconds: number;
  sourceCallId?: string;
}
export class LeaseManager {
  constructor(
    private readonly store: LeaseStore,
    private readonly now: () => number = Date.now,
    /** 可选：Lease 状态变化回调——仅用于持久化（审计日志），抛错绝不影响主链路 */
    private readonly onChange?: (lease: CapabilityLease) => void,
  ) {}
  private notify(lease: CapabilityLease): void {
    if (!this.onChange) return;
    try {
      this.onChange(lease);
    } catch {
      // 持久化失败不影响授权判定
    }
  }
  async issue(input: IssueLeaseInput): Promise<CapabilityLease> {
    // 作用：签发 Lease——参数防御校验（Fail Closed）：sessionId/toolName/scope.key 必须非空字符串，
    // TTL 必须正整数；签发结果立即写入 store，expiresAt = now + ttlSeconds * 1000
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "sessionId must be a non-empty string");
    }
    if (typeof input.toolName !== "string" || input.toolName.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "toolName must be a non-empty string");
    }
    if (typeof input.scope?.key !== "string" || input.scope.key.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "scope.key must be a non-empty string");
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", "ttlSeconds must be a positive integer");
    }
    const issuedAt = this.now();
    const lease: CapabilityLease = {
      id: randomUUID(),
      kind: "universal",
      sessionId: input.sessionId,
      toolName: input.toolName,
      scope: input.scope,
      issuedAt,
      expiresAt: issuedAt + input.ttlSeconds * 1000,
      status: "ACTIVE",
      sourceCallId: input.sourceCallId,
    };
    await Promise.resolve(this.store.insert(lease));
    this.notify(lease);
    return lease;
  }
  async findMatching(sessionId: string, toolName: string, scopeKey: string): Promise<CapabilityLease | undefined> {
    // 作用：查找并校验可复用 Lease——store 命中后 validate（实时 TTL 比较 + 惰性标记 EXPIRED）；
    // 任何无效（撤销/过期/不存在）统一返回 undefined，由上层保持 ask 重新走授权。
    const lease = await Promise.resolve(this.store.findMatching({ sessionId, toolName, scopeKey }));
    if (!lease) return undefined;
    try {
      return this.validate(lease);
    } catch {
      return undefined;
    }
  }
  get(id: string): CapabilityLease | undefined {
    // 作用：按 id 读取单条 Lease（不校验、不改状态）——供审计与诊断路径实时查询「该 Lease 是否还活着」。
    // 刻意不做 validate：调用方需要区分「不存在 / 已撤销 / 已过期」三种失效情形并统一按失效处理；
    // 安全判定请改用 isLive()。
    return this.store.get(id) as CapabilityLease | undefined;
  }
  isLive(id: string): boolean {
    // 作用：判断某 Lease 当前是否有效（不存在 / 非 ACTIVE / 已过期 一律 false），并顺手把过期项惰性标记为
    // EXPIRED。过期判定【必须】用本对象注入的时钟，禁止让调用方自己传 time——否则调用方一旦用真实挂钟
    // （或测试里的模拟时钟）与 Lease 时钟不一致，就会把仍然有效的授权误判为失效并触发错误回滚。
    const lease = this.store.get(id) as CapabilityLease | undefined;
    if (!lease) return false;
    if (lease.status !== "ACTIVE") return false;
    if (this.now() >= lease.expiresAt) {
      lease.status = "EXPIRED";
      return false;
    }
    return true;
  }
  validate(lease: CapabilityLease): CapabilityLease {
    // 作用：校验 Lease 有效性（Fail Closed）——REVOKED 抛 LEASE_REVOKED；now >= expiresAt 惰性标记
    // EXPIRED 并抛 LEASE_EXPIRED；状态异常一律拒绝。安全正确性完全依赖本方法的实时时间比较，
    // 不依赖任何后台定时器（规格第 5.8 节）
    if (lease.status === "REVOKED") {
      throw new GuardError("LEASE_REVOKED");
    }
    if (lease.status === "EXPIRED" || this.now() >= lease.expiresAt) {
      lease.status = "EXPIRED";
      throw new GuardError("LEASE_EXPIRED");
    }
    if (lease.status !== "ACTIVE") {
      throw new GuardError("LEASE_REVOKED", `unexpected status ${lease.status}`);
    }
    return lease;
  }
  async revoke(leaseId: string, reason?: string): Promise<boolean> {
    // 作用：撤销单个 Lease——下一次同 Scope 调用重新 Ask（规格 22.11）
    const ok = await Promise.resolve(this.store.revoke(leaseId, reason));
    const updated = this.store.get(leaseId) as CapabilityLease | undefined;
    if (ok && updated) this.notify(updated);
    return ok;
  }
  async list(): Promise<CapabilityLease[]> {
    return await Promise.resolve(this.store.list());
  }
}
