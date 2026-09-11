/**
 * FCC Preferred-Candidate Ranking Signal (O9-F3.3P1-D0, Schritt 6; wired by D5).
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
 * `computeFccRankingSignal` itself is UNCHANGED since D0 (still pure, still
 * takes its gate as an explicit argument, still has no DB/network access).
 * O9-F3.3P1-D5 adds exactly one thing: `resolveFccPreferenceSignal` below, a
 * thin wrapper that supplies this function's inputs from the REAL D1/D2 fact
 * pipeline (`extractProviderModelInfo` → `produceCapabilities`) instead of a
 * test fixture, and reduces the result to the single number the AutoCombo
 * scorer consumes. No second FCC ranking implementation was added.
 */

import type { FccModelEvidence } from "@omniroute/open-sse/config/providers/fccCatalog.ts";
import { getFccEvidence } from "@omniroute/open-sse/config/providers/fccCatalog.ts";
import { extractProviderModelInfo } from "@omniroute/open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "./capabilityEligibility.ts";

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

/**
 * O9-F3.3P1-D5: resolve the raw FCC soft-preference number [0,1] for one
 * (provider, model) — the single value `ProviderCandidate.fccPreference`
 * (autoCombo/scoring.ts) carries. Pure, DB-free, no IO: reuses the exact same
 * DB-free D1/D2 extraction the D4 visibility gate uses for
 * `executable`/`claudeCodeEligible`
 * (`open-sse/config/providers/directCapabilities.ts` →
 * `open-sse/services/capabilityEligibility.ts`), and the unmodified D0
 * `computeFccRankingSignal` above — never a parallel ranking path.
 *
 * Hard-gated exactly per the D5 spec (Schritt 5): returns `1` only when ALL
 * of the following are proven —
 *   1. `executable === true` (D1/D2, registry-proven, not transient)
 *   2. `claudeCodeEligible === true` (D1/D2 curated judgement — the SAME
 *      hard fact D4's own visibility gate requires; this function can never
 *      turn a `null` (unknown) or `false` (proven-incompatible) verdict into
 *      a preference — `null -> true` is never done here either)
 *   3. `computeFccRankingSignal(...).applies === true` (FCC has evidence for
 *      this exact provider/model)
 *   4. `fccClaudeCodeCompatible === true` specifically — `applies` alone only
 *      means "the signal may be consulted", not "the verdict is positive"
 *      (see fccRankingSignal.test.ts: an FCC-proven-INCOMPATIBLE model has
 *      `applies: true` too; checking `applies` alone would wrongly boost it)
 * Every other combination (unknown eligibility, proven-incompatible via
 * either D1/D2 or FCC, or FCC has no evidence at all) returns `0` — never a
 * negative penalty. `0` is the neutral "no preference", identical to a
 * candidate FCC has never heard of.
 *
 * KNOWN LIMITATION (documented per Schritt 14, not fixed here — out of D5's
 * minimal-wiring scope): this does a DIRECT `getFccEvidence(provider, model)`
 * lookup, i.e. it assumes the Jarvis provider id IS the FCC provider id. That
 * holds for every provider `directCapabilities.data.ts` currently seeds
 * (groq, cerebras, gemini, nvidia — FCC id/Jarvis id are identical strings
 * for all of these per `fccCatalog.data.ts`'s own header comment) but NOT for
 * the 3 providers in `FCC_PROVIDER_ID_MAP` whose FCC id differs from their
 * Jarvis id (`nvidia_nim`→`nvidia`, `open_router`→`openrouter`,
 * `cloudflare`→`cloudflare-ai`) — for those, real FCC evidence keyed under
 * the FCC-spelled id would be silently missed (never a false positive, only
 * a missed corroboration). The D0/D3 fixture (`fccCatalog.data.ts`) has ZERO
 * entries under any of those 3 FCC ids today, so this has no observable
 * effect right now; a `FCC_PROVIDER_ID_MAP` reverse lookup would be needed
 * before this matters, and is intentionally not built here (no evidence to
 * serve it yet — see Schritt 14 / the D5 docs section's "FCC data reality"
 * note).
 *
 * ALSO per Schritt 14: `fccCatalog.data.ts` is still the D0
 * fixture-illustrative dataset, not a real synced FCC snapshot (D3 only
 * synced the provider-descriptor catalog, not per-model evidence — see
 * PROVIDER_RUNTIME_STATE.md). This function is production-shaped, wired
 * end-to-end, and covered by tests — but with `DEFAULT_WEIGHTS.fccPreference
 * === 0` it has zero effect on live routing until a human deliberately raises
 * that weight (D6), by which point the fixture should have been replaced by
 * real evidence or the D6 activation should say explicitly why not.
 */
export function resolveFccPreferenceSignal(provider: string, model: string): number {
  const capabilities = produceCapabilities(extractProviderModelInfo(provider, model));
  const evidence = getFccEvidence(provider, model);
  const signal = computeFccRankingSignal(evidence, {
    executable: capabilities.executable,
    routeEligible: capabilities.claudeCodeEligible,
  });
  return signal.applies && signal.fccClaudeCodeCompatible === true ? 1 : 0;
}
