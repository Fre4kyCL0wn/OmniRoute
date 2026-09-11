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
- **O9-F3.3P1-D4 — Native Claude Code Gateway Visibility**: **COMPLETE (this change, pending
  review)** — re-scoped after audit found the gateway mirror already exists; adds only a
  capability-aware visibility gate (executable + claudeCodeEligible, fail-closed) composed onto
  the existing `claude/…` / `no-think/…` mirrors. No new gateway-id system, no FCC prefix
  adopted, no `/v1/models` shape change with flags off (see below)

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

### Ranking signal (not yet wired into live routing)

`open-sse/services/fccRankingSignal.ts::computeFccRankingSignal(evidence, gate)` produces
`{ fccKnown, fccClaudeCodeCompatible, fccCodexCompatible, fccOpenCodeCompatible, applies }`.
`applies` is `true` **only** when `gate.executable === true` AND the route's own eligibility flag
(`genericToolEligible` / `codingEligible` / `claudeCodeEligible` / …) is already `true` — quota/
health/cost policy is computed entirely upstream and is not even representable as an input to this
function (`FccRankingGate` carries no health/quota/cost fields). This is a hard `if (fccKnown)
chooseFirst()` anti-pattern is explicitly rejected — FCC can only ever add a soft signal on top of
an already-passed hard gate.

**This signal is not yet wired into `open-sse/services/combo.ts` scoring** — D0 ships the pure,
tested function; wiring it into live Auto-Combo ranking is a follow-up phase pending review.

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
  existing `claude/…` / `no-think/…` mirrors — no new gateway-id system) — **COMPLETE (this
  change, pending review)**; `claudeCodeReady` still unseeded, so the gate currently advertises
  nothing new until a research pass proves specific provider/model pairs
- **F3.3P1-D5**: FCC ranking / preferred-candidate selection wiring into `combo.ts` live scoring —
  **NOT STARTED**
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
