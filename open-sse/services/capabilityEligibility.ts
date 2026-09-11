/**
 * Capability → Eligibility Producer (O9-F3.3P1-D2; `verifiedFree` added in
 * O9-F3.4 P4-A).
 *
 * Maps the Direct Provider Capability Metadata (`ProviderModelInfo`, D1) — the
 * proven FACT layer — onto the runtime-state eligibility booleans
 * (`EligibilityCapabilities`). Each eligibility is an INDEPENDENT dimension
 * proven separately; none is inferred from another and there is NO
 * cross-field derivation (e.g. `<x>Eligible` never implies `supervisorEligible`,
 * and `verifiedFree` never implies `claudeCodeEligible` or vice versa).
 *
 * Fail-closed semantics (mirrors providerRuntimeState / freeModelEligibility):
 *   - `true`   — a layer PROVES the capability (positive fact).
 *   - `false`  — a layer PROVES the opposite (negative fact: not-served model,
 *                no tool calling, curated "general"/"standard"/"mid"/"weak").
 *   - `null`   — unproven / unknown; consumers treat it as NOT eligible. A
 *                `false` is a verdict, never conflated with unknown `null`.
 *
 * `executable` is the only field resolved from the provider REGISTRY rather
 * than the model facts: a catalog-validated provider (no passthrough) cannot
 * execute a model it does not curate (proven `false`); an unregistered provider
 * is unknown (`null`).
 */

import { type ProviderModelInfo } from "@omniroute/open-sse/config/providers/directCapabilities.ts";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The independent capability-eligibility verdicts (fail-closed). */
export interface EligibilityCapabilities {
  executable: boolean | null;
  fastEligible: boolean | null;
  codingEligible: boolean | null;
  genericToolEligible: boolean | null;
  claudeCodeEligible: boolean | null;
  supervisorEligible: boolean | null;
  /**
   * Economic evidence (O9-F3.4 P4-A) — sourced from `FREE_MODEL_BUDGETS`
   * (`freeModelCatalog.data.ts`) via `resolveVerifiedFree`, entirely
   * independent of the six capability dimensions above. NOT the same as
   * "safe to route under a strict zero-cost policy" — see
   * `resolveVerifiedFree`'s docblock and P4-B (account/connection billing
   * safety, `hardStopGuaranteed`), both still open.
   */
  verifiedFree: boolean | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `true` → true, `false` → false, `null` → null (proven negative stays). */
function mapFlag(value: boolean | null): boolean | null {
  return value ?? null;
}

/** Class verdict: only the exact proven class is `true`; a known other class
 *  is a proven `false`; unknown stays `null`. */
function mapClass<T>(value: T | null, target: T): boolean | null {
  if (value === null) return null;
  return value === target;
}

function isModelServed(providerId: string, model: string): boolean | null {
  const entry = getRegistryEntry(providerId);
  if (!entry) return null;
  if (!entry.format || !entry.executor) return null;
  if (entry.passthroughModels) return true;
  return entry.models.some((candidate) => candidate.id === model);
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/**
 * Produce the six eligibility verdicts for a direct provider's model from its
 * extracted `ProviderModelInfo`. Pure, DB-free, deterministic — same layer
 * contract as D1 (registry + static + curated; the enriched runtime layer is
 * already folded into `info` by the caller who extracted it).
 */
export function produceCapabilities(info: ProviderModelInfo): EligibilityCapabilities {
  return {
    executable: isModelServed(info.provider, info.model),
    fastEligible: mapClass(info.latencyClass, "fast"),
    codingEligible: mapClass(info.codingClass, "coding"),
    genericToolEligible: mapFlag(info.toolCalling),
    claudeCodeEligible: mapFlag(info.claudeCodeReady),
    supervisorEligible: mapClass(info.strengthClass, "frontier"),
    verifiedFree: mapFlag(info.verifiedFree),
  };
}
