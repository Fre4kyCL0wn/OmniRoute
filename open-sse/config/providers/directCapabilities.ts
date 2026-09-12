/**
 * Direct Provider Capability Metadata (O9-F3.3P1-D1).
 *
 * Provider-model-info extraction for the DIRECT free/free-tier provider pool —
 * the providers OmniRoute talks to directly (groq, cerebras, and future
 * gemini/nvidia), not through an aggregator. Echoes the free-claude-code (FCC)
 * ProviderModelInfo concept: a single normalized per-(provider, model)
 * capability record assembled from the existing layered sources.
 *
 * Layer precedence (first proven value wins):
 *   1. `enriched` — an OPTIONAL runtime/synced capability layer provided by the
 *      caller (D2 / providerRuntimeState), e.g. the full resolved capabilities
 *      or a models.dev synced row. Deferred to the caller so this module stays
 *      a DB-free, deterministic, pure extraction (no SQLite, no synced cache).
 *   2. Static base — the provider `RegistryModel` (registry toolCalling /
 *      supportsReasoning / supportsVision / contextLength / maxOutputTokens)
 *      then the static `ModelSpec` (MODEL_SPECS) for the model id (or its
 *      leaf, for path-shaped ids). For `toolCalling` only, an exact curated
 *      `DIRECT_MODEL_FACTS` entry sits between the two: it covers live-catalog
 *      models of pass-through providers that are deliberately NOT static
 *      registry rows (a registry row would also enter AutoCombo/quota pools).
 *   3. Curated judgement — `DIRECT_PROVIDER_JUDGEMENTS` (see
 *      directCapabilities.data.ts): hand-set facts with `// evidence:`
 *      citations that no source derives automatically.
 *
 * Contract (mirrors providerRuntimeState):
 *   - Each field is an INDEPENDENT dimension; none is inferred from another.
 *   - Unknown / unproven stays null — null is "not eligible" to consumers.
 *   - No optimistic TRUE assumptions: a field is only true when a layer proves it.
 */

import { getModelSpec } from "@/shared/constants/modelSpecs";
import {
  PROVIDER_ID_TO_ALIAS,
  PROVIDER_MODELS,
} from "@omniroute/open-sse/config/providerModels.ts";
import {
  FREE_MODEL_BUDGETS,
  type FreeModelFreeType,
} from "@omniroute/open-sse/config/freeModelCatalog.ts";

import { getRegistryEntry } from "../providerRegistry.ts";
import { DIRECT_MODEL_FACTS, DIRECT_PROVIDER_JUDGEMENTS } from "./directCapabilities.data.ts";
import type { RegistryModel } from "./shared.ts";

export {
  DIRECT_CAPABILITY_CURATED_AT,
  DIRECT_CAPABILITY_PROVIDERS,
  DIRECT_MODEL_FACTS,
  DIRECT_PROVIDER_JUDGEMENTS,
} from "./directCapabilities.data.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Curated judgement facts (see directCapabilities.data.ts for provenance rules). */
export interface DirectProviderJudgement {
  /** Proven to serve low-latency / "fast lane" (Groq positioning). */
  latencyClass: "fast" | "standard" | null;
  /** Proven coding-strength class (gpt-oss family, coder variants). */
  codingClass: "coding" | "general" | "weak" | null;
  /** Proven model-strength tier (frontier → supervisor-capable). */
  strengthClass: "frontier" | "mid" | "light" | null;
  /** Proven usable under the Claude Code gateway (selectable id + translator). */
  claudeCodeReady: boolean | null;
}

/** Optional runtime/synced capability layer merged above the static base. */
export interface ProviderModelInfoEnrichment {
  toolCalling?: boolean | null;
  supportsReasoning?: boolean | null;
  supportsThinking?: boolean | null;
  supportsVision?: boolean | null;
  supportsAudio?: boolean | null;
  supportsVideo?: boolean | null;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
}

/**
 * Normalized direct-provider model capability record. `provider`/`model` carry
 * the caller's identity; every capability field is fail-closed `null` unless a
 * layer proves it.
 */
export interface ProviderModelInfo {
  provider: string;
  model: string;

  /** Function/tool-calling support (protocol-level). */
  toolCalling: boolean | null;
  /** Reasoning-capable (non-thinking disabled); from registry/spec. */
  supportsReasoning: boolean | null;
  /** Extended-thinking capable; from static spec (registry has no thinking). */
  supportsThinking: boolean | null;
  supportsVision: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  contextLength: number | null;
  maxOutputTokens: number | null;

  latencyClass: DirectProviderJudgement["latencyClass"];
  codingClass: DirectProviderJudgement["codingClass"];
  strengthClass: DirectProviderJudgement["strengthClass"];
  claudeCodeReady: DirectProviderJudgement["claudeCodeReady"];

  /**
   * Economic evidence (O9-F3.4 P4-A), sourced independently from the
   * capability facts above — see `resolveVerifiedFree` for the exact
   * fail-closed mapping from `FreeModelBudget.freeType`. NOT auto-charge-safe
   * by itself: `hardStopGuaranteed` and account/connection billing safety
   * (P4-B) are separate, still-unimplemented dimensions this field
   * deliberately does not fold in. A model may be `verifiedFree: true` and
   * still be unsafe for a strict zero-cost policy.
   */
  verifiedFree: boolean | null;
}

const NULL_JUDGEMENT: DirectProviderJudgement = {
  latencyClass: null,
  codingClass: null,
  strengthClass: null,
  claudeCodeReady: null,
};

// ---------------------------------------------------------------------------
// Static extraction (DB-free, deterministic)
// ---------------------------------------------------------------------------

/** Last path segment of a path-shaped model id (`qwen/qwen3.6-27b` → `qwen3.6-27b`). */
function leafModelId(modelId: string): string | null {
  if (!modelId.includes("/")) return null;
  const leaf = modelId.split("/").filter(Boolean).pop() ?? null;
  return leaf && leaf !== modelId ? leaf : null;
}

function findRegistryModel(providerId: string, modelId: string): RegistryModel | null {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  const models = PROVIDER_MODELS[alias];
  if (!Array.isArray(models)) return null;
  return models.find((model) => model?.id === modelId) || null;
}

function findStaticSpec(modelId: string) {
  return getModelSpec(modelId) ?? getModelSpec(leafModelId(modelId) ?? "") ?? undefined;
}

interface StaticCapabilityFacts {
  registryModel: RegistryModel | null;
  toolCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsThinking: boolean | null;
  supportsVision: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
}

/** Curated `DIRECT_MODEL_FACTS` entry: exact provider + exact model id only. */
function curatedModelFact(providerId: string, modelId: string) {
  // No prefix, family or suffix matching.
  if (!Object.prototype.hasOwnProperty.call(DIRECT_MODEL_FACTS, providerId)) return undefined;
  const byModel = DIRECT_MODEL_FACTS[providerId];
  return Object.prototype.hasOwnProperty.call(byModel, modelId) ? byModel[modelId] : undefined;
}

/**
 * Resolve capability facts from the DB-free static layers only: the provider
 * registry (`RegistryModel`), an exact curated `DIRECT_MODEL_FACTS` entry
 * (`toolCalling` only), then the static `ModelSpec`. The runtime/synced/override
 * layers are intentionally NOT read here (SQLite cold path) — callers enrich
 * via `extractProviderModelInfo`.
 */
function staticCapabilityFacts(providerId: string, modelId: string): StaticCapabilityFacts {
  const registryModel = findRegistryModel(providerId, modelId);
  const spec = findStaticSpec(modelId);
  const curated = curatedModelFact(providerId, modelId);
  return {
    registryModel,
    toolCalling: registryModel?.toolCalling ?? curated?.toolCalling ?? spec?.supportsTools ?? null,
    supportsReasoning: registryModel?.supportsReasoning ?? spec?.supportsThinking ?? null,
    supportsThinking: spec?.supportsThinking ?? null,
    supportsVision: registryModel?.supportsVision ?? spec?.supportsVision ?? null,
    supportsAudio: registryModel?.supportsAudio ?? spec?.supportsAudio ?? null,
    supportsVideo: registryModel?.supportsVideo ?? spec?.supportsVideo ?? null,
    contextLength: registryModel?.contextLength ?? spec?.contextWindow ?? null,
    maxOutputTokens: registryModel?.maxOutputTokens ?? spec?.maxOutputTokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// Curated judgement lookup
// ---------------------------------------------------------------------------

/**
 * Is `model` actually served by `provider`? A catalog-validated provider (no
 * `passthroughModels`) serves only its registry models; a passthrough provider
 * serves any id. Used to scope provider-wide `"*"` judgement defaults so they
 * apply to every model the provider serves — not to arbitrary `provider/…`
 * ids it would reject.
 */
function isModelServedByProvider(provider: string, model: string): boolean {
  const entry = getRegistryEntry(provider);
  if (!entry) return false;
  if (entry.passthroughModels) return true;
  return entry.models.some((candidate) => candidate.id === model);
}

/**
 * Curated judgement for (provider, model). Provider-wide `"*"` defaults are
 * merged under the per-model entry (per-model wins field-by-field); `"*"`
 * applies only when the provider actually serves the model (registry model or
 * passthrough provider) — never to a `groq/<unknown-id>` prefix. Missing
 * entries return the all-null judgement (fail-closed). Pure, never throws.
 */
export function getDirectProviderJudgement(
  provider: string,
  model: string
): DirectProviderJudgement {
  const providerJudgements = DIRECT_PROVIDER_JUDGEMENTS[provider];
  if (!providerJudgements) return { ...NULL_JUDGEMENT };
  const merged: DirectProviderJudgement = { ...NULL_JUDGEMENT };
  const entries = [providerJudgements["*"], providerJudgements[model]];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === providerJudgements["*"] && !isModelServedByProvider(provider, model)) {
      continue;
    }
    for (const key of Object.keys(entry) as (keyof DirectProviderJudgement)[]) {
      const value = entry[key];
      if (value !== undefined && value !== null) {
        (merged as Record<keyof DirectProviderJudgement, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Verified-free lookup (O9-F3.4 P4-A — freeModelCatalog.data.ts evidence)
// ---------------------------------------------------------------------------

/**
 * `freeType`s whose allowance genuinely renews on its own (matches the
 * existing `RECURRING_TOKEN_BUCKETS` grouping in `freeModelCatalog.ts` —
 * `recurring-daily`/`recurring-monthly` -> "steady-monthly",
 * `recurring-credit` -> "recurring-credit", `recurring-uncapped` ->
 * "uncapped"). Kept as its own small set here (rather than re-deriving from
 * `FREE_REGIME_TRAITS`) so this module's fail-closed contract is visible
 * without chasing an indirection — mirroring the D4.1 methodology note in
 * `directCapabilities.data.ts`.
 */
const RECURRING_FREE_TYPES: ReadonlySet<FreeModelFreeType> = new Set([
  "recurring-daily",
  "recurring-monthly",
  "recurring-credit",
  "recurring-uncapped",
]);

/**
 * Resolve `verifiedFree` for (provider, model) from the curated
 * `FREE_MODEL_BUDGETS` catalog — an economic-evidence source entirely
 * independent of the capability facts elsewhere in this module. Fail-closed:
 *
 *   - `true`  — catalogued under a recurring `freeType` (proven, renewing).
 *   - `false` — catalogued under `one-time-initial`: a real grant, but
 *     proven NOT recurring (a verdict, not "unknown" — matches the D2
 *     contract that a proven negative is never conflated with null).
 *   - `null`  — no catalog entry, or a `freeType` this resolver
 *     deliberately does not classify either way (`keyless` — no credential
 *     exists, a different risk axis than a recurring account quota, already
 *     handled by `allowsNoAuthShortcut` in `strictZeroCostFilter.ts`;
 *     `discontinued` — catalog-freshness note, not evidence about the
 *     model's current regime).
 *
 * Never reads `hardStopGuaranteed` or any live/DB state — that is P4-B's
 * account/connection billing-safety layer, explicitly out of scope here.
 */
export function resolveVerifiedFree(provider: string, model: string): boolean | null {
  const entry = FREE_MODEL_BUDGETS.find((m) => m.provider === provider && m.modelId === model);
  if (!entry) return null;
  if (RECURRING_FREE_TYPES.has(entry.freeType)) return true;
  if (entry.freeType === "one-time-initial") return false;
  return null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function firstProven<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/**
 * Extract the normalized direct-provider capability record for (provider,
 * model). Layer precedence: `enriched` (runtime) > static (registry/spec);
 * curated judgement is independent and merged as-is.
 */
export function extractProviderModelInfo(
  provider: string,
  model: string,
  enriched?: ProviderModelInfoEnrichment
): ProviderModelInfo {
  const staticFacts = staticCapabilityFacts(provider, model);
  const judgement = getDirectProviderJudgement(provider, model);
  return {
    provider,
    model,
    toolCalling: firstProven(enriched?.toolCalling, staticFacts.toolCalling),
    supportsReasoning: firstProven(enriched?.supportsReasoning, staticFacts.supportsReasoning),
    supportsThinking: firstProven(enriched?.supportsThinking, staticFacts.supportsThinking),
    supportsVision: firstProven(enriched?.supportsVision, staticFacts.supportsVision),
    supportsAudio: firstProven(enriched?.supportsAudio, staticFacts.supportsAudio),
    supportsVideo: firstProven(enriched?.supportsVideo, staticFacts.supportsVideo),
    contextLength: firstProven(enriched?.contextLength, staticFacts.contextLength),
    maxOutputTokens: firstProven(enriched?.maxOutputTokens, staticFacts.maxOutputTokens),
    latencyClass: judgement.latencyClass,
    codingClass: judgement.codingClass,
    strengthClass: judgement.strengthClass,
    claudeCodeReady: judgement.claudeCodeReady,
    verifiedFree: resolveVerifiedFree(provider, model),
  };
}
