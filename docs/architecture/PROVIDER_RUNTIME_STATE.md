# O9-F3.3 Provider Runtime State — Phase Status & Architecture

## Phase Status

- **O9-F3.3C — Free benchmark work**: **COMPLETE / COMMITTED / PUSHED** — checkpoint `8701227e8123103b98c8552e019494cb27f6aebb`
- **O9-F3.3P0 — Provider State Foundation**: **IN PROGRESS**

O9-F3.3P0 builds the foundation for a future direct, independent free / free-tier
provider pool. Planned later: Groq, Cerebras, Gemini / Google AI Studio, NVIDIA NIM.
Already present today: OpenRouter, OpenCode. **No provider live-integration happens in P0.**

## Purpose

`Provider Runtime State` aggregates the state of the existing OmniRoute / O9 systems into a
single normalized, read-only view. It does **not** build a parallel resilience system. The
aggregation reuses the circuit breaker (`providerHealth`), the DB `provider_connections`
rows (`cooldownUntil`, `lastSuccessAt`, `lastFailureAt`, `failureReason`), model lockouts
(`quotaScope`, `failureReason`), free-access quota (`quotaState`, `quotaResetAt`), connection
billing (`costClass`), model capabilities, and check-fallback error flags
(provider-account-level `quotaState`).

Entry point: `open-sse/services/providerRuntimeState.ts` → `getProviderRuntimeState()`.
Pure filter: `filterFreeCandidatesByRuntimeState()`.

## Normalized State Fields

The normalized state contains / will contain:

- `providerId`, `connectionId`
- `providerHealth`
- `accountState`
- `quotaState`, `quotaScope`
- `cooldownUntil`, `quotaResetAt`
- `costClass`
- `executable`, `fastEligible`, `codingEligible`, `genericToolEligible`
- `claudeCodeEligible`, `supervisorEligible`
- `lastSuccessAt`, `lastFailureAt`, `failureReason`
- `latency`

## Key Semantics

- `verified_free != executable != tool eligible != claude-code eligible != supervisor eligible`
  — each capability is an independent dimension and must be proven separately.
- Unknown / null stays unknown / null.
- No optimistic TRUE assumptions.
- Fail closed when required information is missing.

## OpenRouter Semantics

Real error:

> `HTTP 429 — "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free
model requests per day"`

Auto-classified as:

- `failureKind = quota_exhausted`
- `providerId = openrouter`
- `quotaState = quota_exhausted`
- `quotaScope = provider_account`
- `accountState = quota_exhausted`
- `failureReason = free-models-per-day`

A normal / transient OpenRouter 429 stays only `rate_limit`. `failureKind` and `quotaScope`
are **separate dimensions**.

## Candidate Suppression

The earlier `suppressExhaustedFreeCandidates()` was misleading (it surfaced only a single
connection id). It is replaced by `filterFreeCandidatesByRuntimeState(...)`, a pure filter.

Goal:

- OpenRouter Connection A — provider-account quota exhausted → **all** free candidates on
  Connection A are removed/trimmed.
- OpenRouter Connection B — healthy → stays available.

No N separate model lockouts. No global provider lockout merely because
`provider === "openrouter"`. Shared accounts are only handled jointly when a reliable
upstream-account identifier exists.

## targetExhaustion

`open-sse/services/combo/targetExhaustion.ts` treats provider-account exhaustion in the new
O9 context as **connection-scoped** when only one concrete connection is safely known to be
exhausted. SAFE-CONNECTION targets of the same request are not accidentally blocked. An
exhausted OpenRouter Connection A does **not** auto-lock Connection B. Existing
quota/account exhaustion semantics are reused — no parallel lockout system.

## Provider Roadmap

- **P0**: Provider State Foundation
- **P1**: Groq + Cerebras direct — **NOT APPROVED YET**
- **P2**: Gemini + NVIDIA direct
- **After**: Credential Broker

Long-term target image:

```
Claude / Codex exhausted
        ↓
OpenRouter Free
        ↓
Groq
        ↓
Cerebras
        ↓
Gemini
        ↓
NVIDIA
        ↓
best eligible fallback
```

with:

- dynamic provider health
- account / quota state
- cooldowns
- cost class
- model capability
- tool capability
- Claude-Code compatibility
- supervisor eligibility
- dynamic failover

**P1 is NOT approved yet.** No statement here implies Groq / Cerebras / Gemini / NVIDIA are
already integrated.
