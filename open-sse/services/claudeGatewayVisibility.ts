/**
 * Claude Gateway Visibility Policy (O9-F3.3P1-D4, re-scoped).
 *
 * D4 does NOT build a new gateway-id system. OmniRoute already ships a
 * production `claude/<provider>/<model>` discovery mirror
 * (`open-sse/utils/ccDiscoveryAliases.ts`) and a `no-think/<provider>/<model>`
 * mirror (`open-sse/utils/noThinkingAlias.ts` — itself a prior free-claude-code
 * port, "Fase 8.1"), both wired into every chat transport's decode path
 * already. Those stay authority for encode/decode, prefix shape, and the
 * request-path routing guarantees — nothing here touches them.
 *
 * What was missing: the `claude/…` mirror's visibility gate had NO
 * capability-proof check — any already-catalogued model got mirrored once the
 * feature flag was on, with no tie to whether the model is actually
 * Jarvis-executable or proven Claude-Code-compatible. This module is that
 * missing capability-aware visibility POLICY — a pure decision function plus
 * two small integration helpers that compose with (never replace) the
 * existing flag/predicate machinery.
 *
 * Source of truth: `ProviderModelInfo` (D1, `directCapabilities.ts`) →
 * `produceCapabilities` (D2, `capabilityEligibility.ts`) → `executable` /
 * `claudeCodeEligible`. Both are pure, DB-free, synchronous — this module
 * calls them directly rather than through `getProviderRuntimeState`
 * (deliberate; see the docblock on `resolveClaudeGatewayCapabilities` below)
 * so the model catalog never flaps on transient provider health/quota and
 * never pays a per-model DB/runtime cost.
 *
 * FCC (D3) is never consulted here directly, by construction: D1 does not
 * read FCC evidence today, so "FCC knows this provider" cannot leak into
 * `claudeCodeEligible` through this path — matching the D0 invariant that FCC
 * is corroborating evidence, never an availability dependency, and the D3
 * finding that FCC's provider catalog is not a model capability catalog.
 */

import { extractProviderModelInfo } from "@omniroute/open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "@omniroute/open-sse/services/capabilityEligibility.ts";
import {
  isNoThinkingAlias,
  stripNoThinkingAlias,
} from "@omniroute/open-sse/utils/noThinkingAlias.ts";

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

export type ClaudeGatewayVisibilityReason =
  | "visible"
  | "feature-disabled"
  | "not-executable"
  | "claude-code-ineligible"
  | "claude-code-unknown"
  | "existing-alias-policy-rejected";

export interface ClaudeGatewayVisibilityResult {
  visible: boolean;
  reason: ClaudeGatewayVisibilityReason;
}

export interface ClaudeGatewayVisibilityInput {
  /** The relevant master feature flag (claude mirror, or no-think mirror) for this entry. */
  featureEnabled: boolean;
  /** Result of the EXISTING alias predicate (ccAliasPredicate / shouldExposeNoThinkingAlias) for this entry. */
  existingAliasPolicyAllows: boolean;
  /** D2 `executable` — registry-proven, never transient health/quota. */
  executable: boolean | null;
  /** D2 `claudeCodeEligible`. */
  claudeCodeEligible: boolean | null;
}

/**
 * Decide whether one (provider, model) may be exposed via the existing
 * Claude gateway mirrors. Pure, no IO. Order matters for the reported reason
 * (cheapest/most-fundamental rejection first) but not for the boolean result.
 *
 * Fail-closed: `executable` must be exactly `true`; `claudeCodeEligible` must
 * be exactly `true` — `null` (unknown) and `false` (proven negative) both
 * reject, and are reported as distinct reasons for diagnosis.
 */
export function evaluateClaudeGatewayVisibility(
  input: ClaudeGatewayVisibilityInput
): ClaudeGatewayVisibilityResult {
  if (!input.featureEnabled) {
    return { visible: false, reason: "feature-disabled" };
  }
  if (!input.existingAliasPolicyAllows) {
    return { visible: false, reason: "existing-alias-policy-rejected" };
  }
  if (input.executable !== true) {
    return { visible: false, reason: "not-executable" };
  }
  if (input.claudeCodeEligible === null) {
    return { visible: false, reason: "claude-code-unknown" };
  }
  if (input.claudeCodeEligible !== true) {
    return { visible: false, reason: "claude-code-ineligible" };
  }
  return { visible: true, reason: "visible" };
}

// ---------------------------------------------------------------------------
// Capability lookup (static seam — see module docblock)
// ---------------------------------------------------------------------------

export interface ClaudeGatewayCapabilities {
  executable: boolean | null;
  claudeCodeEligible: boolean | null;
}

/**
 * Resolve the two facts this gate needs directly from the D1 → D2 pure
 * pipeline, WITHOUT going through `getProviderRuntimeState`.
 *
 * Deliberate choice (Schritt 11 performance + Schritt 4 "no transient state
 * in the catalog"): `getProviderRuntimeState` is async, reads the DB
 * (provider_connections, quota, cost), and mixes in providerHealth/quotaState
 * — exactly the transient signals the catalog must NOT flap on, and exactly
 * the per-model DB cost a catalog build over many models must not pay N
 * times. `produceCapabilities(extractProviderModelInfo(...))` is the SAME
 * producer `getProviderRuntimeState.capabilities` is built from (see
 * `providerRuntimeState.ts`'s own wiring) — calling it directly reuses the
 * single source of truth without the unrelated DB-backed fields riding along.
 */
export function resolveClaudeGatewayCapabilities(
  provider: string,
  model: string
): ClaudeGatewayCapabilities {
  const info = extractProviderModelInfo(provider, model);
  const caps = produceCapabilities(info);
  return { executable: caps.executable, claudeCodeEligible: caps.claudeCodeEligible };
}

// ---------------------------------------------------------------------------
// Catalog integration (composes with, never replaces, the existing gates)
// ---------------------------------------------------------------------------

interface GatewayMirrorCandidate {
  id?: unknown;
  owned_by?: unknown;
}

/**
 * Split a catalog entry id into (provider, model) using the SAME convention
 * `ccAliasPredicate.ts` already uses: split on the FIRST "/", everything
 * after is the model id even if it itself contains "/". Combo entries
 * (`owned_by === "combo"`) and bare ids with no provider prefix have no D1/D2
 * capability facts to check — out of scope for this gate, existing behavior
 * applies to them unchanged (same boundary the existing predicate already
 * draws for bare ids).
 */
function splitProviderModel(
  entry: GatewayMirrorCandidate
): { provider: string; model: string } | null {
  const id = entry.id;
  if (typeof id !== "string" || id.length === 0) return null;
  if (entry.owned_by === "combo") return null;
  const slashIndex = id.indexOf("/");
  if (slashIndex <= 0) return null;
  return { provider: id.slice(0, slashIndex), model: id.slice(slashIndex + 1) };
}

/**
 * Wrap an EXISTING `claude/…` mirror-eligibility predicate (e.g. the output
 * of `buildCcAliasPredicate`) with the new capability gate: `existingPredicate
 * AND capabilityGate`. Entries the capability gate has no opinion about
 * (combos, bare ids) fall through to the existing predicate's own verdict
 * unchanged.
 *
 * Use at the `appendCcDiscoveryAliases` call site — this runs BEFORE mirror
 * entries are synthesized, so a rejected model never gets a wasted `claude/…`
 * entry allocated in the first place.
 */
export function withClaudeGatewayCapabilityGate<T extends GatewayMirrorCandidate>(
  existingPredicate: (entry: T) => boolean
): (entry: T) => boolean {
  return (entry: T) => {
    if (!existingPredicate(entry)) return false;
    const split = splitProviderModel(entry);
    if (!split) return true; // out of scope for this gate (combo / bare id) — existing predicate already said yes
    const caps = resolveClaudeGatewayCapabilities(split.provider, split.model);
    return evaluateClaudeGatewayVisibility({
      featureEnabled: true, // already passed by existingPredicate to reach here
      existingAliasPolicyAllows: true, // already passed by existingPredicate to reach here
      executable: caps.executable,
      claudeCodeEligible: caps.claudeCodeEligible,
    }).visible;
  };
}

interface NoThinkMirrorEntry {
  id?: unknown;
}

/**
 * Post-filter for the ALREADY-appended `no-think/<provider>/<model>` catalog
 * entries. `appendNoThinkingVariants` (open-sse/utils/noThinkingAlias.ts) has
 * no injectable per-model predicate, so — to avoid touching that frozen
 * module's contract — this runs AFTER the existing append call and removes
 * only the `no-think/…` entries that fail the new capability gate. Every
 * other entry (originals, and any entry that isn't a no-think mirror) passes
 * through completely unchanged, in original order.
 */
export function filterNoThinkingMirrorsByCapability<T extends NoThinkMirrorEntry>(
  models: T[]
): T[] {
  if (!Array.isArray(models) || models.length === 0) return models;
  return models.filter((entry) => {
    const id = entry.id;
    if (typeof id !== "string" || !isNoThinkingAlias(id)) return true;
    const real = stripNoThinkingAlias(id);
    const slashIndex = real.indexOf("/");
    if (slashIndex <= 0) return true; // no parseable provider — out of scope, existing behavior
    const provider = real.slice(0, slashIndex);
    const model = real.slice(slashIndex + 1);
    const caps = resolveClaudeGatewayCapabilities(provider, model);
    return evaluateClaudeGatewayVisibility({
      featureEnabled: true, // already passed (the entry exists only because the flag was on)
      existingAliasPolicyAllows: true, // already passed shouldExposeNoThinkingAlias to exist
      executable: caps.executable,
      claudeCodeEligible: caps.claudeCodeEligible,
    }).visible;
  });
}
