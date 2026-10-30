<p align="center">
  <b>DSH Capsule · Capability Guard</b>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md"><b>English</b></a>
</p>

> [!NOTE]
> **This English README is out of date.** The UI was rebuilt in 2026-10 (session-scoped dock + "Capability" tab +
> settings page; decision log; bounded "quiet window"). The Chinese [README.md](README.md) is the source of truth
> until this file is fully re-translated.

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-4F46E5?style=flat-square" alt="DeepSeek Harness Plugin" />
  <img src="https://img.shields.io/badge/status-Developer_Preview-F59E0B?style=flat-square" alt="Developer Preview" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/Runtime_Dependencies-0-12B76A?style=flat-square" alt="No runtime dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-12B76A?style=flat-square" alt="MIT" />
</p>

<p align="center">
  <b>Give temporary authorization an expiry, revocation, and an audit trail.</b>
</p>

<p align="center">
  DSH Capsule is a <b>Capability Guard</b> for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>:<br/>
  a short-lived lease layer over existing approvals, with sandbox elevation, rollback, and audit.
</p>

> [!IMPORTANT]
> **The project direction has changed.** The current repository is a pure TypeScript Capability Guard. The former Python / Docker / Unix Domain Socket isolation runtime has been removed. Credential brokering, command credential bindings, and the Managed SDK/demo were removed by project decision on 2026-10-30. The project now focuses on universal short-lived authorization.

> [!CAUTION]
> **This English README is out of date (2026-09-14).** Source-level verification against an installed DSH build falsified one of its core assumptions: `tools/pre-execute` falls through to `allow`, so Universal Mode cannot wait for a downstream `ask` there; the real approval path is the sandbox escalation inside the pwsh/bash/fs tool bodies.
> The **Chinese README ([`README.md`](README.md)) is authoritative** and already carries the corrected model (four hooks, `sandbox-escalation` scope, sandbox-mode grants with TTL rollback, and the honest security-boundary wording). Porting those sections here is tracked as follow-up work. The technical baseline with file/line citations lives in `docs/集成基线-真实DSH行为.md` (Chinese).

> [!WARNING]
> **Developer Preview.** The authorization lifecycle is covered by real Cordis integration tests. DSH upgrades still require compatibility checks against the installed version.

---

## Why DSH Capsule?

Agent tooling often lands at one of two extremes: repeated one-time approvals or broad session permissions. Guard adds an explicit time boundary and rollback to temporary authorization.

DSH Capsule inserts a **short-lived capability layer** between them:

| Problem | DSH Capsule approach |
|---|---|
| Repeated approval for the same safe operation | Issue a short-lived lease after `allowed-once`; reuse it only within the same Session + Scope |
| Authority is too broad | Bind a lease to `Session × Tool × Scope × TTL` |
| Authority must expire or be withdrawn | Real-time TTL validation + `revoke()` / `revokeSession()` |
| Hard to understand what happened | Secret-safe Audit + read-only Governance Console |
| Security failure falls through | Critical paths are **fail closed** |

In one sentence:

> **Turn explicit approval into short-lived authorization bound to a Session, Scope, and TTL.**

---

## Universal short-lived authorization

### Universal Mode — short-lived authorization for existing tools

If an installed tool is already classified as `ask` by downstream DSH policy, Guard can work across the native `tools/pre-execute` / `approval/request` / `tools/result` path with no tool changes:

- downstream `deny`: always remains `deny`; a lease **never overrides denial**;
- downstream `allow`: passes through unchanged; Guard does not create a new approval;
- downstream `ask`: Guard looks for a matching lease; reuse yields temporary `allow`, otherwise `ask` remains;
- a lease is issued only after the answerer returns `allowed-once`;
- `rejected`, `cancelled`, and `unavailable` never issue a lease.

Universal Mode therefore reduces repetitive approval while preserving native DSH semantics.

<p align="center">
  <img src="assets/universal-lease-en.svg" alt="Universal Mode Lease Flow" width="100%" />
</p>

## Architecture

- UniversalGate: four hooks, approval observation, callId isolation, and lease reuse.
- ScopeResolver / PolicyResolver: deterministic scopes and TTL policy.
- LeaseManager / MemoryLeaseStore: session binding, expiry, and revocation.
- SandboxGrantManager: sandbox elevation, rollback, and user-override detection.
- AuditService / GovernanceConsole: redacted audit, remaining time, and runtime policy.

### Boundary with native DSH mechanisms

DSH Capsule is **not a second Harness**. It intentionally composes with DSH primitives:

- Approval is still decided by the native `approval/request` answerer;
- later DSH guards may still deny execution;
- credential management remains with DSH or the relevant tools; Guard does not resolve or inject secrets;
- process/file/network isolation remains the job of DSH Sandbox or an external isolation mechanism.

Guard adds one thing: **turn a concrete approval into a Session-, Scope-, and TTL-bound short-lived capability.**

---

## Capability Lease

A lease is not “this plugin is trusted.” Its identity is:

```text
Session × Tool × Scope × TTL
```

Default scopes hash the tool name and canonical JSON arguments. Sandbox escalation scopes use the tool name and requested mode.

### Lifecycle

```text
ASK
 └─ allowed-once
      └─ ISSUE ────────┐
                       │
                  ACTIVE
                   ├─ match → REUSE
                   ├─ TTL   → EXPIRED
                   └─ revoke→ REVOKED
```

- TTL is checked against the current clock during `find` / `validate`; security does not rely on a background timer;
- every lease is session-bound; no anonymous/global lease is created when trusted `agent.id` is missing;
- `revoke(leaseId)` revokes one lease;
- `revokeSession(sessionId)` revokes all leases for a Session;
- the current default store is `MemoryLeaseStore`, so leases do not survive process restarts.

---

## Scope — where may approval be reused?

### `exact-arguments` — default

```text
SHA-256(toolName + canonical JSON(arguments))
```

Only an identical tool call can reuse the lease. This is the strictest zero-configuration strategy for Universal Mode.

### `fields` — explicitly broader

Only selected argument fields enter the scope, e.g. `repo` and `branch`.

### `tool` — broadest

Reuse is based only on tool name within the same Session. This must be explicitly configured and is never the default.

## Governance Console

<p align="center">
  <img src="assets/governance-console-en.svg" alt="Governance Console Preview" width="100%" />
</p>

The Console is disabled by default. When enabled it starts a **read-only** local HTTP viewer:

```ts
{
  console: {
    enabled: true,
    host: "127.0.0.1",
    port: 8787,
  }
}
```

It exposes only:

```text
GET /
GET /api/snapshot
GET /api/audit
```

`/api/audit` can filter by `sessionId`, `toolName`, `decision`, and `limit`.

Security properties:

- binds to `127.0.0.1` by default;
- has no write endpoints;
- responses use `no-store`, `nosniff`, and CSP;
- UI data is rendered with `textContent`;
- views are allowlisted projections and exclude credentials, authorization headers, and raw tool arguments.

---

## Quick start

### Requirements

- Node.js `22`
- pnpm `11.25.0` (pinned through the repository `packageManager` field)
- core TypeScript code is cross-platform; CI is configured for Windows / macOS / Linux

> [!NOTE]
> The repository does not yet ship a public DSH package/profile release. The commands below are for **source development**, not the final end-user installation flow.

```bash
git clone <your-repository-url>
cd dsh-capsule

pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Workspace packages:

```text
@dsh-capsule/adapter
```

### Default policy

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: []
}
```

### Per-tool rules

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: [
    {
      match: "deploy.preview",
      ttlSeconds: 120,
      scope: {
        mode: "fields",
        paths: ["project", "environment"]
      }
    },
    {
      match: "dangerous.admin",
      enabled: false
    }
  ]
}
```

V1 `match` is an **exact tool-name match**, not glob or regex.

---

## Fail-closed error model

Critical security failures use structured codes rather than silently falling through:

```text
LEASE_REVOKED
LEASE_EXPIRED
LEASE_TTL_INVALID
LEASE_SCOPE_INVALID
LEASE_POLICY_INVALID
```

The rule:

> **If identity, scope, or TTL cannot be validated, Guard does not issue or reuse a lease and preserves native approval semantics.**

---

## Security boundary & non-goals

### What Universal Mode can claim

- short-lived leases for tools that already trigger `ask`;
- Session / Tool / Scope / TTL binding;
- expiry, revocation, reuse, and audit;
- native `deny` is never overridden;
- existing tools do not need to be rewritten.

### What Universal Mode **cannot** claim

- it does not guarantee that arbitrary third-party plugins cannot see credentials;
- it does not stop a plugin from making network requests it is already able to make;
- it does not isolate arbitrary plugin code;
- it is not process/container/VM/microVM isolation.

## Project status

| Capability | Status |
|---|---|
| Universal Lease Gate | ✅ Implemented |
| Session / Scope / TTL / Revoke | ✅ Implemented |
| Secret-safe Audit | ✅ Implemented |
| Read-only Governance Console | ✅ Implemented |
| Ubuntu / Windows / macOS CI workflow | ✅ Configured |
| Real DSH/Cordis types & Loader integration | 🚧 Pending |
| Public installable DSH release package | 🚧 Pending |
| Durable Lease Store | 🗺️ Roadmap |

DeepSeek Harness itself is in Developer Preview and moving quickly, so the final integration should be validated against the TypeScript types of the actual installed DSH version rather than treating event shapes as a permanent compatibility promise.

---

## Repository layout

```text
adapter/
├── client.js                 # DSH governance panel
├── cordis.patch.yml          # Plugin policy
└── src/
    ├── index.ts              # Plugin assembly and host adapter
    ├── capability/           # Four hooks, scopes, leases, elevation and rollback
    ├── integration/          # Real Cordis and authorization lifecycle tests
    ├── audit/                # Redacted audit
    └── console/              # Shared governance UI, API and runtime policy
scripts/smoke-console.mjs     # Governance smoke script
.github/workflows/ci.yml      # Windows / macOS / Linux build and test
```

---

## Design principles

**Preserve DSH semantics.** Guard augments `ask`; it does not override `deny` or reinvent Approval.

**Short-lived authority.** Every reusable grant needs an explicit Session, Scope, and TTL.

**Deterministic scope.** Security boundaries come from deterministic rules, never from LLM guesses about authorization scope.

**Fail closed.** If identity, scope, or TTL cannot be verified, execution is rejected.

**Secret-safe observability.** Audit and Console expose allowlisted governance fields only.

**Small trusted core.** Guard only manages the authorization lifecycle, not credentials or external operations.

---

## FAQ

### How is this different from RBAC?

RBAC answers “what may this role generally do?” A Capability Lease answers **whether this Session may use this Tool on this Scope right now, within this TTL**. That is a better fit for dynamic, short-lived agent workflows.

### Does Universal Mode protect every third-party plugin?

It can add short-lived leases to tools that already reach the DSH `ask` path with no plugin rewrite. It does not isolate arbitrary plugin code;

### Does it support Windows, macOS, and Linux?

The current main path is pure TypeScript and has no Python / Docker / Unix Domain Socket dependency. The repository CI is configured for all three OS families. Real DSH integration still needs compatibility validation against the target DSH version.

### Why is `exact-arguments` the default scope?

Because a generic guard cannot safely infer business-resource semantics for arbitrary third-party tools. Reusing only identical arguments is deliberately conservative.

---

## Roadmap

Focus on authorization visibility, lifecycle recovery, audit, and DSH compatibility. Finer scopes, renewal, and UI revocation require separate specifications and host-boundary verification.

---

## Contributing

Security infrastructure benefits most from **negative tests and explicit boundaries**. Useful contributions include:

- Lease / Scope / Session isolation tests;
- concurrent `callId`, cancellation, and lifecycle race tests;
- DSH version compatibility validation;
- documentation and reproducible integration examples.

If a change expands the trusted computing base, gives extensions direct secret access, or bypasses native DSH Approval / Sandbox semantics, discuss the design before implementation.

---

## License

MIT License. See [`LICENSE`](LICENSE).

<p align="center">
  <b>DSH Capsule</b><br/>
  <sub>Short-lived authorization · Sandbox rollback · Fail-closed by design</sub>
</p>
