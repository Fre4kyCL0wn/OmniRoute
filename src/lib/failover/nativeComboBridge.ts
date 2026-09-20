/**
 * Native Combo Strategy Bridge (O9-F3.5 A5).
 *
 * The smallest pure bridge between a `JarvisSafeCandidateSet` (A5) and the
 * native OmniRoute Combo strategy engine (`open-sse/services/combo.ts` and
 * its `combo/*` / `autoCombo/*` leaves). This module never persists or
 * activates a Combo, never writes `syncedAvailableModels` / `customModels`,
 * and never makes a provider/inference request — it only (a) FILTERS an
 * arbitrary native candidate pool down to Jarvis-approved entries, and (b)
 * DRY-RUNS what a handful of native strategies would then pick from that
 * already-filtered pool, reusing their real pure ranking helpers rather than
 * re-implementing them.
 *
 * Why filtering alone is a hard-exclusion PROOF, not just a policy: source
 * inspection of every native strategy dispatch path —
 * `applyStrategyOrdering` (lkgp / strict-random / random / fill-first / p2c /
 * least-used / cost-optimized / reset-aware / reset-window /
 * context-optimized / cache-optimized / headroom / quota-share),
 * `resolveAutoStrategyOrder` (`auto`), and `tryFusionDispatch` /
 * `tryPipelineDispatch` (fusion / pipeline, both still sourced from
 * `resolveComboTargets`) — shows every one of them REORDERS, SCORES, or
 * SELECTS FROM the array it is handed. None of them ever ADD a candidate
 * that was not already in that array. A route this module's filter removes
 * therefore cannot be reintroduced by any native strategy downstream — this
 * is a structural guarantee of the array-in/array-subset-out shape, not a
 * runtime check any strategy could accidentally bypass.
 *
 * `priority` needs no special-casing here: it is exactly "keep the filtered
 * array's order and try the first eligible entry" — the native code's own
 * comment for `fill-first` ("preserving priority order") confirms this is
 * the array order itself, not a separate ranking step.
 */
import {
  computeHeadroom,
  rankByHeadroom,
  type HeadroomSaturation,
} from "@omniroute/open-sse/services/combo/headroomRanking.ts";
import { getResetWindowRemainingMs } from "@omniroute/open-sse/services/combo/quotaScoring.ts";
import type { RESET_WINDOW_NAMES } from "@omniroute/open-sse/services/combo/types.ts";

import type { JarvisSafeCandidateSet, SafeCandidatePool } from "./jarvisSafeCandidateSet";

type ResetWindowName = (typeof RESET_WINDOW_NAMES)[number];

export interface NativePoolIdentity {
  providerId: string;
  /** Canonical model id, e.g. `nvidia/moonshotai/kimi-k3` — matches `ResolvedComboTarget.modelStr` and A4's `FailoverCandidate.routeId`. */
  routeId: string;
  /** `null` for a provider-wide catalog entry with no connection chosen yet (matches `ResolvedComboTarget.connectionId`). */
  connectionId: string | null;
}

function connectionKey(providerId: string, connectionId: string, routeId: string): string {
  return `${providerId}::${connectionId}::${routeId}`;
}

function routeKey(providerId: string, routeId: string): string {
  return `${providerId}::${routeId}`;
}

/**
 * Pure structural filter: keep only pool items whose identity is a member of
 * the requested Jarvis pool. Never mutates `pool`; always returns a subset of
 * it (possibly empty), which is the whole hard-exclusion guarantee — nothing
 * downstream can select an item this function did not return.
 */
export function filterToJarvisSafeCandidateSet<T>(
  pool: readonly T[],
  identity: (item: T) => NativePoolIdentity,
  safeSet: JarvisSafeCandidateSet,
  poolKind: SafeCandidatePool
): T[] {
  const membership =
    poolKind === "strictZeroCost" ? safeSet.membership.strictZeroCost : safeSet.membership.general;
  const membershipByRoute =
    poolKind === "strictZeroCost"
      ? safeSet.membershipByRoute.strictZeroCost
      : safeSet.membershipByRoute.general;

  return pool.filter((item) => {
    const id = identity(item);
    if (id.connectionId) {
      return membership.has(connectionKey(id.providerId, id.connectionId, id.routeId));
    }
    // No specific connection on this pool entry (e.g. a provider-wide auto-combo
    // catalog expansion) — safe only if AT LEAST ONE connection for this exact
    // route is Jarvis-approved; OmniRoute's own account-selection layer resolves
    // the actual connection later.
    return membershipByRoute.has(routeKey(id.providerId, id.routeId));
  });
}

// ---------------------------------------------------------------------------
// Native adapters — identity extractors only, no behavior duplicated
// ---------------------------------------------------------------------------

/** Identity extractor for `open-sse/services/combo/types.ts::ResolvedComboTarget`-shaped pool entries. */
export function resolvedComboTargetIdentity(target: {
  provider: string;
  modelStr: string;
  connectionId: string | null;
}): NativePoolIdentity {
  return {
    providerId: target.provider,
    routeId: target.modelStr,
    connectionId: target.connectionId,
  };
}

/** Identity extractor for `open-sse/services/autoCombo/scoring.ts::ProviderCandidate`-shaped pool entries. */
export function providerCandidateIdentity(candidate: {
  provider: string;
  model: string;
  connectionId?: string;
}): NativePoolIdentity {
  const routeId = candidate.model.includes("/")
    ? candidate.model
    : `${candidate.provider}/${candidate.model}`;
  return { providerId: candidate.provider, routeId, connectionId: candidate.connectionId ?? null };
}

// ---------------------------------------------------------------------------
// Strategy dry-run (A5 spec §18) — read-only, no live routing
// ---------------------------------------------------------------------------

export type NativeStrategyName = "priority" | "headroom" | "reset-window" | "custom-score";

export interface NativeStrategyDryRunInput<T> {
  /** The RAW native pool — filtering to the Jarvis-safe subset happens inside this function. */
  pool: readonly T[];
  identity: (item: T) => NativePoolIdentity;
  safeSet: JarvisSafeCandidateSet;
  poolKind: SafeCandidatePool;
  strategy: NativeStrategyName;
  /**
   * `headroom`: real saturation signal per key (reuses the native `HeadroomSaturation` shape).
   * Mutable `Map` to match the real `rankByHeadroom` signature exactly — never mutated here,
   * only read via `.get()`.
   */
  headroomSaturationByKey?: Map<string, HeadroomSaturation>;
  /** `headroom` / `reset-window`: key an item is looked up by; defaults to its `connectionId` (falling back to `routeId`). */
  keyOf?: (item: T) => string;
  /** `reset-window`: raw quota snapshot per key, passed straight to the real `getResetWindowRemainingMs`. */
  resetWindowQuotaByKey?: ReadonlyMap<string, unknown>;
  resetWindows?: ResetWindowName[];
  /** `custom-score`: caller-supplied scorer (e.g. the real `scorePool`/`getTaskFitness` for an auto-combo-shaped dry-run) — never reimplemented here. */
  customScore?: (item: T) => number;
}

export interface NativeStrategyDryRunReport<T> {
  strategy: NativeStrategyName;
  poolCandidateCount: number;
  jarvisRejectedCount: number;
  jarvisApprovedCount: number;
  selected: T | null;
  selectedIdentity: NativePoolIdentity | null;
  nativeSelectionReason: string | null;
}

function defaultKeyOf<T>(identity: (item: T) => NativePoolIdentity, item: T): string {
  const id = identity(item);
  return id.connectionId ?? id.routeId;
}

/**
 * Read-only, side-effect-free strategy dry-run: filter to the Jarvis-safe
 * subset, then apply one native strategy's real ranking logic to that subset
 * only. No live routing, no provider request, no Combo mutation.
 */
export function dryRunNativeStrategy<T>(
  input: NativeStrategyDryRunInput<T>
): NativeStrategyDryRunReport<T> {
  const approved = filterToJarvisSafeCandidateSet(
    input.pool,
    input.identity,
    input.safeSet,
    input.poolKind
  );
  const base = {
    strategy: input.strategy,
    poolCandidateCount: input.pool.length,
    jarvisRejectedCount: input.pool.length - approved.length,
    jarvisApprovedCount: approved.length,
  };

  if (approved.length === 0) {
    return {
      ...base,
      selected: null,
      selectedIdentity: null,
      nativeSelectionReason: "no-jarvis-approved-candidates",
    };
  }

  const keyOf = input.keyOf ?? ((item: T) => defaultKeyOf(input.identity, item));

  switch (input.strategy) {
    case "priority": {
      const selected = approved[0];
      return {
        ...base,
        selected,
        selectedIdentity: input.identity(selected),
        nativeSelectionReason: "priority: first Jarvis-approved target in combo order",
      };
    }

    case "headroom": {
      const ranked = rankByHeadroom(approved, input.headroomSaturationByKey ?? new Map(), keyOf);
      const selected = ranked[0];
      const headroom = computeHeadroom(input.headroomSaturationByKey?.get(keyOf(selected)));
      return {
        ...base,
        selected,
        selectedIdentity: input.identity(selected),
        nativeSelectionReason: `headroom: ${(headroom * 100).toFixed(1)}% free capacity`,
      };
    }

    case "reset-window": {
      const windows = input.resetWindows ?? (["weekly"] as ResetWindowName[]);
      const ranked = approved
        .map((item) => ({
          item,
          remainingMs: getResetWindowRemainingMs(
            input.resetWindowQuotaByKey?.get(keyOf(item)) ?? null,
            windows
          ),
        }))
        .sort((a, b) => a.remainingMs - b.remainingMs);
      const selected = ranked[0].item;
      return {
        ...base,
        selected,
        selectedIdentity: input.identity(selected),
        nativeSelectionReason:
          ranked[0].remainingMs === Infinity
            ? "reset-window: no known reset (last resort)"
            : `reset-window: resets in ${ranked[0].remainingMs}ms`,
      };
    }

    case "custom-score": {
      if (!input.customScore) {
        throw new Error("dryRunNativeStrategy: strategy 'custom-score' requires customScore");
      }
      const ranked = approved
        .map((item) => ({ item, score: input.customScore!(item) }))
        .sort((a, b) => b.score - a.score);
      const selected = ranked[0].item;
      return {
        ...base,
        selected,
        selectedIdentity: input.identity(selected),
        nativeSelectionReason: `custom-score: ${ranked[0].score.toFixed(3)}`,
      };
    }
  }
}
