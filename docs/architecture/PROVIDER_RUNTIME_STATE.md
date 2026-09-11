# O9-F3.3 Provider Runtime State — Phase Status & Architecture

## Phase Status

- **O9-F3.3C — Free benchmark work**: **COMPLETE / COMMITTED / PUSHED** — checkpoint `8701227e8123103b98c8552e019494cb27f6aebb`
- **O9-F3.3P0 — Provider State Foundation**: **COMPLETE / VALIDATED**

O9-F3.3P0 builds the foundation for a future direct, independent free / free-tier
provider pool. Planned later: Groq, Cerebras, Gemini / Google AI Studio, NVIDIA NIM.
Already present today: OpenRouter, OpenCode. **No provider live-integration happens in P0.**

### O9-F3.3P0 — final state

- Provider Runtime State aggregates the existing OmniRoute / O9 subsystems. No parallel
  resilience system.
- `providerHealth` and account / quota state are **separate**.
- `quotaScope` (quota dimension) and execution / lock scope are **separate dimensions**.
- `verified_free != executable`
- `executable != genericToolEligible`
- `genericToolEligible != claudeCodeEligible`
- `claudeCodeEligible != supervisorEligible`
- `unknown` / `null` stays `unknown` / `null`.
- Unknown cost is **fail-closed**.

**OpenRouter — `free-models-per-day`:**

- `failureKind = quota_exhausted`, `quotaScope = provider_account`.
- **With a known connection**: only that connection is marked request-scoped exhausted
  (`exhaustedConnections`).
- **Without a known connection**: no provider scope is invented — the request-scoped sets are
  left untouched, the same-model retry is stopped, and failover continues. A healthy sibling
  connection stays eligible.

**AgentRouter — legacy compatibility (#10334 / #10419) retained:**

- A connection-scoped account quota with **no connectionId** keeps the historical
  whole-provider request lockout.
- This is an **explicit legacy exception** (`LEGACY_NO_CONNECTION_ID_PROVIDER_LOCKOUT_PROVIDERS`
  in `targetExhaustion.ts`), **not** the default for new providers. Removing or changing it is
  its own initiative, not part of O9-F3.3P0.

**Candidate filtering:**

- Free candidate scoped to only connection A, A exhausted → removed.
- Free candidate `allowedConnectionIds = [A, B]`, A exhausted → trimmed to `[B]`.
- B healthy → stays.
- No N per-model lockouts. No global OpenRouter lockout.

**Validation:**

- 12 / 12 P0 validation targets met.
- Focused DB-free relevant tests: **154 / 154 PASS**.
- `combo-target-exhaustion`: **51 / 51 PASS**.
- AgentRouter DB-free relevant tests: **12 / 12 PASS**.
- `typecheck:core`: PASS. `lint`: PASS. `git diff --check`: PASS.

**Known test-infrastructure gap (pre-existing, not caused by F3.3P0):**

- 9 AgentRouter / DB-dependent tests cannot run in this environment — no working SQLite
  driver (`better-sqlite3` not built; `node:sqlite` unavailable). All failures are
  `[DB] driver unavailable`, zero assertion failures. No DB code was touched by F3.3P0.
- No separate full factory-E2E regression proof for the non-free path exists in this
  environment for the same DB-infrastructure reason. Production behavior is structurally
  protected by the `spec?.tier === "free"` guard placed **before** the free-candidate
  runtime-state filter (`virtualFactory.ts`). No helper / production abstraction was
  introduced solely for testability.

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

### Free access — three distinct concepts (O9-F3.3P1-C1)

These must never share one boolean:

| Concept                        | Predicate / source                                                                                                                                              | Meaning                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ANY free access**            | `grantsFreeAccess(freeType)` (`freeModelCatalog.ts`)                                                                                                            | Some cost-free path exists right now — includes a one-off signup / trial credit while it lasts. Only `discontinued` (retired behind a paid key) is excluded. Read by UI, `/v1/models` free-flagging, "import free models only", `hidePaidModels`. **Unchanged** by P1-C1.               |
| **RECURRING free access**      | `grantsRecurringFreeAccess(freeType)` (`freeModelCatalog.ts`, new)                                                                                              | The allowance renews on its own — daily / monthly / refilling credit / genuinely uncapped — or is a permanently-free `keyless` regime. A `one-time-initial` signup credit (spent once, gone) is **not** recurring. Read by `providerRuntimeState.classifyCostClass` (`metered` branch). |
| **VERIFIED zero-cost routing** | `costClass === "verified_free"` (only `billing:"keyless"`) **+** STRICT_ZERO_COST (`freeAccessPolicy === "strict"`: `hardStopGuaranteed` **+** live-SAFE quota) | Hard guarantee of no incremental spend. `hasFree` / `freeNote` / marketing text are never sufficient.                                                                                                                                                                                   |

`classifyCostClass` (`metered` connection) returns `free_tier` **only** when the exact
`(provider, model)` pair is in the curated catalog **and** `grantsRecurringFreeAccess(freeType)`
is true. A trial-credit-only catalog entry classifies as `paid` here. `keyless` billing still
maps directly to `verified_free`; unknown billing stays `unknown` (fail-closed).

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

## Groq Semantics (O9-F3.3P1-C2)

Groq is the first real direct-free provider integrated into the quota/runtime-state semantics.
Groq exposes **per-model** RPM/RPD/TPM/TPD limits — exhausting one model's daily quota must NOT
lock other models on the same connection.

**Rate-limit dimensions:**

| Dimension | Meaning             | Header / Signal                                          | 429 Classification       |
| --------- | ------------------- | -------------------------------------------------------- | ------------------------ |
| RPM       | Requests per minute | `x-ratelimit-remaining-requests` (short window)          | `rate_limit` (transient) |
| TPM       | Tokens per minute   | `x-ratelimit-remaining-tokens` (short window)            | `rate_limit` (transient) |
| RPD       | Requests per day    | `x-ratelimit-remaining-requests` (daily window)          | `quota_exhausted`        |
| TPD       | Tokens per day      | No direct header — body text matcher (not yet available) | `quota_exhausted`        |

**Critical distinction:** `x-ratelimit-reset-*` is a TPM/RPM **window** reset, NOT a daily
(TPD/RPD) reset. TPD/RPD exist as separate limits but are NOT directly represented in these
headers. `quotaResetAt` must NEVER be derived from `x-ratelimit-reset-*` alone.

**Provider error rule (groq-model-daily-quota-exhausted):**

- Triggers: 429 + `x-ratelimit-remaining-requests: 0`
- Result: `reason = quota_exhausted`, `scope = model`
- Model scope because Groq limits are per-model — exhausting `openai/gpt-oss-120b`
  does NOT affect `qwen/qwen3.8-27b`
- `RegistryEntry.perModelQuota = true` enables model-scoped quota lockouts without enabling
  unrelated passthrough-model validation; Groq remains a catalog-validated provider.

**Runtime state for Groq model quota exhaustion:**

- `providerHealth = healthy` (circuit breaker CLOSED — model quota is NOT provider outage)
- `accountState = available` (connection itself is healthy)
- `quotaState = quota_exhausted`
- `quotaScope = model`
- `cooldownUntil = <set by model lockout>`

**Organization / project scope:**

Groq has organization-level limits as a ceiling, but we hold no reliable
`organizationId` / `projectId` / `upstreamAccountId` for Groq connections.
Therefore:

- **No** provider-wide lock without upstream identity evidence
- **No** sibling-connection cascade
- Connection A exhausted → only Connection A / Model X is marked
- Connection B remains eligible

**Header parsing:**

`open-sse/services/groqRateLimitHeaders.ts` — `parseGroqRateLimitHeaders()` — pure
normalization of Groq's `x-ratelimit-*` headers into `GroqRateLimitHeaders` interface.
Supports both `Headers` objects and plain records.

**Open questions (shadow validation):**

- Real Groq RPD/TPD 429 body fixture not yet captured. If the body names the specific
  limit (e.g. "tokens per day"), a body-text matcher should be added.
- `remaining-requests: 0` can fire for RPM (short window) or RPD (daily) — the
  provider rule treats it as RPD. If RPM `remaining=0` is observed in shadow logs,
  the rule should be refined with the actual body text.

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
O9 context as **connection-scoped** when one concrete connection is safely known to be
exhausted. SAFE-CONNECTION targets of the same request are not accidentally blocked. An
exhausted OpenRouter Connection A does **not** auto-lock Connection B. Existing
quota/account exhaustion semantics are reused — no parallel lockout system.

`markConnectionQuotaExhaustion()` (reached via `isConnectionQuotaScope()`):

- **connectionId present** → `exhaustedConnections.add(`${provider}:${connId}`)`, return `true`.
  Same for every provider.
- **connectionId absent, provider in `LEGACY_NO_CONNECTION_ID_PROVIDER_LOCKOUT_PROVIDERS`**
  (today: `agentrouter` only) → `exhaustedProviders.add(provider)`, return `true`. Legacy
  #10334 / #10419 "mirror `markAuthLevelExhaustion`" fallback, pinned by an explicit test.
- **connectionId absent, any other provider (default)** → nothing request-scoped is marked,
  return `true`. The same-model retry is suppressed; the persisted per-connection cooldown
  (`markAccountUnavailable`, rule scope `"connection"`) still cools whichever connection the
  failing leg resolved.

Model-scoped quota and transient 429 paths are unchanged. Legacy provider-wide quota paths
outside this connection-scoped special case are unchanged (#1731 regression-guarded).

## Provider Roadmap

- **F3.3P0**: Provider State Foundation — **COMPLETE**
- **F3.3P1-A**: Groq + Cerebras architecture audit — **COMPLETE** (both already fully wired as
  `format:"openai"` / `executor:"default"` apikey providers; no new transport needed)
- **F3.3P1-C1**: Free regime semantics — trial != recurring free — **COMPLETE** (this change)
- **F3.3P1-C2**: Groq quota/error/runtime-state semantics — **COMPLETE (this change)**
- **F3.3P1** (remaining C2..F): capability producer, verified-free discovery, credential wiring,
  controlled shadow validation — **NOT STARTED**
- **F3.3P2**: Gemini + NVIDIA direct — **NOT STARTED**
- **After**: Credential Broker

### Groq / Cerebras classification

- **Groq** — `DIRECT_PROVIDER_ELIGIBLE`, `RECURRING_FREE_POOL_ELIGIBLE`. In
  `LEGACY_FREE_PROVIDERS`; catalog regime `recurring-daily` with `hardStopGuaranteed:true`;
  `$0` pricing; `classifyTier("groq", …) === free`. Already in `auto/best-free` when a key is
  configured.
- **Cerebras** — `DIRECT_PROVIDER_ELIGIBLE`, `TRIAL_ACCESS_AVAILABLE`,
  `RECURRING_FREE_POOL_INELIGIBLE`. `#11773` / `#12591` reclassified it from a no-card
  recurring trial to a one-time $5 / 30-day / card-gated signup credit. Catalog regime
  `one-time-initial`; paid pricing rates; not in `freeProviders`; `classifyTier("cerebras", …)
!== free`; `grantsRecurringFreeAccess("one-time-initial") === false` so
  `classifyCostClass` never returns `free_tier` for it. Usable as a paid direct provider.

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
