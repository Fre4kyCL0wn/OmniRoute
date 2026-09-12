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
