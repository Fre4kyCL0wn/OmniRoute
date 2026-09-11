/**
 * FCC Preferred-Candidate Ranking Signal (O9-F3.3P1-D0, Schritt 6).
 *
 * Deliberately NOT: `if (fccKnown) chooseFirst()`.
 *
 * FCC compatibility evidence may only ever ADD a soft ranking signal, and
 * only after the hard eligibility gate has already passed
 * (`executable === true` AND the route's own eligibility flag is `true`).
 * Quota/health/cost policy is computed entirely upstream in
 * `providerRuntimeState.ts` / `capabilityEligibility.ts` and is never
 * re-decided here — this module has no access to those dimensions by
 * construction (its input type below does not carry them).
 *
 * This module is NOT wired into `open-sse/services/combo.ts` scoring yet —
 * that is a follow-up phase once the signal has been reviewed. D0 only
 * ships the pure, tested signal-computation function.
 */

import type { FccModelEvidence } from "@omniroute/open-sse/config/providers/fccCatalog.ts";

export interface FccRankingSignal {
  /** FCC has ANY evidence for this (provider, model) — informational only. */
  fccKnown: boolean;
  fccClaudeCodeCompatible: boolean | null;
  fccCodexCompatible: boolean | null;
  fccOpenCodeCompatible: boolean | null;
  /**
   * `true` only when hard eligibility already passed AND FCC has evidence —
   * this is the ONLY field a scorer may branch on to decide whether the
   * signal may influence ranking at all.
   */
  applies: boolean;
}

/**
 * The hard-eligibility facts a caller must already have proven before this
 * signal may apply. Deliberately narrow: no health/quota/cost fields exist on
 * this type, so a caller cannot accidentally let FCC evidence stand in for
 * them.
 */
export interface FccRankingGate {
  executable: boolean | null;
  /** The route-specific eligibility flag (genericToolEligible / codingEligible / claudeCodeEligible / …). */
  routeEligible: boolean | null;
}

/**
 * Compute the FCC ranking signal for one (provider, model). Pure, DB-free,
 * no IO. `evidence` is `null` when FCC has nothing for this pair — that is
 * "unknown", not a negative verdict, and `fccKnown` reflects that.
 */
export function computeFccRankingSignal(
  evidence: FccModelEvidence | null,
  gate: FccRankingGate
): FccRankingSignal {
  const fccKnown = evidence !== null;
  const hardEligible = gate.executable === true && gate.routeEligible === true;
  return {
    fccKnown,
    fccClaudeCodeCompatible: evidence?.claudeCode.compatible ?? null,
    fccCodexCompatible: evidence?.codex.compatible ?? null,
    fccOpenCodeCompatible: evidence?.openCode.compatible ?? null,
    applies: fccKnown && hardEligible,
  };
}
