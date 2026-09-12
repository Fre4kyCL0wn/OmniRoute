---
title: "O9-F3.3 Provider Runtime State"
---

# O9-F3.3 Provider Runtime State — Phase Status & Architecture

## Phase Status

- **O9-F3.3C — Free benchmark work**: **COMPLETE / COMMITTED / PUSHED** — checkpoint `8701227e8123103b98c8552e019494cb27f6aebb`
- **O9-F3.3P0 — Provider State Foundation**: **COMPLETE / VALIDATED**
- **O9-F3.3P1-D1 — Direct Provider Capability Metadata**: **COMPLETE**
- **O9-F3.3P1-D2 — Capability → Eligibility Producer**: **COMPLETE**
- **O9-F3.3P1-D0 — FCC Preferred Catalog Integration Foundation**: **COMPLETE** —
  evidence-source abstraction + provider/model mapping + ranking signal + sync design
- **O9-F3.3P1-D3 — FCC Upstream Catalog Snapshot & Sync**: **COMPLETE** — real,
  pinned-revision, importer-generated provider snapshot (50 providers) + hand-curated discovery
  classification + provider-level diff workflow; still not wired into live routing
- **O9-F3.3P1-D4 — Native Claude Code Gateway Visibility**: **COMPLETE** — re-scoped after audit
  found the gateway mirror already exists; adds only a capability-aware visibility gate
  (executable + claudeCodeEligible, fail-closed) composed onto the existing `claude/…` /
  `no-think/…` mirrors. No new gateway-id system, no FCC prefix adopted, no `/v1/models` shape
  change with flags off
- **O9-F3.3P1-D4.1 — Claude Code Compatibility Evidence, Tranche 1**: **COMPLETE (this change,
  pending review)** — seeds real, per-model `claudeCodeReady` evidence for Gemini (7 true) and
  NVIDIA (3 true, 1 false); Groq/Cerebras/OpenRouter stay unseeded (no sufficient per-model
  evidence found — not a defect). D4's gate logic untouched. Visibility: 0 → 10 models (see
  below)
- **O9-F3.3P1-D4.2 — Groq Claude Code Compatibility Evidence (dedicated pass)**: **COMPLETE,
  no-op result (2026-09-11)** — targeted re-verification of all 10 Groq registry models against
  registry `RegistryModel.toolCalling`, static `ModelSpec.supportsTools`, existing Groq-specific
  tests, and the generic translator/tool-roundtrip tests; confirms D4.1's Groq finding exactly:
  0 true / 0 false / 10 unknown. No new evidence found, no code or data change made, D4 gate logic
  untouched. See "D4.2 Groq Re-Verification" below.
- **O9-F3.3P1-D5 — FCC Preferred-Candidate Ranking Wiring**: **COMPLETE / COMMITTED / PUSHED**
  (2026-09-11) — canonical commit `daa750704b58a2e48b27988eb0721061deb86710` on
  `phase/o9-f3-3p1-d5-fcc-preferred-ranking`. Wires D0's `computeFccRankingSignal` into live
  AutoCombo scoring as a new route-scoped, hard-gated, additive `fccPreference` factor.
  `DEFAULT_WEIGHTS.fccPreference = 0`: routing is byte-identical to pre-D5 by default, and real
  FCC preference coverage against current evidence is `0` (D5 ships as a dormant mechanism — see
  below). No eligibility created, no model unlocked, D4.1/D4.2 counts unchanged. Real per-model FCC
  evidence is still absent; **D6 must not claim real FCC ranking is already validated.** See
  "D5 FCC Preferred-Candidate Ranking Wiring" below.

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

## Direct Provider Capability Metadata (O9-F3.3P1-D1)

The direct-free-provider pool needs normalized per-(provider, model) capability
metadata — the raw facts the eligibility producer (D2) derives `executable`,
`fastEligible`, `codingEligible`, `genericToolEligible`, `claudeCodeEligible`
and `supervisorEligible` from. `ProviderModelInfo` is the O9-F3.3 name for that
record (echoing the free-claude-code `ProviderModelInfo` reference audited in
O9-F3.3R1).

Module: `open-sse/config/providers/directCapabilities.ts` — `ProviderModelInfo`
type + `extractProviderModelInfo(provider, model, enriched?)`, a **DB-free,
deterministic, pure** extraction. No SQLite, no synced cache, no timer/process.

**Layer precedence** (first proven value wins):

1. `enriched` — OPTIONAL runtime/synced capability layer (e.g. the full
   `ResolvedModelCapabilities` from `getResolvedModelCapabilities`, merged
   upstream by the D2 producer). Deferred to the caller so this module stays
   pure and unit-testable without a SQLite driver.
2. Static base — provider `RegistryModel` (registry `toolCalling` /
   `supportsReasoning` / `supportsVision` / `contextLength` / `maxOutputTokens`)
   then static `ModelSpec` (`MODEL_SPECS`) for the model id (or its leaf, for
   path-shaped ids). This is the DB-free subset of the canonical resolver chain.
3. Curated judgement — `DIRECT_PROVIDER_JUDGEMENTS`
   (`directCapabilities.data.ts`): hand-set facts no source derives, each with
   an `// evidence:` citation (public-page | in-repo), following the
   `freeModelCatalog.data.ts` convention. Provider-wide `"*"` defaults merge
   under per-model entries (per-model wins field-by-field).

**Contract** (mirrors the runtime-state invariants):

- Every capability field is an INDEPENDENT dimension — none infers another.
- Unknown / unproven stays `null`; `null` means "not eligible" to consumers.
- No optimistic TRUE assumptions: a field is `true` only when a layer proves it.
- A curated `supportsReasoning: false` (e.g. Groq's llama-4-scout) is a proven
  FALSE, distinct from `null` (unknown).

**Pool**: `DIRECT_CAPABILITY_PROVIDERS` = `groq`, `cerebras` (P1) + `gemini`,
`nvidia` (P2 roadmap). The seed curates only facts defensible today: Groq's
`latencyClass: "fast"` (public positioning) and the `codingClass: "coding"`
gpt-oss family on groq/cerebras. `strengthClass` and `claudeCodeReady` are left
null until a P1 research pass / the Claude Code gateway work (D3) prove them.

D2 (capability → eligibility producer) consumes `ProviderModelInfo` and fills
the previously all-`null` `ProviderRuntimeState.capabilities` block.

Provider-wide `"*"` judgement defaults are scoped to models the provider
actually serves (registry model or a `passthroughModels` provider) — never to
an arbitrary `groq/<unknown-id>` prefix. See the `fix(o9)` commit "scope
provider-wide judgement defaults to served models".

## Capability → Eligibility Producer (O9-F3.3P1-D2)

`produceCapabilities(info: ProviderModelInfo)` (`open-sse/services/capabilityEligibility.ts`)
maps the D1 fact layer onto the six independent eligibility verdicts consumed
by `ProviderRuntimeState.capabilities` (no longer all-`null`). Pure, DB-free,
deterministic.

| Eligibility           | Proven by                                      | `true`                               | `false` (proven negative)          | `null`                |
| --------------------- | ---------------------------------------------- | ------------------------------------ | ---------------------------------- | --------------------- |
| `executable`          | provider registry (served model / passthrough) | entry has format+executor AND serves | catalog provider, model NOT served | unregistered provider |
| `fastEligible`        | `latencyClass` (curated)                       | `"fast"`                             | `"standard"`                       | unproven              |
| `codingEligible`      | `codingClass` (curated)                        | `"coding"`                           | `"general"` / `"weak"`             | unproven              |
| `genericToolEligible` | `toolCalling` (extracted/enriched)             | `true`                               | `false`                            | unproven              |
| `claudeCodeEligible`  | `claudeCodeReady` (curated)                    | `true`                               | `false`                            | unproven              |
| `supervisorEligible`  | `strengthClass` (curated)                      | `"frontier"`                         | `"mid"` / `"light"`                | unproven              |

**Semantics**: `true` = proven; `false` = proven negative (a VERDICT, distinct
from unknown); `null` = unknown → not eligible. No cross-field inference — each
dimension is proven by exactly one fact. `executable` is the only field resolved
from the provider REGISTRY (not the model facts): Groq is catalog-validated with
no passthrough, so an unlisted model (e.g. `llama-3.1-8b`) is a proven `false`.

**Wiring**: `getProviderRuntimeState` now derives capabilities through
D1 → D2 by default; explicit `options.capabilities` overrides win per field.
`classifyCapabilities` became a pure `{...produced, ...overrides}` merge.

Currently `claudeCodeEligible` and `supervisorEligible` resolve `null` for every
direct provider (their curated proofs — `claudeCodeReady`, `strengthClass` — are
unseeded). That is deliberate fail-closed: D3 (Claude Code gateway catalog) and
the P1 research pass will prove them per provider/model.

## FCC External Reference Integration (O9-F3.3P1-D0)

[Free Claude Code (FCC)](https://github.com/Alishahryar1/free-claude-code) is integrated as a
**preferred external evidence source for coding-agent / harness compatibility metadata**.

**FCC is NOT:**

- a runtime routing authority — OmniRoute stays the sole execution layer (`Client → Jarvis/OmniRoute
→ Provider`; FCC is never inserted before or after OmniRoute in the request path)
- a cost authority — FCC evidence can never turn a trial into recurring-free, or a paid model into free
- a quota authority — FCC evidence can never override an exhausted-quota verdict
- a health authority — FCC evidence can never override circuit-breaker / connection-cooldown state

**What FCC IS**: a catalog/compatibility evidence source for the six independent dimensions FCC can
speak to (see `FccModelEvidence` in `open-sse/config/providers/fccCatalog.ts`): context window, max
output tokens, input/output modalities, tool/reasoning/structured-output support, aliases, and —
its most valuable contribution — per-coding-client compatibility evidence (Claude Code, Codex,
OpenCode).

### Source priority per dimension

`open-sse/services/evidenceSource.ts` defines a generic `resolveBySourcePriority` over six named
`EvidenceSource`s (`omniroute_registry`, `provider_discovery`, `models_dev`, `fcc_catalog`,
`shadow_validation`, `manual_verified`). A source that is not in a dimension's priority list can
**never** win for that dimension, by construction:

| Dimension                     | Priority (highest → lowest)                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Coding-agent / harness compat | `shadow_validation` → `fcc_catalog` → `models_dev` → `omniroute_registry`                              |
| Cost / free regime            | `manual_verified` → `shadow_validation` → `omniroute_registry` (`fcc_catalog` absent — cannot resolve) |

### Provider / model mapping

`fccCatalog.ts::mapFccProvider(fccProviderId)` normalizes an FCC provider id onto the Jarvis/
OmniRoute registry id via one of four verdicts:

- `mapped` — FCC id equals the Jarvis registry id directly (e.g. `groq`, `cerebras`, `gemini`, `nvidia`)
- `alias` — `FCC_PROVIDER_ID_MAP` names a different, valid Jarvis id (e.g. FCC `cloudflare` → Jarvis
  `cloudflare-ai`)
- `conflict` — the alias table names a Jarvis id that does not resolve (misconfiguration — surfaced,
  never silently ignored; `findBrokenFccProviderAliases()` is a standing self-check)
- `fcc_only` — no Jarvis registry entry exists under either spelling (e.g. `targon` today). The
  provider/model MAY surface in an FCC-evidence view, but `resolveFccOnlyExecutable()` always returns
  `false`, matching the real D1/D2 pipeline's own `executable: null` for an unregistered provider —
  both agree the model is NOT executable until a real registry entry / executor / translator exists.

`fccCatalog.ts::canonicalizeFccModelId(providerId, modelId)` normalizes FCC model ids onto the
`provider/model` path shape the Jarvis registry already uses (trims whitespace, collapses an
accidental `provider/provider/model` duplication).

### Ranking signal (wired into live routing by D5)

`open-sse/services/fccRankingSignal.ts::computeFccRankingSignal(evidence, gate)` produces
`{ fccKnown, fccClaudeCodeCompatible, fccCodexCompatible, fccOpenCodeCompatible, applies }`.
`applies` is `true` **only** when `gate.executable === true` AND the route's own eligibility flag
(`genericToolEligible` / `codingEligible` / `claudeCodeEligible` / …) is already `true` — quota/
health/cost policy is computed entirely upstream and is not even representable as an input to this
function (`FccRankingGate` carries no health/quota/cost fields). This is a hard `if (fccKnown)
chooseFirst()` anti-pattern is explicitly rejected — FCC can only ever add a soft signal on top of
an already-passed hard gate.

**This signal is now wired into live AutoCombo scoring** — D0 shipped the pure, tested function;
O9-F3.3P1-D5 (commit `daa750704`, see below) wires it in as the additive `fccPreference` factor,
at default weight `0` so routing is unchanged until an operator explicitly activates it (D6).

### Dynamic sync design (fixture-only in D0/P1)

`open-sse/services/fccSync.ts` defines the shape a future ingestion job will use:
`FCC upstream snapshot/ref → normalizer → diffFccSnapshots() → review → Jarvis external catalog
cache → validation → registry evidence`. `diffFccSnapshots()` is pure and **never deletes anything
itself** — it only reports `added` / `removed` / `renamed` / `providerMismatch` for a caller to act
on (fail-closed, no destructive auto-deletes). `isSnapshotStale()` fails closed on an unparseable
timestamp.

**D0 does not add a live GitHub dependency.** `open-sse/config/providers/fccCatalog.data.ts` is a
small, explicitly-labeled **fixture** (`FCC_CATALOG_SOURCE_REVISION = "fixture-v0-illustrative"`) —
its entries are illustrative, not a synced copy of FCC's actual catalog. A later phase replaces the
fixture with a real snapshot without changing `fccCatalog.ts`'s shape.

### Explicitly out of scope for D0

Per the O9-F3.3P1-D0 spec, none of the following are built in this phase (deliberately deferred):

- an execution path through FCC (`Jarvis → FCC → Provider`, or any variant) — execution stays
  `Client → Jarvis/OmniRoute → Provider`
- wiring the ranking signal into `combo.ts` live scoring
- a full copy of FCC's model catalog (30+ providers) — only the mapping mechanism + a 3-entry
  illustrative fixture exist today (superseded for the PROVIDER catalog by the real D3 snapshot
  below; FCC still has no per-model capability catalog to import — see D3)
- a live GitHub fetch / sync job — D3 adds an OFFLINE importer over a manually-checked-out FCC
  revision (see below); nothing in Jarvis fetches from GitHub at runtime

## D3 FCC Upstream Catalog Snapshot (O9-F3.3P1-D3)

D3 replaces D0's "no real snapshot yet" state with a real, versioned, reproducible import of
FCC's **provider** catalog — while keeping D0's illustrative per-model fixture
(`fccCatalog.data.ts`'s `FCC_CATALOG_FIXTURE`) untouched, since FCC has essentially no real
per-model capability data to import (see next section).

### Critical architecture fact: FCC's provider catalog ≠ FCC's model catalog

`PROVIDER_CATALOG` (`free_claude_code.config.provider_catalog`) is a **static** dict of 50
`ProviderDescriptor` records — connection metadata only: id, display name, auth kind, default
base URL, credential env-var name, credential signup URL. It carries **no model ids and no
capability facts**.

Verified by reading (not executing) FCC's actual provider-construction code at the pinned
revision: `providers/runtime/factory.py::create_provider()` dispatches every provider id to
exactly one of a dedicated module, the generic `OPENAI_CHAT_PROFILES` OpenAI-compatible adapter,
or a connected-account factory. **Every single path ends in an async `list_model_infos()` that
performs a LIVE HTTP call** (to the provider's `/models` endpoint, a local server for
`local: true` providers, or a connected-account's own live listing) — there is no provider in
this FCC revision whose full model list ships as a bundled static array. Jarvis therefore does
**not** claim FCC has a static, complete model list — it discovers models itself, dynamically,
exactly like Jarvis does.

The two exceptions found while auditing every construction path: `azure_openai` sets
`model_ids_are_routable=False` (deployment names are user-configured, never discovered —
`NO_MODEL_DISCOVERY`), and `llm7`'s profile merges 3 fixed `additional_model_ids` on top of its
live `/models` response (`HYBRID`). Neither is a real "static model catalog" in the sense of
shipping actual per-model capability facts.

**Jarvis imports**: provider connection metadata (below) + discovery-capability metadata
(hand-curated, evidence-cited per provider — see `fccModelDiscoveryClassification.data.ts`).
**Jarvis does NOT import**: a model list, because FCC itself does not have one to give — dynamic
model enumeration for any given provider remains entirely Jarvis/OmniRoute's own responsibility
(via the provider's `models:` registry array or, for the 9 providers where OmniRoute has one, its
own `modelsUrl` live discovery), same as before D3.

### Snapshot format

`open-sse/config/providers/fccProviderSnapshot.data.ts` — **AUTO-GENERATED, DO NOT EDIT** — pure
data, no FCC code copied. Carries `FCC_SNAPSHOT_SCHEMA_VERSION`, `FCC_SNAPSHOT_SOURCE_REPO`,
`FCC_SNAPSHOT_SOURCE_REVISION` (full 40-char git SHA), `FCC_SNAPSHOT_GENERATED_AT` (real ISO
timestamp of the import run), and `FCC_PROVIDER_SNAPSHOT: FccProviderSnapshotEntry[]`. No
credential VALUES are ever read or stored — `credentialEnv` is the upstream env-var **name** only
(e.g. `"GROQ_API_KEY"`); Jarvis's own credential infrastructure is unaffected regardless.

Pinned revision for this snapshot: `81fa340ecac5ce1ae8ba4ea60e7a5517224bfaee`
(`github.com/Alishahryar1/free-claude-code`).

### Importer

`scripts/ad-hoc/fcc-catalog-sync.mjs` (`npm run o9:fcc:sync -- --source <path> --revision <sha>`)
reads a LOCAL, already-checked-out FCC directory as plain text — **no network calls in the parser
itself**, no `eval`, no dynamic `import()` of FCC code, no Python execution. It is a narrow parser
purpose-built for the documented `ProviderDescriptor` dataclass shape (not a generic Python
expression evaluator): every field value it does not recognize aborts the entire import
(non-zero exit) rather than guessing. A raw-occurrence cross-check
(`parsed count === grep-equivalent 'ProviderDescriptor(' count`) guards against silently
mis-parsing entries. On ANY failure the existing committed snapshot file is left untouched
(last-known-good) — an empty catalog is never treated as a successful import.

### Discovery classification (hand-curated overlay)

`open-sse/config/providers/fccModelDiscoveryClassification.data.ts` — same pattern as
`directCapabilities.data.ts`'s curated judgement layer: per-provider
`STATIC_MODEL_CATALOG | DYNAMIC_MODEL_DISCOVERY | HYBRID | NO_MODEL_DISCOVERY | UNKNOWN`, each
entry citing the exact FCC source file/mechanism it was proven from. A provider with no entry is
`UNKNOWN` — never guessed. This stays a hand-reviewed overlay rather than something the importer
derives automatically, because classifying Python control flow (which base class, which override,
which profile flag) is not something a narrow text parser should attempt — re-verify and update
this file whenever the pinned revision changes.

### Provider mapping additions

Cross-checking the real FCC ids against the current OmniRoute registry (D0's mapping mechanism,
unchanged) surfaced 3 real alias entries FCC's Python-identifier-style ids needed that the D0
illustrative fixture had incorrectly assumed were direct matches: `nvidia_nim → nvidia`,
`open_router → openrouter`, `github_copilot → github` (all added to `FCC_PROVIDER_ID_MAP` in
`fccCatalog.data.ts` with evidence comments). Current coverage against the pinned revision: 50 FCC
providers — 30 `mapped`, 4 `alias`, 16 `fcc_only`, 0 `conflict`; 34 are Jarvis-executable; 9 have a
live OmniRoute `modelsUrl` (`jarvisDiscoverySupported`); 17 are FCC `DYNAMIC_MODEL_DISCOVERY`
(verified), 1 `HYBRID`, 1 `NO_MODEL_DISCOVERY`, 31 `UNKNOWN` (unclassified — not guessed).

### Diff workflow (Schritt 11) and last-known-good (Schritt 12)

`open-sse/services/fccSync.ts::diffFccCatalogSnapshots()` reports `addedProviders`,
`removedProviders`, `changedProviders`, `mappingChanges`, `discoveryChanges`,
`addedStaticModels`/`removedStaticModels`/`changedStaticModels` (the last three over the D0
per-model fixture shape). **Removed is never delete** — nothing in this module, or anywhere in
D3, deletes a provider or model from any Jarvis registry; removals are reported for manual
review only.

`open-sse/config/providers/fccSnapshotValidation.ts::validateFccSnapshotForAdoption()` is the
last-known-good gate a future ingestion job must pass before adopting a new snapshot: schema
shape, a full 40-char `sourceRevision`, a parseable non-future `generatedAt`, no duplicate
provider ids, and no provider that would resolve to a `conflict` mapping against the CURRENT
registry. Any failure keeps the previously-adopted snapshot; an empty candidate is never accepted
as valid.

## D4 Native Claude Code Gateway Visibility (O9-F3.3P1-D4)

D4 was **re-scoped** after a read-only audit found OmniRoute already ships a production Claude
Code gateway mirror — building a second, FCC-shaped `anthropic/<provider>/<model>` encode/decode
system next to it would have duplicated proven infrastructure. D4 therefore adds exactly one
missing piece: a **capability-aware visibility policy** on top of the existing mirrors, and
touches nothing else.

**Existing gateway mirror reused, unchanged, still sole authority for identity/routing:**

- `claude/<provider>/<model>` discovery mirror — `open-sse/utils/ccDiscoveryAliases.ts`
- `no-think/<provider>/<model>` mirror — `open-sse/utils/noThinkingAlias.ts` (itself a prior
  free-claude-code port, "Fase 8.1")
- Decode / request-path wiring — `open-sse/handlers/chatCore/ccDiscoveryAliasStrip.ts`,
  `src/lib/ccDiscoveryAliasResolve.ts`, `applyNoThinkingAlias` — called from every chat transport
  **before** provider resolution, so credential selection, health, quota, model lockout, cost
  policy, and fallback all still run on the real model exactly as for any normal request
- The 3-level (model > provider > global) DB flags — `src/lib/db/ccDiscoveryAliases.ts`,
  `NO_THINKING_ALIAS_ENABLED` — **default off**, unchanged
- **No second encode/decode system.** No FCC `anthropic/…` prefix adopted — Claude Code accepts
  either `claude`- or `anthropic`-prefixed ids per the existing module's own docblock, and
  OmniRoute's `claude/…` shape already has dedicated production test coverage
  (`tests/unit/cc-discovery-alias-*.test.ts`, `tests/unit/no-thinking-alias.test.ts`) proving it
  works — no reason to introduce a second shape.

**What D4 adds**: `open-sse/services/claudeGatewayVisibility.ts`:

- `evaluateClaudeGatewayVisibility(input)` — pure decision function, returns
  `{ visible, reason }` with reasons `visible | feature-disabled | not-executable |
claude-code-ineligible | claude-code-unknown | existing-alias-policy-rejected`.
- `resolveClaudeGatewayCapabilities(provider, model)` — reads `executable` / `claudeCodeEligible`
  directly from `produceCapabilities(extractProviderModelInfo(...))` (D1 → D2), **not** through
  `getProviderRuntimeState`. Deliberate: that function is async, DB-backed, and mixes in
  `providerHealth`/`quotaState`/cost — exactly the transient signals a model _catalog_ must never
  flap on, and exactly the per-model DB cost a catalog build over many models must not pay
  N times. `produceCapabilities` is the same producer `ProviderRuntimeState.capabilities` is
  built from — this reuses that single source of truth, not a duplicate rule set.
- `withClaudeGatewayCapabilityGate(existingPredicate)` — composes `existingPredicate(entry) AND
capabilityGate(entry)`, wired at the `appendCcDiscoveryAliases` call site in
  `catalogResponse.ts` (before mirror synthesis, so a rejected model never gets a wasted
  `claude/…` entry allocated).
- `filterNoThinkingMirrorsByCapability(models)` — post-filters the no-think mirrors
  `appendNoThinkingVariants` already appended, removing ones that fail the new gate.
  Post-filter (not an injected predicate) specifically so `noThinkingAlias.ts`'s own frozen
  contract is never touched.

Both integration points sit strictly **inside** the pre-existing flag guards in
`catalogResponse.ts` — with every flag off, neither runs, and `/v1/models` is unchanged. With a
flag on, only mirrors that also pass the new gate survive; every other catalog entry (including
combos and bare-id entries, which D1/D2 have no capability facts for) passes through unmodified.

**Visibility contract** (fail-closed, mirrors the D0/D2 invariants exactly — nothing new):

- `executable` must be exactly `true` — registry-proven, not transient. `false`/`null` reject.
- `claudeCodeEligible` must be exactly `true`. `null` (unknown) and `false` (proven negative) both
  reject, with distinct reasons. **`null → true` is never done.**
- FCC (D3) provider-catalog presence alone is **insufficient** by construction: D1's
  `extractProviderModelInfo` does not read FCC evidence today, so "FCC knows this provider" cannot
  leak into `claudeCodeEligible` through this path at all — matching the D3 finding that FCC's
  provider catalog is not a model capability catalog, and the D0 invariant that FCC is
  corroborating evidence, never an availability dependency. An `fcc_only` or `conflict`-mapped
  provider id simply fails the `executable` check (unregistered in Jarvis), same as any other
  unknown provider — no FCC-specific carve-out exists or is needed.
- Currently `claudeCodeReady` (the D1 curated fact `claudeCodeEligible` derives from) is
  **unseeded for every direct provider** — so today, turning the `claude/…` mirror flag on
  advertises **nothing** via this gate until a real research pass proves specific
  provider/model pairs. This is the intended, fail-closed consequence, not a bug — flagging it
  because an operator who already has the flag on will see previously-visible mirrors disappear.

**Not in D4** (explicit boundary): FCC ranking/preferred-candidate wiring into `combo.ts` live
scoring is **D5**; actually starting Claude Code, setting `ANTHROPIC_BASE_URL` /
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, or any Shadow-container activation is **D6**. D4
ships the gate off-by-default alongside the (already off-by-default) mirrors it composes with —
no behavior changes for any deployment that hasn't already opted into the mirror flags.

## D4.1 Claude Code Compatibility Evidence (O9-F3.3P1-D4.1, Tranche 1)

D4's visibility gate measured 0/2685 registry models visible — correct and fail-closed, but
useless without real evidence behind `claudeCodeReady`. D4.1 seeds a first, narrow, fully-cited
tranche of that evidence into `directCapabilities.data.ts`'s `DIRECT_PROVIDER_JUDGEMENTS` — **the
gate's own logic was never touched or loosened.**

### Compatibility contract (derived from existing code, not invented)

"Claude Code compatible via OmniRoute" is **not** about
`open-sse/services/claudeCodeCompatible.ts` — that module is an unrelated wire-image relay bridge
for third-party gateways mimicking the exact official Claude Code client (Stainless headers,
request signing); it gates on an `anthropic-compatible-cc-*` provider prefix / `usesCcWireImage()`
opt-in and none of Groq/Gemini/NVIDIA/Cerebras are that. The real contract is: `Claude Code
request (Anthropic Messages shape) → OmniRoute Anthropic ingress → translator → provider →
tool/streaming/response roundtrip → Claude Code` must hold. Traced and confirmed generic (not
per-provider) for every `format:"openai"` provider via
`open-sse/translator/request/claude-to-openai.ts` /
`open-sse/translator/response/openai-to-claude.ts`, and for `format:"gemini"` via the
`claude-to-gemini.ts` / `gemini-to-claude.ts` pair — both proven by existing, real (non-mocked)
regression tests (`tests/unit/nvidia-tool-compatibility-2840.test.ts`,
`anthropic-toolcall-args-6459.test.ts`, `translator-tool-call-shim.test.ts`,
`translator-resp-openai-to-claude.test.ts`). Reasoning/thinking is confirmed **not** a
prerequisite — the translator handles it as optional throughout.

**Minimal evidence bar for `claudeCodeReady: true`**: a per-model `toolCalling` fact must already
be proven (`RegistryModel.toolCalling` or static `ModelSpec.supportsTools`) AND the provider
routes through one of the two generically-tested translator pairs above AND no known fatal
incompatibility exists for that model. **`false`** requires an actual proven negative
(`toolCalling: false`) — never merely-missing evidence. Everything else stays `null`.

### Evidence sources used (and one explicitly rejected)

Per the established D0 priority (`shadow_validation > existing OmniRoute tests > FCC model
evidence > models.dev > registry/static facts`): no `shadow_validation` data exists yet;
`models.dev` is confirmed to not exist as a real integration in this codebase (grep-verified —
only a placeholder `EvidenceSource` enum value); the existing translator regression tests prove
the _mechanism_; the registry/static-fact layer supplies the _per-model_ tool-calling proof.
**FCC provider presence alone was explicitly rejected as insufficient**: FCC needing no
Groq/Gemini/Cerebras-specific tool-calling workaround in its own code is provider-level
circumstantial evidence, not a per-model proof — never the sole basis for an entry here (matches
the D0/D3 invariant that FCC presence never grants eligibility on its own).

### Tranche 1 result

| Provider   | Models considered                                                 | `claudeCodeReady: true`                                                                                                                           | `claudeCodeReady: false`                                                       | Unseeded (null)                                                                                                                                    |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini     | 8                                                                 | **7** (all chat models with registry `toolCalling: true`)                                                                                         | 0                                                                              | 1 (TTS-only model, no tool-calling fact)                                                                                                           |
| NVIDIA     | 12                                                                | **3** (static `ModelSpec.supportsTools: true` for `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro-0813`, `deepseek-ai/deepseek-v4-flash-0731`) | **1** (`openai/gpt-oss-120b`, registry `toolCalling: false` — proven negative) | 8                                                                                                                                                  |
| Groq       | 10                                                                | 0                                                                                                                                                 | 0                                                                              | **10** — zero per-model tool-calling facts exist anywhere in the registry or static-spec layer for any Groq model today                            |
| Cerebras   | 3                                                                 | 0                                                                                                                                                 | 0                                                                              | **3** — same reason; optional per Schritt 12, evidence insufficient                                                                                |
| OpenRouter | 1 (`auto`, static registry only — real catalog is dynamic/synced) | 0                                                                                                                                                 | 0                                                                              | 1 — no per-model discovery evidence is wired into D1 for OpenRouter's dynamic catalog today; deferred to D5/D6, **no blanket `openrouter → true`** |

**Groq/Cerebras are not a defect** — this is the honest outcome of a real evidence search, not a
gap in D4.1's effort. No provider-wide `"*"` inheritance was used for `claudeCodeReady` anywhere
(unlike Groq's pre-existing `latencyClass` `"*"` default, a different field seeded in D0/D1).

### Visibility impact (same audit methodology as D4's, re-run after seeding)

|                                                                      | Before D4.1 | After D4.1 |
| -------------------------------------------------------------------- | ----------- | ---------- |
| `claudeCodeEligible = true`                                          | 0           | **10**     |
| `claudeCodeEligible = false`                                         | 0           | **1**      |
| `claudeCodeEligible = null`                                          | 2685        | 2674       |
| Normal `claude/…` aliases visible (flags simulated ON)               | 0           | **10**     |
| No-think `no-think/…` aliases visible (capability-gate contribution) | 0           | **10**     |

Provider presence (executable=true for 2685/2685 models throughout, unchanged) never explains any
of this — the entire delta is exactly the 10 seeded `true` verdicts. Technical Claude-Code
compatibility remains completely independent of cost/free classification throughout: Cerebras's
recurring-daily trial status (O9-F3.3P1-C1) and Groq's quota semantics (O9-F3.3P1-C2) were not
read, referenced, or altered by any part of this evidence layer.

## D4.2 Groq Re-Verification (O9-F3.3P1-D4.2)

A dedicated, Groq-only re-pass over D4.1's evidence question, run in isolation to make sure the
"10 unseeded" result wasn't an artifact of D4.1's broader multi-provider sweep. Scope was
constrained to in-repo evidence only — no provider requests, no models.dev sync, no production/
shadow actions.

**Checked, per Groq registry model** (`open-sse/config/providers/registry/groq/index.ts`, 10
models: `meta-llama/llama-4-scout-17b-16e-instruct`, `llama-3.3-70b-versatile`, `groq/compound`,
`allam-2-7b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3-32b`, `qwen/qwen3.6-27b`,
`qwen/qwen3.8-27b`, `openai/gpt-oss-safeguard-20b`):

- Registry `toolCalling` field — absent on all 10 entries.
- Static `ModelSpec.supportsTools` (`src/shared/constants/modelSpecs.ts`) — no exact or
  prefix-matched spec exists for any of the 10 (the visually-similar `qwen3-max` /
  `qwen3.6-plus` / `qwen3.8-max-preview` entries are a different Alibaba Qwen3-Max/Plus family
  and do not prefix-match Groq's `qwen3-32b` / `qwen3.6-27b` / `qwen3.8-27b`).
- Existing Groq-specific tests (`groq-field-strip-wiring`, `groq-quota-semantics`,
  `thinking-budget-groq-12134`, `thinking-budget-groq-3258`) — none assert tool-calling behavior.
- Generic translator/tool-roundtrip tests (`translator-tool-call-shim`,
  `anthropic-toolcall-args-6459`, `nvidia-tool-compatibility-2840`) — confirmed provider-agnostic
  (no Groq references); proves the mechanism only, not a per-model fact, per the D4.1 "AND" bar.
- models.dev — no committed in-repo snapshot with Groq tool-calling data; the only pathway
  (`src/lib/modelsDevSync.ts`) is a live/DB-backed runtime layer D1 deliberately excludes from
  static extraction — out of scope here (no provider requests).
- FCC provider presence (`mapFccProvider("groq")` maps) — confirmed insufficient by construction,
  per the existing D0/D4.1 invariant; not used.

**Result: 0 true / 0 false / 10 unknown — identical to D4.1.** Already locked in by
`tests/unit/claudeCodeCompatEvidence.test.ts` test 9, which enumerates the real Groq model list
and asserts every one stays `claudeCodeEligible: null`. No new evidence surfaced, so no change was
made to `directCapabilities.data.ts`'s `DIRECT_PROVIDER_JUDGEMENTS.groq` block, and no test was
added (the existing test 9 already covers this exact invariant by id). Fail-closed contract
preserved; D4's gate logic untouched.

## P4-C Claude Code Evidence for Zero-Cost Candidates (O9-F3.4 P4-C)

Re-ran the unchanged D4.1 bar (model-specific tool-calling fact + one of the two generically
tested translator pairs + no known fatal conflict) against every zero-cost candidate. Result:
**no new `true`, no new `false`** — still 10 / 1 / 2674 of 2685.

| Candidate                                                                                    | `verifiedFree`      | Model-specific tool fact     | Verdict | Why it stays `null`                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------- | ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groq `openai/gpt-oss-120b`, `-20b`, `-safeguard-20b`, `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b` | true                | none                         | null    | Same as D4.2. FCC's `test_groq.py` proves `tool_use` → `tool_calls` translation with a generic model id: mechanism only, not a per-model fact.                                                                                                                                                                                        |
| OpenRouter `auto`, `stealth/ox-alpha`, `liquid/lfm-2.5-2.6b:free`                            | true                | none in D1                   | null    | `auto` picks a different upstream per request, so no single model can be proven. The others only have OpenRouter's runtime `supported_parameters` metadata (catalog/DB layer, excluded from D1 by design), and a `:free` variant can reach different upstream endpoints. FCC filters on the same metadata — supporting evidence only. |
| `mlx-gemma`, `mlx-qwen`                                                                      | null (uncatalogued) | registry `toolCalling: true` | null    | Tool calling on a self-hosted server is a property of the operator's deployment (server version, chat template), not the model. The registry value is only re-asserted by a shape test (`mlx-provider.test.ts`); no deployment-level evidence exists.                                                                                 |
| The other 10 self-hosted providers                                                           | —                   | —                            | null    | No `open-sse` registry entry, so D2 `executable` is `null` and the D4 gate rejects them regardless.                                                                                                                                                                                                                                   |

Zero-cost ∩ Claude Code (`verifiedFree` and `claudeCodeEligible` both `true`) is exactly the four
recurring-free Gemini models. P4-B connection safety is `null` for every stored connection today,
so none is route-eligible yet. All of this is pinned by `tests/unit/claudeCodeEvidenceP4c.test.ts`.

What would move a candidate: one live Claude Code tool roundtrip through Shadow per model (D6-L3
style) — deferred; it needs operator approval and, for Groq, a connection that does not exist yet.

## P4-D Groq Live-Evidence Preparation (O9-F3.4 P4-D)

Audit only — no capability data changed; Groq stays 0 `true` / 0 `false`.

**Zero-cost set (current repo):** `openai/gpt-oss-120b`, `openai/gpt-oss-20b`,
`openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b` — all `recurring-daily`
with `hardStopGuaranteed: true` (cited from Groq's rate-limit and billing pages), executable,
`toolCalling: null`, `claudeCodeEligible: null`.

**Path:** Claude Code → `/v1/messages` → `claude-to-openai.ts` → executor `base.ts`
(`sanitizeReasoningEffortForProvider`, then `stripGroqUnsupportedFields`) → Groq
`/openai/v1/chat/completions` → `openai-to-claude.ts`. Only the field strip is Groq-specific;
nothing is model-specific. Jarvis tests cover the strip and the `reasoning_effort` keep/strip rules
(#3258, #12134) — none covers Groq tool calls.

**Protocol risks the live test must resolve:**

- Assistant thinking history goes out as message-level `reasoning_content` (Groq has no
  `reasoningTransport`, so the plaintext default applies). FCC replays it as `<think>` tags for
  Groq instead. The generic 400 field-downgrade (`KNOWN_OFFENDING_FIELDS`) only strips top-level
  fields, so it would not recover this. Most likely to surface on the tool-result continuation.
- `reasoning_effort`: no Groq branch and no `supportsXHighEffort` opt-out, so `xhigh` passes
  through. The generic 400/422 enum clamp-and-retry recovers only if Groq's error lists accepted
  values; Qwen models on Groq use a different value set.
- Request size: Groq free-tier TPM limits are not recorded in the repo, while a Claude Code prompt
  carries every tool schema. The test should record `x-ratelimit-limit-tokens`.

**Connection safety:** `connectionBillingCatalog.ts` has no Groq entry and a new key carries no
evidence, so `resolveConnectionZeroCostSafety` is `null`. The model-level hard stop describes the
Free plan (no payment method on file); a Developer-tier key on the same models can bill. Safe
requires provider-observed `billingLinked: false` for that key, or a curated Groq contract.

**Future test model: `openai/gpt-oss-120b`** — recurring free with a hard stop; one of the two
Groq models with Jarvis reasoning-path tests (#3258, #12134, both keep `reasoning_effort`);
general-purpose, unlike the safeguard classifier; avoids the Qwen `reasoning_effort` value risk;
the larger gpt-oss model for a tool-calling test.

**Live sequence (not run):** operator adds a Groq key through the Shadow dashboard provider page;
verify metadata only; isolated Claude Code addressing the model explicitly with `--model` —
discovery will not list it while `claudeCodeEligible` is `null` (D4 fails closed), which is
itself a check; one text request (`JARVIS_GROQ_OK`); one read-only `pwd` roundtrip; observe
streaming, tool call, tool-result continuation, finish reason, rate-limit headers, health,
fallback and protocol errors. A text-only pass never justifies `true`. Pinned by
`tests/unit/groqLiveEvidenceP4d.test.ts`.

## P4-E Groq Live Evidence (O9-F3.4 P4-E)

The P4-D sequence ran against Jarvis Shadow for exactly one model, **`groq/openai/gpt-oss-120b`**,
and promoted it to `claudeCodeEligible: true`. This supersedes the "Groq stays null" results of
D4.2, P4-C and P4-D for this model only.

**Run:** isolated Claude Code (`--bare`, temporary home, empty working directory), explicit
`--model groq/openai/gpt-oss-120b` against the Shadow API. Discovery was checked first:
`/v1/models` exposed no `claude/` alias for Groq while the model was `null`.

| Check               | Result                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text                | Returned exactly `JARVIS_GROQ_OK`; streamed; Groq `finish_reason: stop` → Claude `end_turn`                                                             |
| Tool call           | One `Bash` `tool_use` with `{"command":"pwd"}`; Groq `finish_reason: tool_calls`                                                                        |
| Tool result         | `tool_result` with the same id accepted; Groq continuation ended `stop` with the correct directory; no file written                                     |
| Provider / fallback | Every request row `provider=groq`, `model=openai/gpt-oss-120b`, same connection; no combo, no fallback                                                  |
| Reasoning           | Groq returned `reasoning_content` on every response; mapped to Claude `thinking` blocks; the replayed thinking on the tool continuation raised no error |
| Health              | Connection stayed active, no rate limit, backoff 0                                                                                                      |

**Recorded as:** registry `toolCalling: true` on the Groq `openai/gpt-oss-120b` entry (the
per-model fact) plus `claudeCodeReady: true` in `DIRECT_PROVIDER_JUDGEMENTS.groq` — the same
semantics as the Gemini/NVIDIA seeds. No `"*"` entry, no sibling inheritance: `openai/gpt-oss-20b`,
`openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b` and `qwen/qwen3.8-27b` stay `null`. Registry
verdicts are now 11 `true` / 1 `false` / 2673 `null` of 2685, and zero-cost ∩ Claude Code is the
four Gemini models plus this one. The D4 gate admits the model once the running image contains
this change and `EXPOSE_CC_DISCOVERY_ALIASES` is on; Shadow still runs the pre-promotion image.

**Cost separation:** unchanged. `verifiedFree` and `hardStopGuaranteed` are model facts that
already existed. The Shadow Groq connection carries no billing evidence, so
`connectionSafeForZeroCost` stays `null` and `evaluateZeroCostRoute` rejects the route with
`connection-safety-unknown`. Claude compatibility never implies zero-cost eligibility.

**Limits:** one text run and one single-tool roundtrip are evidence for this model, not for the
siblings or every protocol edge (parallel tool calls, tool errors, long context, `xhigh` effort).
Groq's `x-ratelimit-*` headers were not captured: Shadow does not store raw upstream headers, and
the translated upstream request (so whether `reasoning_effort` was sent) is not logged either.

**Observability gaps (documented, not fixed):**

- The Shadow call-log detail artifact recorded the streamed tool-call `arguments` as an empty
  string, while Claude Code received `{"command":"pwd"}` and the roundtrip succeeded. This is a
  log-reconstruction gap, not a protocol incompatibility.
- The text run triggered Claude Code's automatic session-title request, a second Groq request
  that was neither a retry nor a fallback. Naming the session (`-n`) avoided it on the tool run.

Pinned by `tests/unit/groqLiveEvidenceP4e.test.ts`.

## P4-G Groq Connection Zero-Cost Safety (O9-F3.4 P4-G)

Audit only — no runtime, data or connection change. Verdict for the Shadow Groq connection:
**`connectionSafeForZeroCost` stays `null`**, and that is the intended fail-closed result.

**Where the model stands:** `groq/openai/gpt-oss-120b` is Claude-Code compatible (P4-E), with
`verifiedFree: true` and `hardStopGuaranteed: true`. The connection has no billing evidence, so
`resolveConnectionZeroCostSafety` (`open-sse/services/autoCombo/connectionBilling.ts`) returns
`insufficient-evidence` and `evaluateZeroCostRoute` rejects the route with
`connection-safety-unknown`. The live STRICT_ZERO_COST filter excludes it independently: Groq has
no usage fetcher (`open-sse/services/usage/fetcherProviders.ts`), so its live quota state is
UNKNOWN.

**What Groq's published contract gives:** the Free plan has finite per-model limits and answers
overuse with `429` ([rate limits](https://console.groq.com/docs/rate-limits)). Moving to the
pay-as-you-go Developer tier requires adding a payment method
([billing FAQs](https://console.groq.com/docs/billing-faqs)). Spend limits exist only on paid plans
and apply organization-wide across all API keys
([spend limits](https://console.groq.com/docs/spend-limits)), so they are not a Free-plan safety
mechanism. The docs do not state outright that a Free-plan account can never be charged.

**The missing proof is account-specific.** The hard stop holds for a Free-plan organization, but
Jarvis cannot authoritatively determine that the organization behind this exact API key is still
on the Free plan:

- The Groq API exposes no organization, plan, billing or usage endpoint
  ([API reference](https://console.groq.com/docs/api-reference)); the only authoritative source is
  the Groq console billing page.
- `authType: apikey` proves nothing about the tier, and the stored connection holds only
  `importFreeModelsOnly` (a model-import filter).
- An operator-declared "Free Plan" must not prove safe: the P4-B rule stands, and an
  operator-declared `billingLinked: false` resolves to `null` (`unverified-not-linked`).
- The plan belongs to the organization and can change later — an upgrade — without the stored API
  key changing, which would silently change billing for the same connection.

So no Groq `hard-stop` entry belongs in `connectionBillingCatalog.ts`, and connection safety stays
fail-closed.

**Checked, not a risk today:** Jarvis never sets `service_tier` for Groq —
`resolveEffectiveServiceTier` (`open-sse/handlers/chatCore/serviceTier.ts`) returns `"standard"` for
every provider except Codex — so Groq applies its default `on_demand` tier. A `service_tier` sent by
an OpenAI-format client is not stripped for Groq; `flex` is paid-only and priced like on-demand
([flex processing](https://console.groq.com/docs/flex-processing)). Groq model permissions ("Only
Allow" / "Only Block" per organization or project,
[model permissions](https://console.groq.com/docs/model-permissions)) narrow which models a key can
reach; they are defense-in-depth, not billing proof.

**Recommended future defense-in-depth (not implemented):**

1. A dedicated Groq organization for Jarvis.
2. No payment method on it.
3. Allow only the approved free models (model permissions, "Only Allow").
4. If that organization is ever upgraded, record `billingLinked: true` on the connection
   immediately (already treated as unsafe).
5. Optionally collect the `x-ratelimit-*` response headers as corroborating telemetry only — they
   are not authoritative tier evidence.

## P4-H OpenRouter North Mini Code Evidence (O9-F3.4 P4-H1 / P4-H2)

**P4-H1 (free evidence):** `openrouter/auto` was removed from `freeModelCatalog.data.ts`. It is
OpenRouter's Auto Router, which picks the upstream model per request, paid models included, so
no exact model is proven free; `verifiedFree` is now `null`. `cohere/north-mini-code:free` was
added as `recurring-daily`: an explicit `:free` variant with one upstream endpoint (Cohere)
priced $0 input and output. Only input and output price were checked.

**P4-H2 (Claude-Code compatibility):** `openrouter/cohere/north-mini-code:free` is promoted to
`claudeCodeEligible: true`. The model is learned from OpenRouter's live model catalog; its tool
fact is an exact curated entry, `DIRECT_MODEL_FACTS.openrouter` (`toolCalling: true`), read only by
`extractProviderModelInfo`, plus `DIRECT_PROVIDER_JUDGEMENTS.openrouter` with that single key — no
`"*"` entry. It is intentionally **not** a static OpenRouter registry row: the static model list
feeds AutoCombo's fallback pool and the quota-combo sync, and adding a row would have changed
generic routing. OpenRouter joins `DIRECT_CAPABILITY_PROVIDERS` as a judgement-only member (that
list has no runtime consumer).

Fresh evidence, from an isolated Claude Code session against Shadow with an explicit
`--model openrouter/cohere/north-mini-code:free`:

| Check               | Result                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Text                | Returned exactly the requested sentinel string; streamed; `finish_reason: stop` → Claude `end_turn`          |
| Tool call           | One `Bash` `tool_use` with `{"command":"pwd"}`; `finish_reason: tool_calls`                                  |
| Tool result         | `tool_result` with the same call id accepted; continuation ended `stop` with the correct directory           |
| Provider / fallback | Every row `provider=openrouter`, `model=cohere/north-mini-code:free`, same connection; no combo, no fallback |
| Reasoning           | `reasoning_content` mapped to thinking blocks; replayed thinking raised no error                             |
| `max_tokens`        | Claude Code sent 32000; accepted (the model's maximum output is 64K)                                         |

Supporting evidence: 57 earlier Claude-ingress calls for the same model in the Shadow call logs
(2026-09-09), with streaming, tool calls and tool-result continuations.

**Limits:** one fresh text run and one single-tool roundtrip, plus historical calls. This is
evidence for this exact model only — not for other OpenRouter, Cohere or `:free` models, not for
every protocol edge case, and not for billing: `connectionSafeForZeroCost` stays `null` and there
is no `hardStopGuaranteed`, so the route stays `connection-safety-unknown`. OpenRouter free
availability can change.

**Counts:** registry verdicts stay 11 `true` / 1 `false` / 2673 `null` of 2685, because the model
is not a registry row. Registry counts are not the same universe as every discoverable compatible
model: outside the registry there is one curated live-catalog fact,
`openrouter/cohere/north-mini-code:free = true`, which also makes it the only non-registry model in
the effective free ∩ Claude-Code set. OpenRouter's static model list stays `auto` only, so no new
AutoCombo fallback candidate or quota combo exists.

**Deferred follow-up:** provider-observed OpenRouter zero-price evidence (exact `:free` ids only,
never routers, every pricing field 0, freshness-tracked, revoked on disappearance or price change)
on top of this curated baseline. Not implemented. Pinned by
`tests/unit/openrouterFreeEvidenceP4h1.test.ts` and `tests/unit/openrouterNorthMiniP4h2.test.ts`.

## D5 FCC Preferred-Candidate Ranking Wiring (O9-F3.3P1-D5)

D5 wires D0's already-built, already-tested `computeFccRankingSignal` (`fccRankingSignal.ts`) into
live AutoCombo scoring — the one piece D0 explicitly deferred ("This module is NOT wired into
`combo.ts` scoring yet"). It adds exactly one thing: a **soft, additive ranking factor** on top of
candidates that have ALREADY passed the existing hard eligibility gate. It does **not** grant
eligibility, does **not** unlock any model, and does **not** touch D1–D4's fact layer, D4.1/D4.2's
evidence, or health/quota/cost policy.

### Hard eligibility vs. soft FCC preference

These stay two different things, on purpose (Schritt 2 of the D5 spec):

- **`claudeCodeEligible`** (D1/D2, curated from registry/static/models.dev/shadow-validation
  facts) — the HARD FACT/HARD GATE. Can come from several evidence sources; D5 does not touch how
  it is computed, and cannot turn a `null`/`false` verdict into `true`.
- **FCC evidence** (`fccKnown`, `fccClaudeCodeCompatible`, …) — a SOFT, purely additive ranking
  signal, only ever consulted once the hard gate has already passed. Not a second eligibility
  source.
- **Runtime state** (health, quota, cooldown, cost, model lockout, connection state) — unchanged,
  untouched, remains sole authority. FCC preference can never override it (see "Quota/status
  interaction" below).

### What was added

- `open-sse/services/fccRankingSignal.ts` — `resolveFccPreferenceSignal(provider, model): number`,
  a thin wrapper that feeds the UNCHANGED D0 `computeFccRankingSignal` with real D1/D2 facts
  (`extractProviderModelInfo` → `produceCapabilities`) instead of a test fixture. Returns `1` only
  when `executable === true` AND `claudeCodeEligible === true` AND FCC's own
  `fccClaudeCodeCompatible === true` (not merely `applies === true` — see the function's docblock
  for why `applies` alone is not sufficient). Otherwise `0`, never a penalty.
- `open-sse/services/combo.ts` (`buildAutoCandidates`) — one field added to the already-existing
  per-candidate object: `fccPreference: resolveFccPreferenceSignal(provider, model)`. Pure,
  DB-free, computed inline alongside the existing `quality` signal — no new async work, no DB
  query, no provider request.
- `open-sse/services/autoCombo/scoring.ts` — `ProviderCandidate.fccPreference` (raw fact),
  `ScoringFactors.fccPreference` (route-scoped value), `ScoringWeights.fccPreference` (weight,
  default `0`), and `calculateScore`'s weighted sum extended by one additive term. The 14 existing
  factors are byte-unchanged in meaning.
- `src/shared/validation/schemas/combo.ts` (`scoringWeightsSchema`) and
  `src/lib/combos/intelligentRouting.ts` (`DEFAULT_INTELLIGENT_WEIGHTS` / `IntelligentRoutingWeights`
  / `normalizeIntelligentRoutingConfig`) — kept in sync with `DEFAULT_WEIGHTS`, exactly as the
  existing `combo-scoring-weights-schema-coverage.test.ts` already requires for every scorer
  factor (this is not new surface D5 invented; it is the existing "every weight must be declared
  in three places" contract, now covering one more field).

### Route scope

The factor is **route-scoped**, not global (Schritt 6): `calculateFactors` reads
`candidate.fccPreference` only when `taskType === "coding"` — the EXISTING, already-classified
routing signal (`intentClassifier.ts` → `mapIntentToTaskType`). On every other route (`"default"`,
`"analysis"`) the factor evaluates to exactly `0` regardless of the candidate's raw value. No new
route-detection mechanism was added, and there is no global "FCC model is always better" bias.

### Default weight is 0 — no routing change until explicitly enabled

`DEFAULT_WEIGHTS.fccPreference = 0`, declared but silent — the exact same pattern already used for
`cacheAffinity`, `resetWindowAffinity`, and `reliability`. With the default weight, every scoring
formula term this factor contributes is `0 * factors.fccPreference`, so **live routing is
byte-identical to pre-D5** regardless of what `fccPreference` resolves to per candidate. Raising
this weight above 0 is a deliberate, later, explicit operator decision — that activation point is
**D6**, not this change.

### Quota/status interaction

Existing `QUOTA_SOFT_DEPRIORITIZE_FACTOR` / `STATUS_SOFT_DEPRIORITIZE_FACTOR` and their application
order in `autoStrategy.ts`'s `scoreAutoTargets` are untouched — D5 did not modify `autoStrategy.ts`
at all. At a realistic activation weight (tested at `0.05`, the same order of magnitude as
`quality`'s `0.03`), a quota-soft-penalized or status-penalized candidate with `fccPreference`
still ranks strictly below an identical healthy, non-preferred candidate — the soft penalty
multiplier is applied to the WHOLE score (base + FCC term alike), so it still dominates at any
weight an operator would plausibly set. This is a soft, not absolute, guarantee: an operator who
set `fccPreference` far above every other weight could in principle out-weigh a `0.5`/`0.7`
multiplicative penalty — the correct fix for that hypothetical is a sane weight, never a new magic
constant invented to force the ordering (Schritt 11), and D6's activation should set a small value
for exactly this reason.

### FCC data reality (Schritt 14 — documented, not fixed here)

`fccCatalog.data.ts` remains the D0 fixture-illustrative dataset (3 entries: groq, cerebras,
targon) — D3 only synced the FCC **provider-descriptor** catalog, not a per-model capability
catalog (see the D3 section above). `resolveFccPreferenceSignal` is production-shaped and fully
wired end-to-end, but with only 3 fixture rows and `DEFAULT_WEIGHTS.fccPreference = 0`, it has
**zero observable effect on live routing today**. Confirmed by test: Cerebras' `gpt-oss-120b`
(fixture `claudeCode.compatible: true`) resolves to `0` because it has no proven
`claudeCodeEligible` fact (D4.1/D4.2). Groq's `gpt-oss-120b` resolved to `0` for the same reason
until O9-F3.4 P4-E proved `claudeCodeEligible` from live Shadow evidence; it now resolves to `1`,
which the weight of `0` still multiplies away. The hard gate is doing exactly what it is supposed
to do against real data. Before D6 raises the weight, either the fixture should
be replaced by a real synced FCC snapshot, or the D6 activation must say explicitly why it is
proceeding without one.

Also per Schritt 14: `resolveFccPreferenceSignal` does a direct `getFccEvidence(provider, model)`
lookup, i.e. assumes the Jarvis provider id equals the FCC provider id. True for every provider
`directCapabilities.data.ts` currently seeds (groq, cerebras, gemini, nvidia), but not for the 3
providers in `FCC_PROVIDER_ID_MAP` whose FCC id differs (`nvidia_nim`→`nvidia`,
`open_router`→`openrouter`, `cloudflare`→`cloudflare-ai`) — for those, real FCC evidence keyed
under the FCC spelling would be silently missed (never a false positive). The fixture has zero
entries under any of those 3 FCC ids today, so this has no observable effect right now; a
`FCC_PROVIDER_ID_MAP` reverse lookup was deliberately not built for D5 (no evidence to serve it
yet).

### Not in D5 (explicit boundary)

No `claudeCodeReady`/`claudeCodeEligible` value changed (D4.1 counts stay 10 true / 1 false / 2674
null; Groq stays 0/0/10; Cerebras and OpenRouter stay unseeded — no unlock). No cost/free
classification touched (Cerebras C1, Groq C2 untouched). No production/shadow activation — that is
**D6**: setting a nonzero `fccPreference` weight, and/or `ANTHROPIC_BASE_URL` /
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` activation, remain a separate, later, controlled step.

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
- **F3.3P1-C2**: Groq quota/error/runtime-state semantics — **COMPLETE**
- **F3.3P1-D1**: Direct Provider Capability Metadata (`ProviderModelInfo` + pure
  extraction) — **COMPLETE**
- **F3.3P1-D2**: Capability → Eligibility Producer (`executable`, `fastEligible`,
  `codingEligible`, `genericToolEligible`, `claudeCodeEligible`, `supervisorEligible`) — **COMPLETE**
- **F3.3P1-D0**: FCC Preferred Catalog Integration Foundation (evidence-source priority,
  provider/model mapping, ranking signal, sync design) — **COMPLETE**; ranking signal not yet
  wired into `combo.ts`
- **F3.3P1-D3**: FCC Upstream Catalog Snapshot & Sync (real pinned-revision provider snapshot,
  discovery classification, provider-level diff, last-known-good validation) — **COMPLETE**;
  snapshot/diff not yet wired into live routing
- **F3.3P1-D4**: Native Claude Code Gateway Visibility (capability-aware gate composed onto the
  existing `claude/…` / `no-think/…` mirrors — no new gateway-id system) — **COMPLETE**
- **F3.3P1-D4.1**: Claude Code Compatibility Evidence, Tranche 1 (Gemini 7 true, NVIDIA 3 true +
  1 false; Groq/Cerebras/OpenRouter unseeded — insufficient per-model evidence) — **COMPLETE
  (this change, pending review)**; 10 models now visible via the D4 gate, up from 0
- **F3.3P1-D4.2**: Groq Claude Code Compatibility Evidence, dedicated re-verification — **COMPLETE,
  no-op (2026-09-11)**; confirms D4.1's 0 true / 0 false / 10 unknown for Groq, no new evidence,
  no code/data change
- **F3.3P1-D5**: FCC ranking / preferred-candidate selection wiring into `combo.ts` live scoring —
  **COMPLETE / COMMITTED / PUSHED** (2026-09-11, commit `daa750704`), inert by default; `fccPreference`
  factor wired end-to-end at `DEFAULT_WEIGHTS.fccPreference = 0` — see "D5 FCC Preferred-Candidate
  Ranking Wiring" above
- **F3.3P1-D6**: Controlled Shadow activation (Claude Code launch, `ANTHROPIC_BASE_URL` /
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, live provider requests) — **NOT STARTED**
- **F3.3P1** (remaining): verified-free discovery, credential wiring — **NOT STARTED**
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

## Provider Observation Inventory (O9-F3.5 A2)

Core rule: **observe everything, route selectively.**

```
PROVIDER
  ↓
PURE FETCH/PARSE            (discovery/configuredCatalogFetch.ts — shared with the native /models route)
  ↓
OBSERVATION INVENTORY       (key_value namespace "providerObservedModels", one row per connection)
  ↓
EVIDENCE RESOLUTION         (src/lib/providerOnboarding/evidence.ts)
  ↓
READY / VALIDATION_REQUIRED / KNOWN_INCOMPATIBLE / HIDDEN
  ↓
SEPARATE ACTIVATION POLICY  (not part of A2)
  ↓
SYNCED / CUSTOM / ROUTING
```

These sets stay distinct: observed ≠ synced ≠ custom ≠ routable ≠ AutoCombo-eligible ≠
Claude-compatible ≠ verified-free ≠ zero-cost-eligible. An observation alone has no routing
effect.

### Pieces

- `fetchConfiguredProviderCatalog` / `resolveConfiguredCatalogUrl`
  (`src/app/api/providers/[id]/models/discovery/configuredCatalogFetch.ts`): the generic
  `PROVIDER_MODELS_CONFIG` request + pagination + provider parser, extracted from the native
  `/api/providers/[id]/models` route, which now calls it too. It never persists.
- `refreshConnectionObservations`
  (`src/app/api/providers/[id]/models/discovery/providerObservationRefresh.ts`): callable
  refresh for one connection, opt-in per provider (`OBSERVATION_CATALOG_PROVIDERS`: `nvidia`,
  `openrouter`). Not wired to any route, hook or timer.
- `applyObservationRefresh` (`src/lib/providerOnboarding/catalog.ts`): refresh semantics.
- `getProviderObservationInventory` / `saveProviderObservationInventory`
  (`src/lib/db/providerObservedModels.ts`): the only writer; no other module reads the namespace.
- `resolveProviderObservations` (`src/lib/providerOnboarding/onboarding.ts`): derived status
  and provider summary, computed on read, never persisted.

### Refresh semantics

- Listed model: `currentlyObserved=true`, `lastObservedAt` updated, `firstObservedAt` kept.
- New model: new row, `firstObservedAt = lastObservedAt = now`.
- Model missing from the newest successful catalog: row kept, `currentlyObserved=false`.
  History is never deleted automatically.
- Failed request (`http-<status>`, `network-error`, `fetch-error`) or empty catalog
  (`degraded`): models untouched, only `lastAttemptAt` / `refreshStatus` / `refreshError`
  change. Upstream error text is never stored.
- Observation fields copy only what the upstream sent; NVIDIA sends `id`/`owned_by` only, so
  name, context, pricing, tools and streaming stay `null`. An observed `toolCallingObserved`
  is metadata, never capability evidence.

### Derived status

- **Known incompatible**: `claudeCodeEligible === false` (a proven FALSE always wins).
- **Hidden**: not currently observed, operator-hidden, or `executable === false`.
- **Ready**: current, `executable === true`, `claudeCodeEligible === true`.
- **Validation required**: everything else (unknown stays `null`).
- `zeroCostEligible` is a separate flag from the existing `evaluateZeroCostRoute` contract;
  READY never implies it.

Evidence is the existing exact-model evidence only (`extractProviderModelInfo`,
`DIRECT_PROVIDER_JUDGEMENTS`, `DIRECT_MODEL_FACTS`, `FREE_MODEL_BUDGETS`,
`produceCapabilities`, `classifyConnectionBilling`, `resolveConnectionZeroCostSafety`) —
no provider-wide or family inference. Reference results: NVIDIA's live catalog (82 ids) →
3 READY (kimi-k3, deepseek-v4-pro-0813, deepseek-v4-flash-0731), 79 VALIDATION_REQUIRED,
2 trial-credit, 0 zero-cost eligible. OpenRouter's live catalog → only
`cohere/north-mini-code:free` READY, still without a static registry row.

### Native Auto-Sync and Custom Models are activation, not observation

- Native Auto-Sync (`autoSync`, `modelSyncScheduler.ts`, roughly every 24 h and 5 s after
  startup), auto-fetch (`autoFetchModels`) and "Import from /models" write
  `syncedAvailableModels` (replacement semantics, `importFreeModelsOnly` filtering) and, for
  Import, provider-wide `customModels`. AutoCombo pools use synced/custom models instead of the
  static registry when any exist, so a sync is a routing activation. It is **not** the Jarvis
  observation store.
- A custom model means only that the operator configured it. It does not imply
  `toolCalling`, `verifiedFree`, `claudeCodeEligible` or `connectionSafeForZeroCost`.
- Known caveat (next phase, routing gate): custom and synced models can currently enter
  AutoCombo pools without Jarvis evidence.
- Future hardening (pre-existing, not changed in A2): the static ModelSpec tool fact is keyed by
  model identity alone, so `moonshotai/kimi-k3` resolves `toolCalling=true` on any provider
  (e.g. `kilo-gateway`, `openrouter`) even without provider-specific evidence. Claude
  eligibility stays `null` there because judgements are exact provider + model.

### Lifecycle hooks (future, not wired)

Candidate triggers for the callable refresh: successful connection test
(`src/app/api/providers/[id]/test/route.ts`), connection create (`POST /api/providers`),
credential or settings update (`PUT /api/providers/[id]`), manual refresh, and a periodic job.
None is wired in A2; background observation stays off.

## Routing Activation Gate (O9-F3.5 A3)

A3 is the next, still inert, stage after A2's `SEPARATE ACTIVATION POLICY (not part of A2)`
box above:

```
OBSERVATION INVENTORY -> EVIDENCE RESOLUTION -> READY / VALIDATION_REQUIRED / ...
  ↓
ACTIVATION POLICY   (src/lib/providerOnboarding/activationPolicy.ts)
  ↓
APPROVAL            (src/lib/db/providerActivationApprovals.ts)
  ↓
(existing OmniRoute synced/custom-models activation writer — NOT called by A3)
  ↓
routable
```

`evaluateActivationDecision` / `resolveActivationGate` only COMPUTE a verdict. Nothing in A3
calls the existing synced/custom-models activation writer, nothing writes
`syncedAvailableModels` or `customModels`, and nothing touches AutoCombo/quota-combo pools.
Deciding is not activating — a caller acting on a decision's `activate: true` by invoking the
existing writer is explicitly future work, not part of A3.

### General activation candidate — policy-independent

`isGeneralActivationCandidate(resolved, connectionActive)` is the single gate every policy mode
composes with:

```
currentlyObserved === true
&& connectionActive === true
&& executable === true
&& claudeCodeEligible === true
&& knownProtocolConflict !== true
```

This is A2's READY status plus one check A2 deliberately does not make itself:
`connectionActive`. A2's READY is a model-capability fact independent of connection state; A3
must not offer a candidate on a dead connection. Unknown/null evidence fails closed the same as
A2 (a VALIDATION_REQUIRED observation never becomes a candidate); a proven
`claudeCodeEligible === false` (A2's KNOWN_INCOMPATIBLE status) is blocked under every policy
mode and cannot be overridden by any
approval, forced or otherwise — approval can only narrow a candidate (revoke it), never widen a
non-candidate into one.

### Policy modes

`ActivationPolicyMode`: `"manual"` (default, `DEFAULT_ACTIVATION_POLICY_MODE`) |
`"approved_ready"` | `"strict_zero_cost"`. No mode auto-activates anything unless an operator
has explicitly selected it — nothing in the app calls `evaluateActivationDecision` yet.

- **manual**: a general candidate only activates with a stored `ActivationApprovalRecord`
  (`approved: true`) for its exact `canonicalModelId`. No record → `activate: false`,
  reason `policy-manual-unapproved`.
- **approved_ready**: every general candidate activates without needing a stored approval
  record — choosing this policy mode is itself the operator's blanket approval of "READY is
  enough". Reason `policy-approved-ready`.
- **strict_zero_cost**: READY alone is never enough. Only activates when the candidate is also
  `strictZeroCostCandidate` (A2's own `zeroCostEligible` / `evaluateZeroCostRoute` contract —
  hard-stop-guaranteed cost **and** proven connection safety). Today `connectionSafeForZeroCost`
  is unproven for every observed connection, so this mode activates nothing yet — that is the
  correct, honest, fail-closed result, not a bug.
- An explicit revocation (`ActivationApprovalRecord{approved:false}`) always blocks, in every
  mode, even over a prior approval — checked before the mode switch.

### Reference results (same fixtures as A2)

- NVIDIA's live catalog: exactly the 3 READY models (`kimi-k3`, `deepseek-v4-pro-0813`,
  `deepseek-v4-flash-0731`) are general activation candidates; the other 79 stay
  `validation-required`. `openai/gpt-oss-120b` (curated `claudeCodeReady: false`) stays
  `known-incompatible` under every policy mode, including a forced `approved: true` record.
- OpenRouter's `cohere/north-mini-code:free`: general activation candidate under every mode,
  but `strictZeroCostCandidate: false` — `strict_zero_cost` mode activates nothing for it today.

### Pieces

- `evaluateActivationDecision` / `resolveActivationGate`
  (`src/lib/providerOnboarding/activationPolicy.ts`): pure, DB-free decision functions over one
  `ResolvedObservation` (or a batch) plus an injected approval lookup.
- `getActivationPolicyMode` / `setActivationPolicyMode` / `getActivationApproval` /
  `setActivationApproval` / `listActivationApprovals` (`src/lib/db/providerActivationApprovals.ts`):
  persistence in two new `key_value` namespaces (`providerActivationPolicyMode`,
  `providerActivationApprovals`), deliberately separate from `syncedAvailableModels` /
  `customModels` — nothing on the routing path reads either namespace.
- The A2 architectural guard test (`tests/unit/providerOnboardingNvidiaA2.test.ts`, test "I")
  now allowlists these two new files as authorized observation-layer consumers, while still
  asserting neither one ever references the real activation writer
  (`persistCanonicalSyncedAvailableModels` and siblings) — extending the invariant, not
  loosening it.

### Explicitly out of scope for A3

- No route, hook, UI, or job calls `evaluateActivationDecision` / `resolveActivationGate` yet —
  this PR ships the decision layer only, not a caller.
- No wiring of `activate: true` into the existing synced/custom-models activation writer.
- No default policy mode other than `manual`.
- Automatic failover / model switching on a degraded route is O9-F3.5 A4 (roadmap), not A3.

## Autonomous Failover Decision Engine (O9-F3.5 A4)

A4 answers a different question than A2/A3: not "is this model evidence-backed and
activation-permitted" but "when the CURRENT route fails, what should Jarvis do about it, right
now, without touching anything." It is decision-only — no live switch, no activation, no
provider request, no DB write:

```
REQUEST
  ↓
CURRENT ROUTE
  ↓
RUNTIME STATE (ProviderRuntimeState — reused, not duplicated)
  ↓
FAILURE?
  ├─ no (or a caller/request error) → KEEP_CURRENT
  └─ yes
       ↓
    HARD ELIGIBILITY (RouteHardFacts — connection active, evidence current,
                       executable, claudeCodeEligible, no known protocol
                       conflict, A3-permitted, not administratively disabled)
       ↓
    POLICY / COST SAFETY (strict_zero_cost mode only: A2/A3's own zero-cost
                           route contract — never re-derived)
       ↓
    HEALTH / QUOTA / COOLDOWN (ProviderRuntimeState fields; loop prevention
                                via caller-supplied attemptedRouteIds)
       ↓
    CAPABILITY MATCH (optional context/tool requirements)
       ↓
    BEST SAFE CANDIDATE (deterministic score: health > quota > proven
                          requirements match > provider diversity > capped
                          external-score tiebreak; never random, never a
                          hardcoded provider order)
       ↓
    SWITCH_TO | ACTIVATION_REQUIRED | WAIT_COOLDOWN | NO_SAFE_ROUTE
```

Core rule: **AUTO FAILOVER != PAID FAILOVER.** Under `strict_zero_cost` policy, a candidate
without a proven zero-cost route is never selected — Jarvis returns NO_SAFE_ROUTE instead of
knowingly picking a paid or cost-unproven route.

### Files

- `src/lib/failover/failoverDecision.ts` — the pure core engine. Zero A2/A3 import: accepts
  the generic `RouteHardFacts` / `FailoverCandidate` contract so it covers routes A2 never
  observes (a statically registered provider like Gemini, or a future local/self-hosted
  provider) as naturally as an A2-observed one. Exports `evaluateFailoverDecision` (the one
  decision function) and `dryRunFailoverDecision` (a read-only reshaping of the same result into
  "candidates eligible / candidates rejected" — there is no separate "live" evaluator for it to
  diverge from; A4 ships decision + dry-run only, nothing else).
- `src/lib/failover/failoverA3Adapter.ts` — the only file that imports the A2 observation
  (`ResolvedObservation`) and A3 activation (`ActivationDecision`) types, translating them into
  a `FailoverCandidate`. `alreadyRoutable` is a caller-observed FACT (is the model really present
  in the existing synced/custom-models pool today), never derived from A3's `activate` verdict —
  that field is a computed permission, not evidence a write happened. This is why the file, like
  the rest of A4, never calls the real activation writer and never reads
  `syncedAvailableModels` / `customModels` itself.
- The A2 architectural guard test (`tests/unit/providerOnboardingNvidiaA2.test.ts`, test "I") now
  also allowlists `failoverA3Adapter.ts` as an authorized observation-layer consumer, while still
  asserting it never references the real activation writer. `failoverDecision.ts` itself needs no
  allowlisting — it has no A2/A3 coupling at all.

### Reused authorities (nothing duplicated)

| Concern                                                         | Reused from                                                                                                                      | Not rebuilt                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Health / account / quota / cooldown / cost class / capabilities | `ProviderRuntimeState` (`open-sse/services/providerRuntimeState.ts`)                                                             | a parallel health/quota/cost system |
| General activation eligibility                                  | A3 `isGeneralActivationCandidate` (restated generically as `RouteHardFacts`/`isHardEligible` so non-A2 providers fit too)        | a second eligibility gate           |
| Zero-cost route safety                                          | A2/A3's own `zeroCostEligible` / `strictZeroCostCandidate` (built on `evaluateZeroCostRoute`, `resolveConnectionZeroCostSafety`) | a new cost model                    |
| Activation handoff states                                       | A3 `ObservationStatus` / `ActivationDecision` via `failoverA3Adapter.ts`                                                         | a second activation gate            |
| 429 rate-limit vs quota-exhausted nuance                        | `classify429`/`FailureKind` (feeds `ProviderRuntimeState`, consumed indirectly)                                                  | a second 429 classifier             |

**Deliberately not reused**: `src/domain/fallbackPolicy.ts` / `policyEngine.ts` / `lockoutPolicy.ts`
(FASE-06/09, T-19/T-46). These are an older, DB-mutating, JS-typed, operator-configured static
provider-priority system, architecturally disconnected from `ProviderRuntimeState` and the O9-F3.x
evidence pipeline — they know nothing about capability evidence, zero-cost safety, or A2/A3.
Building A4 on top of them would mean depending on mutable module-level state and a second,
mismatched notion of "fallback," not reuse. A4 builds on the evidence-based side
(`ProviderRuntimeState` + A2 + A3) to stay consistent with A2/A3's own architecture.

### Reason codes

`FailoverReason` mirrors the spec's requested set, plus three additions, each because no
existing code was equivalent: PROVIDER_HEALTH_FAILURE (circuit breaker vs a dead connection —
distinct from CONNECTION_UNAVAILABLE), ADMINISTRATIVELY_DISABLED (an operator hide/disable is
not the same as an unproven or incompatible model), and CALLER_ERROR (a request-shape problem
must never read as a route failure). `network_error` / `auth_failed` / `model_removed` current-route
failure kinds fold into CONNECTION_UNAVAILABLE / MODEL_UNAVAILABLE reason codes rather than
minting near-duplicate codes for them.

### Current-route bias and loop prevention

`currentRouteFailure: "none"` (healthy) and `"caller_error"` both short-circuit to KEEP_CURRENT
before any candidate is even looked at — a marginally higher-scoring alternative can never
dislodge a healthy route, and a client-side schema/parameter problem can never trigger
cross-provider failover. `attemptedRouteIds` is a caller-owned, request-scoped set this engine
never persists; a route present in it is rejected with ATTEMPTED_ALREADY before any other
check, which is what makes an `A → B → A → B` loop structurally impossible as long as the caller
accumulates the set correctly across hops within one request.

### Restart / reconstruction model

Nothing in A4 is persisted. Every call is a fresh, independent evaluation over
`ProviderRuntimeState` (already backed by the DB / circuit breaker / quota authorities),
`attemptedRouteIds` (request-scoped, caller-owned), and A2/A3's own evidence — so a provider that
recovers (cooldown expires, quota resets) is naturally eligible again on the next independent
call with no A4-specific state to reset or migrate across a restart.

### Explicitly out of scope for A4

- No live route switch, no model activation, no write to `syncedAvailableModels` /
  `customModels`, no provider/inference request — decision and dry-run only.
- No execution feature flag is introduced in A4; wiring a decision into an actual switch is
  future work, and any such flag must default OFF per Hard Rule discipline (not enabled in
  Shadow or Production here).
- Ranking is deliberately simple and documented (health > quota > proven requirements match >
  provider diversity > capped external-score tiebreak) — it does not call into `combo.ts`'s live
  AutoCombo scoring engine, which is a large, side-effecting execution path, not a pure function.

## Native OmniRoute Combo Strategy Integration (O9-F3.5 A5)

A5 connects A2/A3/A4's evidence-based safety layer to the existing native Combo strategy
engine — **without building a second router.** Core rule, unchanged from the spec:

```
JARVIS
========
OBSERVE (A2) -> EVIDENCE (A2) -> SAFETY (A2/A4 zero-cost) -> POLICY (A3)
  -> HARD ELIGIBILITY (A4 RouteHardFacts) -> ACTIVATION (A3) -> SAFE CANDIDATE SET (A5)

          ↓

OMNIROUTE
=========
NATIVE COMBO STRATEGY (20 strategies) -> RETRY -> FALLBACK -> HEADROOM
  -> RESET-AWARE ROUTING -> RESPONSE VALIDATION -> CACHE/CONTEXT OPTIMIZATION
```

**JARVIS CHOOSES WHO MAY PLAY. OMNIROUTE CHOOSES THE PLAY.**

### 1. Native strategy inventory (source-verified, not UI names)

The runtime source of truth is `open-sse/services/combo/strategyDispatch.ts`'s
`HANDLED_COMBO_STRATEGIES` — 20 canonical strategies, each traced to real dispatch code:

| Strategy                   | Dispatch                                                                                                                                                                                                                                                                                                                      | Shape                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `priority`                 | implicit — `resolveComboTargets()`'s own order, untouched                                                                                                                                                                                                                                                                     | reorder-free (the baseline order)                             |
| `fill-first`               | `applyStrategyOrdering` (no-op branch — its own comment: "preserving priority order")                                                                                                                                                                                                                                         | same as priority                                              |
| `weighted`                 | weighted step-group resolution in `combo/targetResolution.ts` (`resolveComboTargetPipeline`)                                                                                                                                                                                                                                  | reorder                                                       |
| `round-robin`              | sticky round-robin state in `combo/rrState.ts`, consumed by the same pipeline                                                                                                                                                                                                                                                 | reorder                                                       |
| `context-relay`            | handled inline in `combo.ts`'s main loop (Codex session handoff)                                                                                                                                                                                                                                                              | reorder-free (priority order + handoff side-channel)          |
| `strict-random` / `random` | `applyStrategyOrdering` (`getNextFromDeck` / `fisherYatesShuffle`)                                                                                                                                                                                                                                                            | reorder                                                       |
| `p2c`                      | `applyStrategyOrdering` → `orderTargetsByPowerOfTwoChoices` (`combo/targetSorters.ts`)                                                                                                                                                                                                                                        | reorder                                                       |
| `least-used`               | `applyStrategyOrdering` → `sortTargetsByUsage`                                                                                                                                                                                                                                                                                | reorder                                                       |
| `cost-optimized`           | `applyStrategyOrdering` → `sortTargetsByCost` (+ optional manifest-routing premium filter)                                                                                                                                                                                                                                    | reorder                                                       |
| `reset-aware`              | `applyStrategyOrdering` → `orderTargetsByResetAwareQuota` (`combo/quotaStrategies.ts`, pure math in `combo/quotaScoring.ts`)                                                                                                                                                                                                  | reorder, real quota snapshots                                 |
| `reset-window`             | `applyStrategyOrdering` → `orderTargetsByResetWindow` (same quota-math leaf)                                                                                                                                                                                                                                                  | reorder, real quota snapshots                                 |
| `headroom`                 | `applyStrategyOrdering` → `orderTargetsByHeadroom` (`combo/quotaStrategies.ts`, pure ranking in `combo/headroomRanking.ts::rankByHeadroom`)                                                                                                                                                                                   | reorder, real saturation signals                              |
| `context-optimized`        | `applyStrategyOrdering` → `sortTargetsByContextSize`                                                                                                                                                                                                                                                                          | reorder                                                       |
| `cache-optimized`          | `applyStrategyOrdering` → prompt-cache-affinity ordering                                                                                                                                                                                                                                                                      | reorder (+ target expansion)                                  |
| `quota-share`              | `applyStrategyOrdering` → `selectQuotaShareTarget` (DRR + P2C in-flight + per-model bucket + per-connection concurrency)                                                                                                                                                                                                      | reorder + in-flight reservation                               |
| `lkgp`                     | `applyStrategyOrdering` (move last-known-good to front)                                                                                                                                                                                                                                                                       | reorder                                                       |
| `auto`                     | `resolveAutoStrategyOrder` (`combo/resolveAutoStrategy.ts`) → `buildAutoCandidates` + tool/context pre-filters + `scoreAutoTargets` / `selectAutoProvider` (`autoCombo/engine.ts`, 16-factor scoring, `autoCombo/scoring.ts`) or an explicit `routerStrategy.ts` router (`rules`/`score`/`cost`/`latency`/`sla-aware`/`lkgp`) | candidate-build + score, still sourced from `eligibleTargets` |
| `fusion`                   | `tryFusionDispatch` (`combo/dispatchPrelude.ts`) → `handleFusionChat` (`fusion.ts`) — fan-out panel + judge synthesis                                                                                                                                                                                                         | fan-out, still sourced from `resolveComboTargets`             |
| `pipeline`                 | `tryPipelineDispatch` (`combo/dispatchPrelude.ts`) → `handlePipelineChat` (`pipeline.ts`) — staged output→input chain                                                                                                                                                                                                         | staged, still sourced from `resolveComboTargets`              |

**Every single one** — reorder, score, fan-out, or staged — draws its candidate universe from
`resolveComboTargets()`'s output (directly, or via `eligibleTargets`/`buildAutoCandidates`'
expansion of it). None of the 20 ever ADDS a candidate absent from that array; they only
reorder, score, or select FROM it. This is the structural basis for §11's hard-exclusion proof.

Connection/health/quota/rate-limit/reset awareness is **not** uniform per strategy — most of
the 12 reordering strategies are quota/health-blind by design (pure ordering functions); the
awareness lives in the SHARED pre-dispatch gate every strategy passes through (next section),
not in each strategy's own ordering logic. `reset-aware`/`reset-window`/`headroom`/`quota-share`
are the exceptions — they consume real quota/saturation snapshots directly.

### 2. Priority / shared pre-dispatch gate + retry (source: `combo.ts::executeTarget`)

Every strategy's ordered array is walked by ONE shared per-target function (`executeTarget`
inside `handleComboChat`), not a per-strategy retry implementation. Before dispatch, in order:
circuit breaker (OPEN → skip), provider cooldown, connection cooldown (persisted, re-checked
before each retry), **request-scoped exhaustion sets** (`exhaustedProviders`,
`exhaustedConnections` — the native equivalent of A4's `attemptedRouteIds`), model lockout,
quota-exhaustion cutoff (opt-in, shared with `auto`'s own pool filter), quota-aware scheduling
(`OMNIROUTE_QUOTA_AWARE_ROUTING`), credential gate, concurrency cap, admission lane. Then a
retry loop (`maxRetries`/`retryDelayMs` per target) inside a GLOBAL attempt ceiling
(`globalAttempts`/`maxGlobalAttempts` across every target and retry combined) that terminates
the whole combo with `max_attempts_exceeded` rather than looping forever.

**Failure → fallback decision** (source-verified, not assumed):

| Failure                                                                                         | Falls over to next target?                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 429 / 5xx / network / timeout (transient)                                                       | Yes — classified by `checkFallbackError`, drives cooldown pacing only, never the fallback decision itself                                                                                                             |
| Model-scoped 400 ("model not supported")                                                        | Yes, AND the model is locked for future requests (`isModelScoped400`)                                                                                                                                                 |
| Context-overflow / param-validation 400 (`isContextOverflow400` / `isParamValidation400`)       | Yes — different models have different context/param limits                                                                                                                                                            |
| **Genuinely body-specific 400** (malformed/invalid, NOT context/param/model-scoped)             | **No — combo stops immediately** ("#2101: Prevent infinite fallback loops... These should NOT stop the combo [list]... Wrapper words like 'invalid'/'bad request' still stop only when the text is NOT model-scoped") |
| Input-bound failure (e.g. `context_length_exceeded`) against a homogeneous same-model remainder | No — short-circuits immediately, retrying would fail identically                                                                                                                                                      |
| HTTP 200 + failed response-quality validation                                                   | Yes — treated exactly like an HTTP error (502)                                                                                                                                                                        |
| Client disconnect (499)                                                                         | No — stops immediately, nothing to serve                                                                                                                                                                              |

This is already exactly A4's `caller_error` vs route-failure distinction — implemented natively,
via post-hoc HTTP-response-shape classification, strategy-agnostic (one shared function, not
20 copies). **A5 does not reimplement any of this.**

### 3. Response validation (source: `combo/responseValidation.ts` + `combo/validateQuality.ts`)

`ResponseValidationConfig`: `forbiddenSubstrings`, `requiredSubstrings`, `minContentLength`,
`jsonPathPredicates` (bounded dot/bracket path resolver, no regex, no eval). Confirmed:
**HTTP 200 + a failing predicate DOES trigger fallback** — `combo.ts`'s shared success path
calls `validateResponseQuality` before returning, and a failure is recorded as a first-class
`kind: "quality"` outcome (`lastStatus = 502`), which the same shared retry/fallback logic
above treats identically to a real HTTP error. Strategy-agnostic (every strategy passes
through this same success-path check). **A5 does not reimplement substring/JSON-path
validation** — it is pure, safe (no regex/no eval), and already OmniRoute-owned.

### 4. A4 responsibility matrix

| Responsibility                                                                                                                       | Classification            | Why                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider observation, evidence resolution, Claude compatibility, zero-cost safety, connection/account safety, activation eligibility | **KEEP_IN_JARVIS**        | No native equivalent exists — this is exactly A2/A3/A4's own domain                                                                                                                                                 |
| Hard candidate gates (`RouteHardFacts`/`isHardEligible`)                                                                             | **KEEP_IN_JARVIS**        | Native strategies never gate on Claude-Code compatibility or zero-cost proof                                                                                                                                        |
| NO_SAFE_ROUTE terminal decision                                                                                                      | **KEEP_IN_JARVIS**        | Only Jarvis knows when the SAFE set is empty                                                                                                                                                                        |
| Current-route bias (`currentRouteFailure: "none"` short-circuit)                                                                     | **KEEP_IN_JARVIS**        | No native strategy refuses to switch merely because the current route is still healthy — they reorder unconditionally                                                                                               |
| Activation handoff (ACTIVATION_REQUIRED vs SWITCH_TO)                                                                                | **KEEP_IN_JARVIS**        | Native code has no concept of "observed but not yet activated"                                                                                                                                                      |
| Candidate ranking _within_ the safe set (headroom / reset-window / cost / quota-share)                                               | **DELEGATE_TO_OMNIROUTE** | Real, pure, already correct (§1); duplicating would be the "second router" this task forbids                                                                                                                        |
| Retry execution, backoff, global attempt ceiling                                                                                     | **DELEGATE_TO_OMNIROUTE** | `executeTarget`'s shared loop already owns this — see §5                                                                                                                                                            |
| Response validation (200-but-invalid)                                                                                                | **DELEGATE_TO_OMNIROUTE** | Real, safe, strategy-agnostic (§3)                                                                                                                                                                                  |
| Failure classification for IN-REQUEST fallback pacing (429 vs 5xx vs body-specific 400 vs quality)                                   | **DELEGATE_TO_OMNIROUTE** | `checkFallbackError`/`isScopedFailure`/`isModelScoped400`/etc. are comprehensive and battle-tested; A4's own `RouteFailureKind` stays the trigger for Jarvis's OWN proactive decisions, a different layer (see §13) |
| Loop / attempted-set tracking                                                                                                        | **SHARED_BOUNDARY**       | Native `exhaustedProviders`/`exhaustedConnections` own the IN-REQUEST loop; A4's `attemptedRouteIds` is the analogous concept one layer up, for Jarvis's own SAFE SET recomputation across requests — see §13       |
| Provider diversity                                                                                                                   | **SHARED_BOUNDARY**       | A4 uses it as a minor score tiebreaker among already-safe candidates; native strategies never diversify on their own, but nothing here needs enforcing beyond "safety first" (§16 example)                          |
| Quota/reset ranking, health ranking                                                                                                  | **DELEGATE_TO_OMNIROUTE** | Real pure leaves reused directly by A5's bridge, not duplicated (§2 of A5 "Pieces" below)                                                                                                                           |

### 5. Safe candidate set (`src/lib/failover/jarvisSafeCandidateSet.ts`)

`buildSafeCandidateSet(candidates: FailoverCandidate[])` reuses A4's own (now exported)
`classifyCandidateRejection` — the exact function `evaluateFailoverDecision` itself calls — so
the safe set and a live A4 decision can never drift apart on what counts as eligible. Two
pools, `general` and `strictZeroCost` (always ⊆ `general` by construction, computed by calling
the same rejection classifier twice — once under a non-cost-gated policy, once under
`strict_zero_cost`), each split again by `activation`: `routable` (ALREADY_ROUTABLE — safe to
feed a native strategy NOW) vs `pendingActivation` (READY_BUT_NOT_ACTIVATED — Jarvis-safe once
activated, but structurally excluded from anything a native strategy could select — A4's
ACTIVATION_REQUIRED handoff is not bypassed). No DB writes; pure function of the candidate
array already in memory.

### 6. Native strategy bridge (`src/lib/failover/nativeComboBridge.ts`)

`filterToJarvisSafeCandidateSet(pool, identity, safeSet, poolKind)` — a pure, generic array
filter. `identity` maps any native pool item (a `ResolvedComboTarget`, a `ProviderCandidate`, or
any future shape) onto `{ providerId, routeId, connectionId }`; the filter keeps only members of
the requested Jarvis pool, matching by exact `(provider, connection, route)` when the native
item names a connection, or by `(provider, route)` — "at least one connection for this route is
safe" — when it doesn't (a provider-wide auto-combo catalog expansion, resolved to a specific
connection later by OmniRoute's own account-selection layer). This IS the hard-exclusion
guarantee: every native strategy (§1) only reorders/scores/selects from the array it receives,
so a route this filter removes cannot reappear downstream, structurally — not a runtime check
any strategy could accidentally skip.

`dryRunNativeStrategy` (A5 spec §18) filters, then applies one strategy's REAL ranking to the
filtered subset only — `priority` (array order), `headroom` (imports and calls the real
`rankByHeadroom`/`computeHeadroom`), `reset-window` (imports and calls the real
`getResetWindowRemainingMs`), and `custom-score` (caller injects a scorer — tests inject the
real `scorePool`/`getTaskFitness` for an `auto`-shaped proof). Read-only: no live routing, no
provider request, no Combo mutation. `identity` adapters (`resolvedComboTargetIdentity`,
`providerCandidateIdentity`) are pure field mappers, not behavior.

### 7. Hard exclusion proof

`tests/unit/nativeComboIntegrationA5.test.ts` proves, for `priority`, real `headroom`, real
`reset-window`, and real-`scorePool`-backed `custom-score` (an `auto`-shaped stand-in): a
Jarvis-rejected route is never `selected`, even when it would objectively win on the native
metric alone (given full headroom / soonest reset / best score) — because it is removed from
the array before that metric is ever evaluated. Also: rejected-route non-reappearance across
duplicate pool entries, connection isolation (one unsafe connection of a route excluded while a
sibling safe connection is kept), and provider diversity never overriding safety.

### 8. General vs strict-zero-cost pools (A5 spec §17 examples, source-verified)

- **Example A** (two safe Gemini connections + a Groq connection that is READY but
  `connectionSafeForZeroCost` unresolved): Groq structurally cannot reach any native strategy
  under `strictZeroCost` — proven directly against real evidence in the OpenRouter/NVIDIA tests
  below, using the Groq-shaped case as the synthetic mirror (this repo has no A2 Groq
  observation fixture; `OBSERVATION_CATALOG_PROVIDERS` is `nvidia`/`openrouter` only).
- **Example B**: OpenRouter's real `cohere/north-mini-code:free` (A2/A3's own reference
  candidate) — general pool: yes; strict pool: no (`connection-safety-unknown`, same
  ACCOUNT_SAFETY_UNKNOWN reason A4 itself surfaces).
- **Example C**: NVIDIA's 3 real known-`claudeCodeEligible:true` models — general pool: yes;
  strict pool: no (cost status unresolved for the connection) — proven against the real A2
  NVIDIA fixture, not a synthetic trial-credit stand-in.
- **Example D**: a fully proven synthetic local-provider candidate (`executable`,
  `claudeCodeEligible`, health all `true`, `strictZeroCostSafe: true`) participates in both
  pools and is selectable via the native bridge — `local_zero_cost` alone was never used as the
  sole proof; every hard fact is proven first.

### 9. Retry / loop ownership boundary

`combo.ts::executeTarget` (§2) is THE single authoritative IN-REQUEST attempt/retry loop —
`globalAttempts`/`maxGlobalAttempts` and `exhaustedProviders`/`exhaustedConnections` already
prevent runaway loops and route re-selection within one request. **A5 adds no second loop.**
`nativeComboBridge.ts` and `jarvisSafeCandidateSet.ts` expose no retry/backoff surface at all
(asserted directly by a dedicated test). A4's `attemptedRouteIds` operates one layer up and for
a different purpose: it is the caller-owned, request-scoped set A4 itself never persists,
informing Jarvis's own KEEP_CURRENT/SWITCH_TO/NO_SAFE_ROUTE decision (e.g. "don't propose a
route we already tried this request") — not a mechanism that re-attempts anything itself. The
two sets serve adjacent, non-overlapping layers: native exhaustion sets govern retries WITHIN
one target's dispatch attempts; A4's attempted set governs which candidate Jarvis is willing to
recommend switching to.

### 10. Quota / cooldown boundary

Jarvis authority governs hard route eligibility (fail-closed: an account-unsafe candidate is
removed before any native ranking runs). Native quota/headroom/reset strategies optimize only
among candidates that remain — confirmed by `headroomRanking.ts`'s own fail-OPEN default for a
_missing_ saturation signal ("any missing / non-finite utilization is treated as 0 (full
headroom)"): that default is fine precisely because it only ever ranks WITHIN an already
Jarvis-approved set, never decides whether a route may play at all. Fail-open ranking and
fail-closed eligibility are two different layers by design, not a contradiction.

### 11. Observability

`CandidateDisposition` (`jarvisSafeCandidateSet.ts`) is `{ kind: "JARVIS_REJECTED", reason }` or
`{ kind: "JARVIS_APPROVED", pool, activation }`, keyed the same way native pool identity is
matched. `dryRunNativeStrategy`'s report separates `jarvisRejectedCount` from
`jarvisApprovedCount` and names `nativeSelectionReason` for whichever survivor won — the
OMNIROUTE_NOT_SELECTED half of the distinction (an approved-but-not-chosen candidate) is
reportable from the same dry-run result (every approved-but-not-`selected` entry), without A5
inventing a second reason-code taxonomy for it. No prompt or secret is read or logged anywhere
in A5.

### 12. Future dynamic Combo management (design only — not implemented in A5)

```
Jarvis detects provider/model changes (A2 refresh)
  ↓
rebuilds safe candidate membership (A5 buildSafeCandidateSet)
  ↓
diffs against the managed Combo's current members (added / removed / unchanged)
  ↓
updates the managed Combo atomically (single native write, all-or-nothing)
  ↓
OmniRoute continues native strategy execution over the updated membership
```

Requirements for a future implementation: **idempotent** (re-running the same safe set against
an unchanged Combo produces no write, mirroring A2's own `applyObservationRefresh` "unchanged →
no write" contract); **connection-scoped** (never a provider-wide toggle — matches every A2/A3/A4
invariant already in place); **no duplicate models** (dedupe by the same `NativePoolIdentity`
key this module already defines); **safe removal** (a route leaving the safe set is removed from
the managed Combo, never from the observation history — mirrors A2's "removed is never delete"
rule for its own inventory); **no half-written Combo state** (a single atomic replace of the
managed Combo's member list, never a partial multi-step mutation visible mid-write); **recoverable
after restart** (the managed Combo's membership is always fully reconstructible by re-running
`buildSafeCandidateSet` over current A2/A3/A4 state — nothing about WHY a route is a member needs
its own persisted record, matching A4's own restart model). **Not implemented here** — A5 ships
the pure decision/bridge layer only; no route, hook, UI, or job calls it, and no Combo is read,
written, or activated anywhere in this phase.

### Explicitly out of scope for A5

- No native strategy execution — `dryRunNativeStrategy` never calls `handleComboChat` or any
  live dispatch path.
- No Combo persistence or activation, no `syncedAvailableModels` / `customModels` write.
- No Auto-Sync re-enablement, no `observed == routable` shortcut anywhere in this module — the
  safe set is built from A2/A3/A4 evidence exclusively.
- No modification to `combo.ts` or any native strategy file — every reuse in A5 is an import of
  an existing pure function (`rankByHeadroom`, `getResetWindowRemainingMs`, `scorePool` in
  tests), never a copy or a fork.

## Jarvis Strategy Policy Engine (O9-F3.5 A6 / "A5.1")

A5 answered "who may play" (`JarvisSafeCandidateSet`). A6 answers the next question — "what
game plan fits this request" — by recommending WHICH native strategy (of A5's audited, proven
inventory) should execute over that same safe set. OmniRoute remains the sole executor.

```
JARVIS CHOOSES WHO MAY PLAY.
JARVIS CHOOSES THE GAME PLAN.
OMNIROUTE EXECUTES THE PLAY.
```

### 1. Strategy decision contract

`recommendStrategy(input): StrategyRecommendation` (`src/lib/failover/strategyPolicyEngine.ts`)
— pure, deterministic, no DB/network/routing call. `{ strategy: CandidateStrategy | null,
confidence: "high"|"medium"|"low", reasons: StrategyReasonCode[], requiresSafeScopedAutoCombo?:
true, evidenceSummary }`. `strategy: null` is the only terminal outcome (empty A5 safe pool) —
never converted into a fallback strategy, matching A4's NO_SAFE_ROUTE exactly one layer up.

### 2. Native strategy prerequisites (A6 spec §12, reused from the A5 audit)

Recommendable strategies are a deliberate SUBSET of A5's 20: `priority`, `headroom`,
`reset-window`, `p2c`, `least-used`, `context-optimized`, `cache-optimized`, `auto` — the ones
this phase's own decision-rule examples ground in evidence. `weighted`, `round-robin`,
`fill-first`, `cost-optimized`, `fusion`, `pipeline`, `lkgp`, `quota-share` remain fully
OmniRoute-owned, valid strategies A6 simply has no fact-grounded rule to recommend yet — not
implemented, not guessed.

| Strategy             | Prerequisite (absent → ineligible, never guessed)                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headroom`           | at least one safe candidate with a known headroom/utilization signal                                                                                                                                                                                            |
| `reset-window`       | at least one safe candidate with a known reset window/timestamp                                                                                                                                                                                                 |
| `context-optimized`  | a known context capacity for the safe pool AND an actual large-context requirement on the request                                                                                                                                                               |
| `cache-optimized`    | a usable cache-affinity signal for at least one safe candidate                                                                                                                                                                                                  |
| `p2c` / `least-used` | ≥2 caller-declared equivalent/interchangeable safe candidates; `p2c` additionally needs live per-request load telemetry, `least-used` needs only cumulative usage counts (a lower evidence bar) — the distinguishing FACT, not the provider, picks between them |
| `auto`               | ≥3 safe candidates, a coding-shaped request, and nothing more specific already matched — always paired with `requiresSafeScopedAutoCombo: true`                                                                                                                 |
| `priority`           | always eligible — the proven, simplest native strategy; the universal fallback                                                                                                                                                                                  |

### 3. Deterministic precedence (A6 spec §6)

SAFE_POOL_EMPTY (terminal) → SINGLE_SAFE_ROUTE → LARGE_CONTEXT_REQUIRED (a hard capability
requirement, checked before stability — a route that cannot serve the context must not be kept
"for stability") → STABLE_CURRENT_ROUTE (hysteresis, §8 below) → QUOTA_PRESSURE +
RESET_WINDOWS_AVAILABLE → HEADROOM_AVAILABLE → LOCAL_LOAD_BALANCING →
CACHE_AFFINITY_AVAILABLE → MULTI_FACTOR_POOL (`auto`) → CONSERVATIVE_FALLBACK (`priority`).
Every rule is a pure `if` in that fixed order — no scoring, no randomness.

### 4. Single-route behavior

Exactly one safe candidate (in the requested pool) → `priority`, confidence `high`, reason
SINGLE_SAFE_ROUTE — the "conservative single-route strategy" A6 spec §17 test A asks for.

### 5. Priority behavior

Default for 2+ safe candidates when nothing more specific applies (ORDERED_BACKUPS +
CONSERVATIVE_FALLBACK) and the universal fallback for missing telemetry. A5's own
`resolvedComboTargetIdentity`/`filterToJarvisSafeCandidateSet` guarantee a blocked route can
never appear at any position — including as a "backup" — since `priority` IS the filtered array
order (A5 §1).

### 6. Headroom behavior

Recommended once at least one safe candidate has a known headroom signal, confidence scaled by
COVERAGE (`known / totalSafe`: 100% → `high`, ≥50% → `medium`, else `low`) — reused from A5's
real `rankByHeadroom`, never reimplemented.

### 7. Reset behavior

Recommended only under quota pressure AND with reset-window evidence present — test E proves
reset windows unknown under pressure never selects `reset-window` (falls through to `headroom`
if available, else further down the precedence chain). Confidence is coverage-scaled, same
formula as headroom.

### 8. Context behavior

`context-optimized` fires only when the request has an actual context-size estimate greater than
zero AND the safe pool's known capacity is non-null — `high` confidence when the known capacity
covers the estimate, `medium` when it might not (still the best available evidence, never
silently downgraded to `priority`). Placed ahead of hysteresis deliberately (§3).

### 9. Local balancing behavior

`p2c` vs `least-used` is decided by ONE fact — `liveLoadTelemetryAvailable` — never by provider
identity. Test M swaps provider names (`groq`/`gemini` vs `nvidia`/`cerebras`) while holding
every fact identical and asserts an IDENTICAL recommendation, proving fact-based, not
provider-hardcoded, logic (A6 spec §11).

### 10. Conservative fallback

When nothing more specific has sufficient evidence, `priority` — never zero-config `auto` (A5
proved that path can expand to every active connection's catalog). `reasons` names
INSUFFICIENT_TELEMETRY when the pool itself is too small/telemetry-free to justify anything
richer, CONSERVATIVE_FALLBACK always accompanies the fallback pick.

### 11. Strict-zero-cost isolation

A6 never re-derives a candidate count — it reads `safeSet.strictZeroCost` (already ⊆
`safeSet.general` by A5's own construction) when `poolKind: "strictZeroCost"`. Test H proves a
general-only-safe candidate is invisible to `evidenceSummary.safeCandidateCount` under strict
mode; test I proves a candidate with tempting-looking telemetry but a proven `false` capability
never counts, regardless of what the caller's telemetry facts claim about it — safety is
computed by A4/A5's own gate, never by A6's telemetry inputs.

### 12. AutoCombo safety (A6 spec §18, hard regression test)

Every `strategy: "auto"` recommendation unconditionally carries `requiresSafeScopedAutoCombo:
true` — asserted directly by a dedicated test, and structurally impossible to omit (`auto` is
returned from exactly one code path, which always sets the field). A second test proves an empty
safe pool never recommends `auto` regardless of task type or historical candidate richness —
SAFE_POOL_EMPTY short-circuits before any strategy rule, including `auto`'s.

### 13. Anti-flapping design (A6 spec §7/§8)

No timers. `StrategyHysteresisFacts` — `previousStrategy`, `currentRouteHealthyAndSafe`,
`candidateSetChanged`, `pressureStateChanged`, `policyModeChanged` — are caller-owned, explicit
state-transition facts (A6 holds no mutable state of its own, matching A4's own restart model).
When the current route is healthy/safe and none of the three "changed" flags are set, A6 returns
the PREVIOUS strategy unchanged (STABLE_CURRENT_ROUTE) even when fresh telemetry would
otherwise justify a different pick (test J) — and immediately re-evaluates the moment any one
flag flips (test J2). This is deliberately conservative: A6 designs the persistence
REQUIREMENTS (what facts a caller must track across requests) without owning any redundant
mutable state itself.

### 14. Explainability output

`evidenceSummary` is a small, flat, structured object (`safeCandidateCount`, `poolKind`, known
counts, quota pressure) — no prompt content, no secret, no upstream response body. `reasons` is
an ordered `StrategyReasonCode[]`, reusing the exact vocabulary A6 spec §14 names.

### 15. Dry-run behavior

`recommendAndDryRunStrategy` (same file) calls `recommendStrategy`, then — only when a native
pool + identity extractor were supplied AND the recommended strategy is one A5's
`dryRunNativeStrategy` supports directly (`priority`/`headroom`/`reset-window`, or any strategy
via an injected `customScore`) — reuses A5's real dry-run bridge over the identical safe set.
Read-only throughout; no live Combo, no provider request.

### 16. Provider-independence proof

Test M (§9 above) is the direct proof: two structurally identical safe sets differing only in
provider names produce byte-identical recommendations (`strategy`, `reasons`, `confidence` all
equal). No `if (provider === …)` branch exists anywhere in `strategyPolicyEngine.ts`.

### 17. Future autonomous strategy switching (design only — not implemented)

```
runtime facts change (A2 refresh / quota event / health event)
  ↓
Jarvis recalculates the safe candidate set (A5 buildSafeCandidateSet)
  ↓
Jarvis recalculates the recommended strategy (A6 recommendStrategy, same hysteresis facts)
  ↓
if material change (candidateSetChanged / pressureStateChanged / policyModeChanged / large-context):
  update the managed Combo's strategy field atomically (single native write, all-or-nothing)
  ↓
OmniRoute continues native execution under the new strategy
```

Requirements for a future implementation: **idempotent** (re-running with unchanged facts must
produce the same recommendation and therefore no write — A6's own determinism, test L, is the
prerequisite this relies on); **auditable** (every recommendation already carries its full
`reasons`/`evidenceSummary` — nothing to add, just persist the trace); **anti-flapping** (already
designed, §13 — a future scheduler must feed real hysteresis facts, not re-invent timers);
**restart-safe** (no A6-internal state; `previousStrategy` is the only cross-request fact needed,
recoverable from whatever last wrote the managed Combo); **no half-written Combo state** (mirrors
A5's own future-Combo-management requirement — single atomic strategy-field replace, never a
partial multi-step mutation). **Not implemented here** — no route, hook, UI, or job calls
`recommendStrategy` in this phase, and no Combo is read, written, or activated.

### 18. Future provider/model sync — the full autonomous lifecycle this fits into

```
Provider discovered
  ↓
models observed (A2)
  ↓
evidence resolved (A2)
  ↓
validation / activation approval (A3)
  ↓
safe candidate set (A5)
  ↓
strategy recommendation (A6)
  ↓
managed Combo (future, not implemented)
  ↓
native OmniRoute execution
  ↓
health/quota feedback
  ↓
re-evaluation (loops back to safe candidate set / strategy recommendation)
```

### Explicitly out of scope for A6

- No strategy execution, no `handleComboChat` call, no live dispatch path.
- No managed-Combo read/write, no `syncedAvailableModels` / `customModels` write.
- No Auto-Sync re-enablement; `auto` is only ever recommended with
  `requiresSafeScopedAutoCombo: true` and is never itself responsible for enforcing that scoping
  (the caller/executor must honor it) — A6 makes the obligation explicit and testable, it does
  not (and structurally cannot, being a pure recommender) enforce it at execution time.
- No competing task/intent classifier — `RequestClassFacts.taskType` mirrors the existing
  `mapIntentToTaskType` 3-way bucket exactly; A6 never parses a prompt itself.

## Managed Combo Orchestration (O9-F3.5 A7)

A6 answered "what game plan fits this request." A7 turns that game plan into a deterministic
description of what a native OmniRoute Combo SHOULD contain, and a read-only plan for getting
there — without ever writing one. The full control loop this phase completes:

```
DISCOVER
  ↓
OBSERVE (A2)
  ↓
EVIDENCE (A2)
  ↓
ACTIVATION GATE (A3)
  ↓
FAILOVER POLICY (A4)
  ↓
SAFE CANDIDATE SET (A5)
  ↓
STRATEGY POLICY (A6)
  ↓
MANAGED COMBO DESIRED STATE (A7)
  ↓
RECONCILIATION PLAN (A7)
  ↓
future controlled APPLY (not built)
  ↓
OMNIROUTE EXECUTION
```

JARVIS OWNS DESIRED ROUTING INTENT. OMNIROUTE OWNS ROUTING EXECUTION.

### 1. Existing Combo persistence architecture (audited, not duplicated)

Table `combos`: `id` (uuid PK), `name`, `data` (the full JSON record), `sort_order`,
`created_at`, `updated_at`, `context_cache_protection` (a denormalized column mirroring a JSON
field, for query performance). The `data` blob: `id`, `name`, `models: ComboStep[]`, `strategy`
(default `"priority"`), `config: Record<string, unknown>` (free-form, strategy-specific —
confirmed extensible: `normalizeComboRecord` spreads the input record and only touches
`version`/`models`), `isHidden`, `sortOrder`, timestamps, `version: 2`. A `ComboModelStep` is
`{ id, kind:"model", model (bare id), providerId, connectionId, allowedConnectionIds, weight,
label, prompt, tags, fallbackOnlyOnQuotaExhaustion }` — this is the exact shape A7's
`ManagedComboMember` maps onto.

CRUD (`src/lib/db/repositories/sqliteComboRepository.ts`): `createCombo` (single INSERT, UUID
generated if absent, validated via `validateComboInvariant`), `updateCombo` (read-merge-validate,
single UPDATE; fields set to `null` are deleted), `reorderCombos` / `deleteCombo` (both wrapped
in an explicit `db.transaction()`). Validation: `validateComboInvariant` (opt-in
`allowedProviders`/`allowedModelFamilies` enforcement) plus Zod at the API boundary
(`createComboSchema`). Runtime observes changes via `invalidateDbCache("combos")` on every write
— the read-through cache re-reads on next lookup. **A7 calls none of this** — every function
here stays purely descriptive.

**No parallel Jarvis routing database was built.** A7 persists nothing; a future apply layer
would write Jarvis's ownership metadata into the SAME `combo.config.jarvisManaged` bag the
existing schema already supports, and membership into the SAME `combo.models` array every native
strategy already reads (A5's own proof: every strategy sources its candidates from
`resolveComboTargets()`, which reads `combo.models`).

### 2. Managed Combo identity

Mirrors an EXISTING precedent rather than inventing one:
`src/lib/quota/quotaCombos.ts` already programmatically owns its own Combo rows, identified by a
stable, prefixed NAME (`qtSd/<group>/<provider>/<model>` for the model-string side), upserted via
`getComboByName` + `create`/`update`. A7's `buildManagedComboLogicalId(purpose)` follows the same
shape for the COMBO itself: `jarvis-managed:<purpose>`. Redundantly, the logical id is also
recorded inside `config.jarvisManaged.logicalId` (a future apply layer's write target), so
ownership survives even if an operator renames the combo — the name-prefix and the
config-recorded id are two independent signals, not one fragile one.

### 3. Desired-state contract

`buildManagedComboDesiredState(input): ManagedComboBuildResult` — pure, no DB, no routing call.
Three outcomes, `kind` discriminated: NO_SAFE_ROUTE (nothing safe and nothing pending —
terminal, mirrors A4 one layer up), ACTIVATION_REQUIRED (nothing routable, but candidates exist
pending A3 activation — surfaced distinctly since the actionable next step differs), `DESIRED`
(a full `ManagedComboDesiredState`: `logicalId`, `name`, `strategy`, `poolKind`, `policyMode`,
`members`, `config`, `transientlySuppressed`, `evidenceFingerprint`, `activationRequiredCount`,
`blockedCount`). `logicalId`/`activationRequiredCount`/`blockedCount` are hoisted onto every
variant so a caller never needs to narrow on `kind` first just to read them.

### 4. Ownership protection

`planReconciliation` classifies `OwnershipStatus`: `unowned` (no combo at this identity yet),
`jarvis-owned` (ownership metadata present and its `lastAppliedFingerprint` matches the combo's
own current actual fingerprint), `drifted` (ownership metadata present but the actual fingerprint
has moved — an operator edited it since Jarvis's last apply), `foreign` (a combo exists at this
identity with no matching Jarvis ownership metadata at all — most likely a manually created
combo). **`foreign` and `drifted` both force `blocked: true`** — the plan still computes what
action WOULD be taken (for the audit trail / dashboard), but a future apply layer MUST refuse to
act on a blocked plan. Default posture, per spec: report, fail closed — A7 does not decide
whether Jarvis should ever auto-override operator drift.

### 5. Candidate membership rules

`members` is built EXCLUSIVELY from `safeSet.general` / `safeSet.strictZeroCost` (chosen by
`policyMode`) — the exact same A5 structures A6 already consumes. A JARVIS_REJECTED candidate
never has a code path into `members`: `toManagedComboMember` is only ever called on
`SafeCandidateEntry` objects, which by A5's own construction are always Jarvis-approved.

### 6. Strategy mapping

A6's `CandidateStrategy` union (`priority`/`headroom`/`reset-window`/`p2c`/`least-used`/
`context-optimized`/`cache-optimized`/`auto`) already names only real, A5-audited native
strategies — mapping is direct, 1:1, no translation table needed. `recommendation.strategy ===
null` (a fail-closed A6 empty-pool case) is defensively re-checked in A7 too and falls back to
NO_SAFE_ROUTE rather than ever guessing a strategy — planning error, not silent default.

### 7. AutoCombo safety (hard-tested)

The real guarantee is NOT a `config.candidatePool` setting — it is that `buildManagedComboDesiredState`
has **no code path that can ever see anything beyond the safe set it was handed**. A5's own audit
already proved `expandAutoComboCandidatePool` only expands to the full provider catalog when
`combo.models` is EMPTY; since A7 never produces an empty `members` array for a non-terminal
`auto` recommendation, that expansion path is structurally unreachable. `config.candidatePool` is
still set (the distinct provider ids in `members`) as defense-in-depth / self-documentation, not
as the primary mechanism. Test O is the hard regression: a 3-candidate safe set with `auto`
recommended produces exactly 3 members — the test's own comment notes a "400+ catalog" is
deliberately never modeled, because there is no code path for it to reach.

### 8. Reconciliation planner

`planReconciliation({ desired, current }): ReconciliationPlan` — pure, read-only. Actions:
NO_CHANGE, CREATE, UPDATE_MEMBERSHIP, UPDATE_STRATEGY, UPDATE_SETTINGS, DISABLE,
DELETE_NOT_ALLOWED (reserved; A7 never emits it — automatic deletion is out of scope, matching
§12's disable-not-delete rule). No write anywhere in this function.

### 9. Idempotency

Fingerprint equality is checked FIRST, before any diffing: `beforeFingerprint === afterFingerprint
=> NO_CHANGE` unconditionally, regardless of how many times reconciliation runs (test G).
`buildManagedComboDesiredState` and `planReconciliation` are both pure functions of their inputs
— test F/R prove repeated/independent builds with identical evidence produce byte-identical
results.

### 10. Minimal-diff behavior

When fingerprints differ, the plan computes `membershipAdded`/`membershipRemoved` (set difference
by exact `providerId::connectionId::routeId` key) and `strategyChanged` independently, then picks
ONE primary `action` label by precedence — membership first (the safety-critical dimension), then
strategy, then settings — while still carrying the FULL diff in the plan object regardless of
which single action won (test H: adding one member yields UPDATE_MEMBERSHIP with exactly that
one member in `membershipAdded`, nothing else touched).

### 11. Transient vs. persistent removal (reuses A4 semantics)

`TRANSIENT_REJECTION_REASONS` (COOLDOWN_ACTIVE, RATE_LIMITED, QUOTA_EXHAUSTED,
PROVIDER_HEALTH_FAILURE) mirrors A4's own `TRANSIENT_FAILURE_KINDS` concept one layer up, for
candidate-rejection reasons instead of route-failure kinds. A previous member that falls out of
the live safe set for one of these reasons is KEPT in `members` (native OmniRoute's own
per-target pre-dispatch gate — A5's own audit — already skips it live regardless of Combo
membership) and reported separately in `transientlySuppressed`; a member excluded for any other
reason (proven incompatible, administratively disabled, cost-unsafe, connection gone, …) is
dropped from `members` outright (test I vs. test J).

### 12. Activation boundary

A pending-activation candidate is never in `members` (§5's construction already guarantees this
structurally) but its count is always visible via `activationRequiredCount`, and when NOTHING
routable exists but something is pending, the result is the distinct ACTIVATION_REQUIRED kind
rather than a bare NO_SAFE_ROUTE (test K/K2) — no bypass of A3.

### 13. Connection isolation

`ManagedComboMember`/membership keys always include `connectionId`; a safe connection A and an
unsafe connection B of the exact same provider/model never merge into one membership decision
(test L) — inherited directly from A5's own per-connection safe-set keying, not re-derived.

### 14. Evidence fingerprint

`computeEvidenceFingerprint({ members, strategy, policyMode, config })` — sorts members by a
stable key before hashing (order-independent), canonicalizes to JSON, hashes with a small
dependency-free FNV-1a (32-bit, hex) — a change-detector and audit trail, not a security
boundary, so `node:crypto` would be unnecessary weight for the same guarantee. No secret, prompt,
or upstream response body ever enters the input.

### 15. Atomicity design (audit, no new write path)

The existing `createCombo`/`updateCombo` are each a single synchronous `better-sqlite3` statement
— inherently atomic per call (no interleaving within one Node process); `reorderCombos` and
`deleteCombo` already use an explicit `db.transaction()` for their necessarily multi-statement
work. **A future apply layer should reuse `updateCombo` (single statement, already atomic) for
every A7-planned mutation** — UPDATE_MEMBERSHIP/UPDATE_STRATEGY/UPDATE_SETTINGS/DISABLE
are all single-record replacements of the full `data` blob, which is exactly what `updateCombo`
already does atomically. No raw DB transaction code is introduced by A7; none is needed beyond
what already exists.

### 16. Rollback design (design only)

Before an apply: read the current combo via the existing `getComboById`/`getComboByName` (already
atomic reads) and keep it in memory. If the apply's own post-write validation fails, restore by
calling `updateCombo` again with the captured previous `data` — the same normal write path, never
a raw DB rollback. Because `updateCombo` is already a single atomic statement, "restore" is not a
special code path, it is the identical write operation run with the old payload.

### 17. Restart recovery

No A7-internal state exists to lose. `buildManagedComboDesiredState` is a pure function of
current A2/A3/A4/A5/A6 outputs; a restarted Jarvis reconstructs the exact same desired state by
recomputing observations → evidence → activation → safe set → strategy → desired state fresh
(test R). The only thing NOT reconstructible from scratch is `previousMembers` (needed solely for
the transient-suppression rule, §11) — a future apply layer should read that off the CURRENT live
combo's own `members`, not persist it redundantly anywhere Jarvis-side.

### 18. Status / observability

`buildManagedComboStatus(desired, plan): ManagedComboStatus` — `logicalId`, `comboId`,
`ownership`, `policyMode`, `strategy`, `candidateCount`, `currentFingerprint`,
`desiredFingerprint`, `driftStatus` (`in-sync`/`pending-change`/`drifted`/`foreign`/`unowned`),
`reconciliationAction`, `blocked`, `activationRequiredCount`, `blockedCount`. Flat, small, no
prompt or credential ever included.

### 19. Strict-zero-cost example (spec §22, tested)

20 observed → 6 READY → 3 strict-safe. A7's desired state for the strict pool contains exactly
those 3, strategy as A6 recommends (e.g. `reset-window`) — the other 17 have no code path into
`members` regardless of how they are observed (test C/D, and the real-fixture test Q below).

### 20. General-routing example (spec §23, tested)

OpenRouter's real `cohere/north-mini-code:free` is eligible for the GENERAL managed Combo while
absent from the STRICT_ZERO_COST managed Combo for the exact same safe set — proven with genuine
A2/A3 evidence flowing through A5 into A7 (test P mirrors this with a synthetic pair; the doc's
own Example B from A5 already proved the underlying evidence divergence with the real fixture).

### 21. NVIDIA example (spec §24, real fixture)

Test Q runs NVIDIA's real 82-model live catalog fixture through A2 → A3 → A5 → A7 end to end:
`buildManagedComboDesiredState` produces exactly the 3 known-`claudeCodeEligible:true` members
(`moonshotai/kimi-k3`, `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`) — the other 79 unknown
observations never appear, proving **observation != routing** all the way through to the
Combo-shaped output.

### Explicitly out of scope for A7

- No Combo create/update/delete call anywhere — every function in `src/lib/failover/managedCombo*.ts`
  returns a plain value.
- No managed-Combo apply layer — `planReconciliation`'s output is read-only planning data; "future
  controlled apply" is explicitly the next, unbuilt phase.
- No decision on whether Jarvis should ever auto-resolve operator drift — always reported,
  always blocked, by design.
- No provider/inference request, no Auto-Sync, no model import, no runtime route switch.

### O9 typecheck coverage gate (`check:o9-typecheck`)

Building A7 surfaced a real gap: `npm run typecheck:core`'s `tsconfig.typecheck-core.json` uses
an explicit `files` allowlist that has never included any A2–A7 file — every prior "typecheck
PASS" in this initiative was accurate for that gate but never actually exercised this code under
`tsc`. A first unrestricted check (a scratch project config) found and this session fixed two
genuine A7 authoring bugs (a discriminated-union field present on only two of three variants) and
one pre-existing A5 typing gap (`nativeComboBridge.ts`'s `headroomSaturationByKey` declared
`ReadonlyMap` where the real `rankByHeadroom` requires a mutable `Map`), plus one test-file
generic-inference fix — all now clean.

Rather than widen the curated `typecheck:core` allowlist (a different, narrower-purpose gate —
see `docs/architecture/QUALITY_GATES.md`'s own description of its 27-file allowlist), the fix
follows this repo's OWN established pattern for exactly this situation:
`check-api-typecheck.mjs` / `check-open-sse-typecheck.mjs` already scope `tsc` to one subtree and
diff against a frozen per-file/per-TS-code baseline
(`scripts/check/typecheckBaseline.mjs`). `check:o9-typecheck`
(`scripts/check/check-o9-typecheck.mjs`, `tsconfig.typecheck-o9.json`) is the same pattern applied
to the O9 A2–A7 scope: `src/lib/providerOnboarding/**`, `src/lib/failover/**`,
`src/lib/db/providerActivationApprovals.ts`, and their six focused test files. It reuses the
SAME shared baseline-diff helper the other two gates already use — no new comparison logic.

Three unrelated, pre-existing errors are frozen in `config/quality/o9-typecheck-baseline.json`,
each verified via `git log` to predate this session and this diff entirely:
`open-sse/services/autoCombo/connectionBilling.ts` (last touched in the P4-B evidence commit),
`open-sse/services/providerRuntimeState.ts` (last touched in the D0 FCC-integration commit), and
`src/lib/providerOnboarding/catalog.ts` (A2, `7b59ee597`, several phases before this session). The
first two are ALSO already-failing regressions in the pre-existing, independent
`check:open-sse-typecheck` gate (23 regressions on this same worktree, none of them O9-F3.5
A2–A7 files — they trace to the earlier O9-F1/O9-F3 phases) — corroborating, via a second,
unrelated repo mechanism, that this debt is base-red and not something A2–A7 introduced. None of
the three is fixed here, per Hard Rule discipline against opportunistic unrelated fixes; the
baseline exists precisely so a FUTURE fix to any of them ratchets the gate down
(`--update`) instead of being silently absorbed.
