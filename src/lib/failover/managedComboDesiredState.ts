/**
 * Managed Combo Desired State (O9-F3.5 A7).
 *
 * Turns A5's `JarvisSafeCandidateSet` + A6's `StrategyRecommendation` into a
 * pure, deterministic description of what a Jarvis-managed native OmniRoute
 * Combo SHOULD look like. No DB read, no DB write, no Combo API call — this
 * module only computes a value.
 *
 * Reuses the EXISTING Combo schema (`src/lib/combos/steps.ts::ComboModelStep`,
 * `src/lib/db/repositories/sqliteComboRepository.ts`) rather than inventing a
 * second routing representation: a `ManagedComboMember` is a
 * `{ routeId, providerId, connectionId, model }` tuple that maps 1:1 onto a
 * `ComboModelStep` (`model` is the bare id, `providerId`/`connectionId`
 * separate — exactly the native step shape), and `strategy` is always one of
 * A6's already-native-verified `CandidateStrategy` values.
 *
 * Ownership identity mirrors the EXISTING internal-combo precedent
 * (`src/lib/quota/quotaCombos.ts`'s `qtSd/…`-prefixed, name-addressed
 * upsert-by-name pattern — an existing system that already programmatically
 * owns its own Combo rows) rather than inventing a new mechanism: a Jarvis
 * logical id is a stable, prefixed combo NAME
 * (`jarvis-managed:<purpose>`), redundantly recorded inside the combo's own
 * free-form `config.jarvisManaged` bag (confirmed extensible —
 * `normalizeComboRecord` spreads the input record and only touches
 * `version`/`models`, so an added `config` key round-trips untouched) so
 * ownership survives even a manual rename.
 */
import type { JarvisSafeCandidateSet, SafeCandidateEntry } from "./jarvisSafeCandidateSet";
import type { CandidateStrategy, StrategyRecommendation } from "./strategyPolicyEngine";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const MANAGED_COMBO_LOGICAL_ID_PREFIX = "jarvis-managed:";
export const MANAGED_COMBO_SCHEMA_VERSION = 1;

/** `purpose` is a short, stable slug (e.g. a brain/project/policy name) — never secrets, never a prompt. */
export function buildManagedComboLogicalId(purpose: string): string {
  const trimmed = purpose.trim();
  if (!trimmed) throw new Error("buildManagedComboLogicalId: purpose must be a non-empty slug");
  return `${MANAGED_COMBO_LOGICAL_ID_PREFIX}${trimmed}`;
}

export function isManagedComboLogicalId(value: string): boolean {
  return value.startsWith(MANAGED_COMBO_LOGICAL_ID_PREFIX);
}

/** Shape a future apply layer writes into `combo.config.jarvisManaged`. Never applied by A7 itself. */
export interface ManagedComboOwnership {
  schemaVersion: typeof MANAGED_COMBO_SCHEMA_VERSION;
  logicalId: string;
  /** The fingerprint of the state Jarvis itself last wrote — the drift-detection anchor (A7 §15). */
  lastAppliedFingerprint: string;
  lastAppliedAt: string;
}

// ---------------------------------------------------------------------------
// Membership — maps 1:1 onto the existing `ComboModelStep` shape
// ---------------------------------------------------------------------------

export interface ManagedComboMember {
  /** Canonical id, e.g. `nvidia/moonshotai/kimi-k3` — matches A5's `SafeCandidateEntry.routeId`. */
  routeId: string;
  providerId: string;
  connectionId: string;
  /** Bare model id (routeId with the `${providerId}/` prefix stripped) — matches `ComboModelStep.model`. */
  model: string;
}

function toManagedComboMember(entry: SafeCandidateEntry): ManagedComboMember {
  const prefix = `${entry.providerId}/`;
  const model = entry.routeId.startsWith(prefix)
    ? entry.routeId.slice(prefix.length)
    : entry.routeId;
  return {
    routeId: entry.routeId,
    providerId: entry.providerId,
    connectionId: entry.connectionId,
    model,
  };
}

function memberKey(member: ManagedComboMember): string {
  return `${member.providerId}::${member.connectionId}::${member.routeId}`;
}

// ---------------------------------------------------------------------------
// Persistent vs transient exclusion (A7 §12 — reuses A4's failure-kind philosophy)
// ---------------------------------------------------------------------------

/**
 * A5 rejection reasons that describe a RUNTIME blip, not a proven
 * disqualification — mirrors A4's own `TRANSIENT_FAILURE_KINDS` concept
 * (`failoverDecision.ts`) one layer up, for candidate-rejection reasons
 * instead of route-failure kinds. A previously-safe member excluded for one
 * of these reasons is KEPT in the desired membership (native OmniRoute's own
 * per-target pre-dispatch gate — circuit breaker, cooldown — already skips
 * it live; A5 proved this in its own audit), rather than triggering a
 * destructive membership rewrite for something that will resolve on its own.
 */
const TRANSIENT_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "COOLDOWN_ACTIVE",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "PROVIDER_HEALTH_FAILURE",
]);

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

export interface ManagedComboDesiredState {
  logicalId: string;
  name: string;
  strategy: CandidateStrategy;
  poolKind: "general" | "strictZeroCost";
  policyMode: string;
  members: ManagedComboMember[];
  /** Defense-in-depth only for `strategy === "auto"` — the real safety guarantee is `members` being non-empty and explicit (A7 §8). */
  config: Record<string, unknown>;
  /** Members kept despite falling out of the live safe set for a TRANSIENT reason (A7 §12) — not new members, not removed either. */
  transientlySuppressed: ManagedComboMember[];
  evidenceFingerprint: string;
  activationRequiredCount: number;
  blockedCount: number;
}

/**
 * `logicalId` / `activationRequiredCount` / `blockedCount` are deliberately
 * hoisted onto EVERY variant (not just the non-"DESIRED" ones) so a caller
 * (reconciliation, status) can read them uniformly without narrowing on
 * `kind` first — narrowing is only needed to reach the routable `state`
 * itself.
 */
export type ManagedComboBuildResult =
  | {
      kind: "NO_SAFE_ROUTE";
      logicalId: string;
      activationRequiredCount: number;
      blockedCount: number;
    }
  | {
      kind: "ACTIVATION_REQUIRED";
      logicalId: string;
      pendingCandidates: ManagedComboMember[];
      activationRequiredCount: number;
      blockedCount: number;
    }
  | {
      kind: "DESIRED";
      logicalId: string;
      activationRequiredCount: number;
      blockedCount: number;
      state: ManagedComboDesiredState;
    };

export interface BuildManagedComboDesiredStateInput {
  logicalId: string;
  name: string;
  safeSet: JarvisSafeCandidateSet;
  recommendation: StrategyRecommendation;
  policyMode: string;
  /**
   * Members the caller last knew to be part of this managed Combo (from the
   * previous desired state, or the current live Combo) — required only to
   * apply the transient-suppression rule in §12; omit or pass `[]` for a
   * first-ever build.
   */
  previousMembers?: readonly ManagedComboMember[];
}

function candidatePool(safeSet: JarvisSafeCandidateSet, poolKind: "general" | "strictZeroCost") {
  const entries = poolKind === "strictZeroCost" ? safeSet.strictZeroCost : safeSet.general;
  return entries;
}

function countByActivation(entries: readonly SafeCandidateEntry[]) {
  let routable = 0;
  let pending = 0;
  for (const entry of entries) {
    if (entry.activation === "routable") routable++;
    else pending++;
  }
  return { routable, pending };
}

/**
 * Pure builder. Deterministic: identical `safeSet`/`recommendation`/
 * `previousMembers` always produce an identical result (A7 §10) — no random
 * ids, no wall-clock reads inside the fingerprint (the caller may stamp
 * `lastAppliedAt` separately, at actual apply time, which A7 never does).
 */
export function buildManagedComboDesiredState(
  input: BuildManagedComboDesiredStateInput
): ManagedComboBuildResult {
  const { logicalId, name, safeSet, recommendation, policyMode } = input;
  const poolKind: "general" | "strictZeroCost" =
    policyMode === "strict_zero_cost" ? "strictZeroCost" : "general";
  const entries = candidatePool(safeSet, poolKind);
  const { routable, pending } = countByActivation(entries);
  const blockedCount = safeSet.dispositionByKey.size - entries.length;

  // §13: an activation-required candidate is NEVER silently injected. When
  // there is nothing routable at all AND something is only pending
  // activation, surface that distinctly rather than a bare NO_SAFE_ROUTE —
  // the actionable next step differs (approve activation vs. nothing safe
  // exists at all).
  if (routable === 0) {
    if (pending > 0) {
      const pendingCandidates = entries
        .filter((e) => e.activation === "pendingActivation")
        .map(toManagedComboMember);
      return {
        kind: "ACTIVATION_REQUIRED",
        logicalId,
        pendingCandidates,
        activationRequiredCount: pending,
        blockedCount,
      };
    }
    return { kind: "NO_SAFE_ROUTE", logicalId, activationRequiredCount: 0, blockedCount };
  }

  if (!recommendation.strategy) {
    // Structurally unreachable when routable > 0 (A6 never returns
    // strategy:null for a non-empty safe pool) — fail closed defensively
    // rather than silently defaulting to a guessed strategy.
    return { kind: "NO_SAFE_ROUTE", logicalId, activationRequiredCount: pending, blockedCount };
  }

  const routableEntries = entries.filter((e) => e.activation === "routable");
  const currentMembers = routableEntries.map(toManagedComboMember);
  const currentKeys = new Set(currentMembers.map(memberKey));

  // §12: a previous member no longer in the live routable set is either
  // genuinely gone (persistent — drop it) or only transiently suppressed
  // (keep it, native pre-dispatch gating already protects the route).
  const previousMembers = input.previousMembers ?? [];
  const transientlySuppressed: ManagedComboMember[] = [];
  for (const previous of previousMembers) {
    const key = memberKey(previous);
    if (currentKeys.has(key)) continue; // still routable — not a removal case at all
    const disposition = safeSet.dispositionByKey.get(key);
    const reason = disposition?.kind === "JARVIS_REJECTED" ? disposition.reason : null;
    if (reason && TRANSIENT_REJECTION_REASONS.has(reason)) {
      transientlySuppressed.push(previous);
    }
    // else: persistent removal — simply omitted from `members` (no action needed here).
  }

  const members = [...currentMembers, ...transientlySuppressed].sort((a, b) =>
    memberKey(a).localeCompare(memberKey(b))
  );

  const config: Record<string, unknown> =
    recommendation.strategy === "auto"
      ? { candidatePool: [...new Set(members.map((m) => m.providerId))].sort() }
      : {};

  const evidenceFingerprint = computeEvidenceFingerprint({
    members,
    strategy: recommendation.strategy,
    policyMode,
    config,
  });

  return {
    kind: "DESIRED",
    logicalId,
    activationRequiredCount: pending,
    blockedCount,
    state: {
      logicalId,
      name,
      strategy: recommendation.strategy,
      poolKind,
      policyMode,
      members,
      config,
      transientlySuppressed,
      evidenceFingerprint,
      activationRequiredCount: pending,
      blockedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence fingerprint (A7 §16) — deterministic, no secrets
// ---------------------------------------------------------------------------

/**
 * A stable, order-independent fingerprint over the safety-relevant fields.
 * Same inputs, in any member order, produce the same fingerprint — sorting
 * happens here so a caller never needs to pre-sort. No prompt content, no
 * credential, no upstream response body enters this computation.
 */
export function computeEvidenceFingerprint(input: {
  members: readonly ManagedComboMember[];
  strategy: string;
  policyMode: string;
  config: Record<string, unknown>;
}): string {
  const sortedMembers = [...input.members]
    .map((m) => `${m.providerId}::${m.connectionId}::${m.routeId}`)
    .sort();
  const canonical = JSON.stringify({
    v: MANAGED_COMBO_SCHEMA_VERSION,
    members: sortedMembers,
    strategy: input.strategy,
    policyMode: input.policyMode,
    config: input.config,
  });
  return simpleStableHash(canonical);
}

/**
 * A small, dependency-free, deterministic string hash (FNV-1a, 32-bit,
 * hex-encoded). Not cryptographic — this fingerprint is a change-detector
 * and audit trail, never a security boundary, so `node:crypto` would be
 * unnecessary weight for the same guarantee.
 */
function simpleStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
