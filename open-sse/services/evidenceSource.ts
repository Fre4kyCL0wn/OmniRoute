/**
 * Evidence Source Abstraction (O9-F3.3P1-D0).
 *
 * Jarvis/O9 aggregates provider/model facts from multiple external and
 * internal sources. This module gives every fact a named `EvidenceSource` and
 * a pure, per-dimension priority resolver so a caller can say "for THIS
 * dimension, prefer THIS source order" without hand-rolling `??` chains that
 * silently let the wrong source win.
 *
 * This module does not know about providers, models, or FCC specifically —
 * it is the generic mechanism `fccCatalog.ts` / `fccRankingSignal.ts` build on.
 *
 * Hard invariant (O9-F3.3P1-D0 Schritt 4): a source that is not in a
 * dimension's priority list can NEVER win for that dimension, no matter how
 * confident its value looks. In particular `fcc_catalog` is deliberately
 * absent from `COST_FREE_SOURCE_PRIORITY` — FCC evidence must never turn a
 * trial into recurring-free, a paid model into free, or override quota/health.
 */

export type EvidenceSource =
  | "omniroute_registry"
  | "provider_discovery"
  | "models_dev"
  | "fcc_catalog"
  | "shadow_validation"
  | "manual_verified";

export interface SourcedValue<T> {
  source: EvidenceSource;
  value: T | null | undefined;
}

export interface ResolvedValue<T> {
  source: EvidenceSource;
  value: T;
}

/**
 * Coding-agent / harness compatibility priority (Schritt 4 example):
 * a live shadow-validation probe beats FCC's curated catalog, which beats
 * models.dev, which beats OmniRoute's own static heuristic. Unknown (no
 * candidate proven) stays unknown — never guessed.
 */
export const CODING_COMPAT_SOURCE_PRIORITY: readonly EvidenceSource[] = [
  "shadow_validation",
  "fcc_catalog",
  "models_dev",
  "omniroute_registry",
];

/**
 * Cost / free-regime priority (Schritt 4 example): only sources Jarvis has
 * independently verified may decide cost/free truths. `fcc_catalog`,
 * `provider_discovery` and `models_dev` are intentionally absent — they never
 * resolve for this dimension, by construction (see module docblock).
 */
export const COST_FREE_SOURCE_PRIORITY: readonly EvidenceSource[] = [
  "manual_verified",
  "shadow_validation",
  "omniroute_registry",
];

/**
 * Resolve the highest-priority PROVEN (non-null/undefined) candidate for a
 * dimension. Pure, deterministic, no IO. A candidate whose source is absent
 * from `priority` is never considered, regardless of its value.
 */
export function resolveBySourcePriority<T>(
  candidates: readonly SourcedValue<T>[],
  priority: readonly EvidenceSource[]
): ResolvedValue<T> | null {
  for (const source of priority) {
    const match = candidates.find(
      (candidate) =>
        candidate.source === source && candidate.value !== null && candidate.value !== undefined
    );
    if (match) {
      return { source, value: match.value as T };
    }
  }
  return null;
}

/** True if `source` is eligible to resolve for the given priority list at all. */
export function isSourceEligibleFor(
  source: EvidenceSource,
  priority: readonly EvidenceSource[]
): boolean {
  return priority.includes(source);
}
