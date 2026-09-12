/**
 * Shadow Control-Plane Read Adapter (O9-F3.5 A7.1 "R0").
 *
 * Jarvis does not need to execute inside OmniRoute. This module is the
 * boundary: it consumes OmniRoute's own already-deployed, authenticated,
 * read-only management HTTP surface (`GET /api/providers`, `GET
 * /api/combos`) and maps the response into the exact structured inputs the
 * local, pure O9 decision pipeline (A2 `resolveProviderObservations` -> A3
 * `resolveActivationGate` -> A4 `candidateFromResolvedObservation` -> A5
 * `buildSafeCandidateSet` -> A6 `recommendStrategy` -> A7
 * `buildManagedComboDesiredState` / `planReconciliation`) already expects.
 *
 * Jarvis owns intent (this pipeline). OmniRoute owns execution (its own
 * Combo API/service path) — this module never writes anything; it only
 * reads and computes a value.
 *
 * Deliberately excluded as data sources, per the O9-F3.5 hard constraints:
 *   - `GET /api/providers/[id]/models` (live catalog discovery / autoFetch /
 *     "/models import") — calling it can trigger a real outbound provider
 *     request and is explicitly forbidden.
 *   - `GET /api/synced-available-models` — a genuinely read-only endpoint
 *     that would otherwise be the right source for "which models does this
 *     connection already have", but it does not currently authenticate with
 *     a `manage`-scope key against the deployed Shadow image (observed: a
 *     401 "Authentication required" where `/api/providers` and
 *     `/api/combos` both succeed with the identical credential) — a real,
 *     reported API gap, not something this module works around.
 *
 * Consequence: with no safe, working read source for "what models has this
 * connection's catalog reported", every connection's `ProviderObservationInventory`
 * defaults to genuinely empty (never fabricated) unless a caller explicitly
 * supplies one (tests do, to prove the full A2-A7 chain; a real, future,
 * approved data source would too). An empty inventory is not a shortcut —
 * it is what A2 has always meant by "never observed", and it correctly,
 * honestly cascades to `NO_SAFE_ROUTE` through A3-A7 exactly as designed.
 */
import type { BillableConnection } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";

import { emptyInventory } from "../providerOnboarding/catalog";
import {
  resolveActivationGate,
  type ActivationApprovalRecord,
  type ActivationDecisionSummary,
  type ActivationPolicyMode,
} from "../providerOnboarding/activationPolicy";
import {
  resolveProviderObservations,
  type ProviderObservationSummary,
} from "../providerOnboarding/onboarding";
import type { ProviderObservationInventory } from "../providerOnboarding/types";
import { candidateFromResolvedObservation } from "./failoverA3Adapter";
import type { FailoverCandidate } from "./failoverDecision";
import { buildSafeCandidateSet } from "./jarvisSafeCandidateSet";
import {
  recommendStrategy,
  type CandidateStrategy,
  type QuotaPressureFacts,
  type RequestClassFacts,
  type StrategyConfidence,
  type StrategyReasonCode,
  type StrategyTelemetryFacts,
} from "./strategyPolicyEngine";
import {
  MANAGED_COMBO_LOGICAL_ID_PREFIX,
  MANAGED_COMBO_SCHEMA_VERSION,
  buildManagedComboDesiredState,
  buildManagedComboLogicalId,
  computeEvidenceFingerprint,
  isManagedComboLogicalId,
  type ManagedComboBuildResult,
  type ManagedComboMember,
} from "./managedComboDesiredState";
import {
  planReconciliation,
  type CurrentComboOwnershipRecord,
  type CurrentComboState,
  type ReconciliationPlan,
} from "./managedComboReconciliation";

// ---------------------------------------------------------------------------
// HTTP client — injectable, secret-safe
// ---------------------------------------------------------------------------

/** Production's dashboard/management port. Never a valid Shadow adapter target. */
const FORBIDDEN_MANAGEMENT_PORTS: ReadonlySet<string> = new Set(["20128"]);

/**
 * Defense-in-depth: refuse to target Production's own management port even
 * if a caller passes the wrong `baseUrl` by mistake. Shadow and Production
 * never share a database (proven structurally in the A7.1 auth audit), so
 * this cannot authenticate against Production either way — this check only
 * makes the mistake fail loudly instead of silently querying the wrong
 * instance's read surface.
 */
export function assertShadowManagementBaseUrl(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  if (FORBIDDEN_MANAGEMENT_PORTS.has(parsed.port)) {
    throw new Error("shadowControlPlaneAdapter: refusing to target the Production management port");
  }
}

export interface ShadowClientDeps {
  baseUrl: string;
  /** Injectable fetch — tests never touch the real network. */
  fetchImpl: typeof fetch;
  /**
   * Reads the Bearer token at call time. Never store the returned value on
   * any object this module returns; every error path below uses a fixed,
   * secret-free message string instead of anything derived from the token,
   * the request, or a caught error's own `.message`.
   */
  getAuthToken: () => string;
}

export type ShadowReadResult<T> =
  { ok: true; data: T } | { ok: false; status: number | null; error: string };

async function fetchShadowJson<T>(
  deps: ShadowClientDeps,
  path: string
): Promise<ShadowReadResult<T>> {
  assertShadowManagementBaseUrl(deps.baseUrl);

  let response: Response;
  try {
    response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.getAuthToken()}` },
    });
  } catch {
    // Never surface the caught error's own message — it can echo the
    // request (URL, occasionally headers) depending on the fetch
    // implementation. A fixed label is all any caller needs.
    return { ok: false, status: null, error: "network_error" };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: `http_${response.status}` };
  }

  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: response.status, error: "invalid_json" };
  }
}

// ---------------------------------------------------------------------------
// Live connection snapshot
// ---------------------------------------------------------------------------

/** The minimal, safe subset of `GET /api/providers`'s connection shape this pipeline needs. */
export interface ShadowConnectionSnapshot {
  connectionId: string;
  provider: string;
  authType: string | null;
  /** Missing/non-boolean on the wire fails closed to `false` — never assumed active. */
  isActive: boolean;
  testStatus: string | null;
  providerSpecificData: unknown;
}

function mapRawConnection(raw: unknown): ShadowConnectionSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim() === "") return null;
  if (typeof r.provider !== "string" || r.provider.trim() === "") return null;
  return {
    connectionId: r.id,
    provider: r.provider,
    authType: typeof r.authType === "string" ? r.authType : null,
    isActive: r.isActive === true,
    testStatus: typeof r.testStatus === "string" ? r.testStatus : null,
    providerSpecificData: r.providerSpecificData ?? null,
  };
}

export async function fetchShadowProviderConnections(
  deps: ShadowClientDeps
): Promise<ShadowReadResult<ShadowConnectionSnapshot[]>> {
  const result = await fetchShadowJson<{ connections?: unknown }>(deps, "/api/providers");
  // Reconstruct the failure branch explicitly rather than returning `result`
  // directly: TS does not treat `ShadowReadResult<A>`'s `{ ok: false }` member
  // as structurally assignable to `ShadowReadResult<B>`'s across a different
  // generic instantiation, even though the runtime shape is identical.
  if (result.ok === false) return { ok: false, status: result.status, error: result.error };
  const raw =
    result.data && Array.isArray(result.data.connections) ? result.data.connections : null;
  if (!raw) return { ok: false, status: null, error: "malformed_response" };
  const connections: ShadowConnectionSnapshot[] = [];
  for (const item of raw) {
    const mapped = mapRawConnection(item);
    // A malformed single connection entry is skipped, not fabricated and not
    // treated as a whole-snapshot failure — one bad row on a 5-connection
    // response must not hide the other 4 real, well-formed ones.
    if (mapped) connections.push(mapped);
  }
  return { ok: true, data: connections };
}

// ---------------------------------------------------------------------------
// Live combo snapshot
// ---------------------------------------------------------------------------

/** The minimal, safe subset of `GET /api/combos`'s combo shape this pipeline needs. */
export interface ShadowComboSnapshot {
  id: string;
  name: string;
  strategy: string;
  models: unknown[];
  config: Record<string, unknown> | null;
}

function mapRawCombo(raw: unknown): ShadowComboSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim() === "") return null;
  if (typeof r.name !== "string" || r.name.trim() === "") return null;
  return {
    id: r.id,
    name: r.name,
    strategy: typeof r.strategy === "string" ? r.strategy : "unknown",
    models: Array.isArray(r.models) ? r.models : [],
    config:
      r.config && typeof r.config === "object" && !Array.isArray(r.config)
        ? (r.config as Record<string, unknown>)
        : null,
  };
}

export async function fetchShadowCombos(
  deps: ShadowClientDeps
): Promise<ShadowReadResult<ShadowComboSnapshot[]>> {
  const result = await fetchShadowJson<{ combos?: unknown }>(deps, "/api/combos");
  if (result.ok === false) return { ok: false, status: result.status, error: result.error };
  const raw = result.data && Array.isArray(result.data.combos) ? result.data.combos : null;
  if (!raw) return { ok: false, status: null, error: "malformed_response" };
  const combos: ShadowComboSnapshot[] = [];
  for (const item of raw) {
    const mapped = mapRawCombo(item);
    if (mapped) combos.push(mapped);
  }
  return { ok: true, data: combos };
}

// ---------------------------------------------------------------------------
// Combined live snapshot — fails closed as a whole on ANY partial failure
// ---------------------------------------------------------------------------

export interface LiveShadowSnapshot {
  fetchedAtMs: number;
  connections: readonly ShadowConnectionSnapshot[];
  combos: readonly ShadowComboSnapshot[];
}

export type LiveShadowSnapshotResult =
  | { ok: true; snapshot: LiveShadowSnapshot }
  | { ok: false; error: string; failedCalls: readonly string[] };

/**
 * Both reads must succeed for the snapshot to be usable at all — a
 * "connections OK, combos failed" partial result is never silently treated
 * as "zero combos"; that would make every desired-state build look like a
 * safe CREATE against a real ownership landscape it never actually saw.
 */
export async function fetchLiveShadowSnapshot(
  deps: ShadowClientDeps,
  now: number
): Promise<LiveShadowSnapshotResult> {
  const [connectionsResult, combosResult] = await Promise.all([
    fetchShadowProviderConnections(deps),
    fetchShadowCombos(deps),
  ]);

  const failedCalls: string[] = [];
  if (connectionsResult.ok === false) failedCalls.push(`providers:${connectionsResult.error}`);
  if (combosResult.ok === false) failedCalls.push(`combos:${combosResult.error}`);
  if (connectionsResult.ok === false || combosResult.ok === false) {
    return { ok: false, error: "snapshot_incomplete", failedCalls };
  }

  return {
    ok: true,
    snapshot: {
      fetchedAtMs: now,
      connections: connectionsResult.data,
      combos: combosResult.data,
    },
  };
}

// ---------------------------------------------------------------------------
// logicalId <-> physical Combo name (A7.1 §11 — comboNameSchema forbids ":")
// ---------------------------------------------------------------------------

const COMBO_NAME_SAFE_CHARS = /^[a-zA-Z0-9_/.\-[\] ]+$/;
const PHYSICAL_NAME_PREFIX = "jarvis-managed/";

/**
 * OmniRoute's `comboNameSchema` (`src/shared/validation/schemas/combo.ts`)
 * forbids `:` — A7's own `MANAGED_COMBO_LOGICAL_ID_PREFIX` ("jarvis-managed:")
 * cannot be used verbatim as a real Combo `name`. This is the one place that
 * translates between the two: injective (the `purpose` suffix is carried
 * through unchanged, only the fixed prefix's separator changes), so distinct
 * logical ids can never collide onto the same physical name, and the
 * mapping round-trips exactly via `physicalNameToManagedComboLogicalId`.
 */
export function managedComboPhysicalName(logicalId: string): string {
  if (!isManagedComboLogicalId(logicalId)) {
    throw new Error("managedComboPhysicalName: not a jarvis-managed logical id");
  }
  const purpose = logicalId.slice(MANAGED_COMBO_LOGICAL_ID_PREFIX.length);
  const physicalName = `${PHYSICAL_NAME_PREFIX}${purpose}`;
  if (!COMBO_NAME_SAFE_CHARS.test(physicalName)) {
    throw new Error(
      `managedComboPhysicalName: purpose "${purpose}" contains characters OmniRoute's combo name schema forbids`
    );
  }
  return physicalName;
}

export function physicalNameToManagedComboLogicalId(physicalName: string): string | null {
  if (!physicalName.startsWith(PHYSICAL_NAME_PREFIX)) return null;
  return `${MANAGED_COMBO_LOGICAL_ID_PREFIX}${physicalName.slice(PHYSICAL_NAME_PREFIX.length)}`;
}

// ---------------------------------------------------------------------------
// Conservative live ProviderRuntimeState projection
// ---------------------------------------------------------------------------

/**
 * NOT the real `ProviderRuntimeState` aggregation
 * (`open-sse/services/providerRuntimeState.ts`) — that computation lives
 * inside OmniRoute's own process and is not exposed by any read-only
 * endpoint today. This is a deliberately conservative, fail-closed
 * placeholder: every field this module cannot honestly derive from
 * `GET /api/providers`'s own response stays `null`/`"unknown"`, never
 * guessed. Being over-conservative here can only make a candidate MORE
 * likely to be rejected downstream, never less — consistent with every
 * other fail-closed boundary in this pipeline.
 */
export function conservativeRuntimeStateFromConnection(
  connection: ShadowConnectionSnapshot,
  computedAtMs: number
): ProviderRuntimeState {
  return {
    providerId: connection.provider,
    connectionId: connection.connectionId,
    providerHealth: "unknown",
    accountState: connection.isActive ? "unknown" : "disabled",
    quotaState: "unknown",
    quotaScope: "unknown",
    cooldownUntil: null,
    quotaResetAt: null,
    costClass: "unknown",
    capabilities: {
      executable: null,
      fastEligible: null,
      codingEligible: null,
      genericToolEligible: null,
      claudeCodeEligible: null,
      supervisorEligible: null,
    },
    lastSuccessAt: null,
    lastFailureAt: null,
    failureReason: null,
    latency: { medianMs: null, p95Ms: null },
    computedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Current live Combo -> CurrentComboState (for reconciliation)
// ---------------------------------------------------------------------------

function parseJarvisManagedOwnership(raw: unknown): CurrentComboOwnershipRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== MANAGED_COMBO_SCHEMA_VERSION) return null;
  if (typeof r.logicalId !== "string" || r.logicalId.trim() === "") return null;
  if (typeof r.lastAppliedFingerprint !== "string") return null;
  if (typeof r.lastAppliedAt !== "string") return null;
  return {
    logicalId: r.logicalId,
    lastAppliedFingerprint: r.lastAppliedFingerprint,
    lastAppliedAt: r.lastAppliedAt,
  };
}

/**
 * `connectionId` is required on `ManagedComboMember` but a native combo step
 * OmniRoute itself wrote may omit it (provider-wide fallback, not pinned to
 * one connection). This sentinel is only ever load-bearing for a combo this
 * module does NOT own — `planReconciliation` blocks (`foreign`/`drifted`)
 * before it ever diffs a foreign combo's `members` against desired state, so
 * the sentinel never participates in an actual reconciliation decision. A
 * combo Jarvis itself applies always carries an explicit `connectionId` on
 * every member (A7's own `ManagedComboMember` requires it), so this path
 * never fires for a genuinely Jarvis-owned combo.
 */
const UNSPECIFIED_CONNECTION_SENTINEL = "unspecified-connection";

export function mapComboToCurrentComboState(combo: ShadowComboSnapshot): CurrentComboState {
  const members: ManagedComboMember[] = [];
  for (const rawStep of combo.models) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    if (step.kind !== undefined && step.kind !== "model") continue;
    if (typeof step.model !== "string" || step.model.trim() === "") continue;
    if (typeof step.providerId !== "string" || step.providerId.trim() === "") continue;
    members.push({
      routeId: `${step.providerId}/${step.model}`,
      providerId: step.providerId,
      connectionId:
        typeof step.connectionId === "string" && step.connectionId.trim() !== ""
          ? step.connectionId
          : UNSPECIFIED_CONNECTION_SENTINEL,
      model: step.model,
    });
  }

  const jarvisManagedRaw = combo.config ? combo.config.jarvisManaged : undefined;
  const ownership = parseJarvisManagedOwnership(jarvisManagedRaw);

  // The `policyMode` a future apply step should persist alongside
  // `ManagedComboOwnership` so fingerprint recomputation on read-back is
  // exact; A7's `ManagedComboOwnership` type does not carry it today. Until
  // that is added, a fingerprint recomputed here for an already-owned combo
  // uses `"unknown"` when absent — deliberately never matching a real
  // desired-state fingerprint, so a stale/incomplete ownership record reads
  // as `drifted` (fail closed) rather than silently as `jarvis-owned`.
  const persistedPolicyMode =
    jarvisManagedRaw &&
    typeof jarvisManagedRaw === "object" &&
    typeof (jarvisManagedRaw as Record<string, unknown>).policyMode === "string"
      ? ((jarvisManagedRaw as Record<string, unknown>).policyMode as string)
      : "unknown";

  const actualFingerprint = computeEvidenceFingerprint({
    members,
    strategy: combo.strategy,
    policyMode: persistedPolicyMode,
    config: combo.config ?? {},
  });

  return {
    comboId: combo.id,
    name: combo.name,
    strategy: combo.strategy,
    members,
    actualFingerprint,
    ownership,
  };
}

// ---------------------------------------------------------------------------
// The pipeline runner — pure, no I/O, reproducible from a second read
// ---------------------------------------------------------------------------

export interface ShadowConnectionPipelineResult {
  connectionId: string;
  providerId: string;
  isActive: boolean;
  observationSummary: ProviderObservationSummary;
  activationSummary: ActivationDecisionSummary;
  candidatesBuilt: number;
}

export interface PipelineSummary {
  policyMode: ActivationPolicyMode;
  connections: readonly ShadowConnectionPipelineResult[];
  totalCandidates: number;
  safeCandidateCount: { general: number; strictZeroCost: number };
  strategy: CandidateStrategy | null;
  strategyConfidence: StrategyConfidence;
  strategyReasons: readonly StrategyReasonCode[];
}

export interface ShadowManagedComboArtifact {
  liveSnapshot: {
    fetchedAt: string;
    connectionCount: number;
    comboCount: number;
    comboNames: readonly string[];
  };
  pipelineSummary: PipelineSummary;
  desiredState: ManagedComboBuildResult;
  reconciliationPlan: ReconciliationPlan;
}

export interface RunShadowManagedComboPipelineInput {
  connections: readonly ShadowConnectionSnapshot[];
  combos: readonly ShadowComboSnapshot[];
  /** Short, stable slug — becomes both the logical id and (translated) the physical Combo name. */
  purpose: string;
  policyMode: ActivationPolicyMode;
  requestClass: RequestClassFacts;
  telemetry: StrategyTelemetryFacts;
  quota: QuotaPressureFacts;
  now: number;
  /** Per-connection observation inventory; absent = honestly never observed (A2's own default). */
  observationInventoryByConnection?: ReadonlyMap<string, ProviderObservationInventory>;
  resolveApproval?: (canonicalModelId: string) => ActivationApprovalRecord | null | undefined;
  /** Per-connection runtime-state override (tests only); live callers get the conservative projection. */
  runtimeStateByConnection?: ReadonlyMap<string, ProviderRuntimeState>;
  /**
   * Ground truth for "is this model already in the live synced/custom-models
   * pool" — R0 has no safe read source for this yet (documented at the top
   * of this file), so the live default is always `false`; tests inject a
   * resolver to prove the `ALREADY_ROUTABLE` path.
   */
  alreadyRoutableResolver?: (canonicalModelId: string) => boolean;
}

export function runShadowManagedComboPipeline(
  input: RunShadowManagedComboPipelineInput
): ShadowManagedComboArtifact {
  const logicalId = buildManagedComboLogicalId(input.purpose);
  const physicalName = managedComboPhysicalName(logicalId);
  const alreadyRoutable = input.alreadyRoutableResolver ?? (() => false);

  const connectionResults: ShadowConnectionPipelineResult[] = [];
  const candidates: FailoverCandidate[] = [];

  for (const connection of input.connections) {
    const billable: BillableConnection & { isActive: boolean } = {
      provider: connection.provider,
      authType: connection.authType,
      connectionId: connection.connectionId,
      providerSpecificData: connection.providerSpecificData,
      isActive: connection.isActive,
    };

    const inventory =
      input.observationInventoryByConnection?.get(connection.connectionId) ??
      emptyInventory(connection.provider, connection.connectionId, "shadow-control-plane-adapter");

    const resolution = resolveProviderObservations({ inventory, connection: billable });

    const gate = resolveActivationGate({
      provider: connection.provider,
      connectionId: connection.connectionId,
      resolved: resolution.models,
      connectionActive: connection.isActive,
      policyMode: input.policyMode,
      resolveApproval: input.resolveApproval,
    });

    const runtimeState =
      input.runtimeStateByConnection?.get(connection.connectionId) ??
      conservativeRuntimeStateFromConnection(connection, input.now);

    let candidatesBuilt = 0;
    for (let i = 0; i < resolution.models.length; i++) {
      const resolved = resolution.models[i];
      // A model no longer listed by the last refresh is observation
      // history, not a live routing candidate — never built into a
      // FailoverCandidate.
      if (!resolved.record.currentlyObserved) continue;
      const activation = gate.decisions[i];
      candidates.push(
        candidateFromResolvedObservation({
          providerId: connection.provider,
          connectionId: connection.connectionId,
          resolved,
          runtimeState,
          activation,
          connectionActive: connection.isActive,
          alreadyRoutable: alreadyRoutable(resolved.record.canonicalModelId),
        })
      );
      candidatesBuilt++;
    }

    connectionResults.push({
      connectionId: connection.connectionId,
      providerId: connection.provider,
      isActive: connection.isActive,
      observationSummary: resolution.summary,
      activationSummary: gate.summary,
      candidatesBuilt,
    });
  }

  const safeSet = buildSafeCandidateSet(candidates, { now: input.now });
  const poolKind = input.policyMode === "strict_zero_cost" ? "strictZeroCost" : "general";
  const recommendation = recommendStrategy({
    safeSet,
    poolKind,
    requestClass: input.requestClass,
    telemetry: input.telemetry,
    quota: input.quota,
  });

  const desired = buildManagedComboDesiredState({
    logicalId,
    name: physicalName,
    safeSet,
    recommendation,
    policyMode: input.policyMode,
  });

  const currentRaw = input.combos.find((combo) => combo.name === physicalName) ?? null;
  const current = currentRaw ? mapComboToCurrentComboState(currentRaw) : null;
  const reconciliationPlan = planReconciliation({ desired, current });

  return {
    liveSnapshot: {
      fetchedAt: new Date(input.now).toISOString(),
      connectionCount: input.connections.length,
      comboCount: input.combos.length,
      comboNames: input.combos.map((combo) => combo.name),
    },
    pipelineSummary: {
      policyMode: input.policyMode,
      connections: connectionResults,
      totalCandidates: candidates.length,
      safeCandidateCount: {
        general: safeSet.general.length,
        strictZeroCost: safeSet.strictZeroCost.length,
      },
      strategy: recommendation.strategy,
      strategyConfidence: recommendation.confidence,
      strategyReasons: recommendation.reasons,
    },
    desiredState: desired,
    reconciliationPlan,
  };
}
