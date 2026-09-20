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
 *     that would otherwise be a candidate source, but it does not currently
 *     authenticate with a `manage`-scope key against the deployed Shadow
 *     image (observed: a 401 "Authentication required" where `/api/providers`
 *     and `/api/combos` both succeed with the identical credential — a real
 *     API gap, not something this module works around), and even where its
 *     auth does pass it unions models across a provider's connections
 *     instead of exposing them per connection.
 *
 * O9-F3.5 A7.1 "R1" added `GET /api/providers/observed-models`
 * (`src/app/api/providers/observed-models/route.ts`) as the safe,
 * connection-scoped read source this file was missing: `requireManagementAuth`
 * (proven, live, against the deployed Shadow image — same guard as
 * `/api/providers`/`/api/combos`), pure reads only (`getRawProviderConnections`
 * projected to id/provider, `getSyncedAvailableModelsByConnection`), no
 * upstream provider call, no writes. `fetchShadowObservedModels` /
 * `buildObservationInventoryFromShadowObservedModels` below consume it.
 *
 * The currently *running* Shadow container image predates this endpoint
 * (R1 does not rebuild/redeploy Shadow — see the R1 mission constraints), so
 * this has been proven only against fakes so far; the live A2-A7 proof is
 * BLOCKED_PENDING_DEPLOYMENT until a Shadow image containing this route is
 * running. Until then, a caller that does not explicitly supply
 * `observationInventoryByConnection` still gets a genuinely empty inventory
 * per connection (never fabricated) — the same honest `NO_SAFE_ROUTE`
 * cascade through A3-A7 as before R1.
 */
import type { BillableConnection } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";
import { AUTO_COMBO_NOAUTH_ALLOWLIST } from "@omniroute/open-sse/services/autoCombo/noAuthAutoPolicy.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "@omniroute/open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { filterSupportedParametersForRoute } from "@/lib/db/paramFilters";

import { applyObservationRefresh, emptyInventory } from "../providerOnboarding/catalog";
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
import {
  compatibilityConnectionProbeBackoffUntil,
  compatibilityEvidenceFresh,
  type ProviderModelCompatibilityInventory,
} from "../providerOnboarding/compatibility";
import {
  compatibilityProbePriority,
  isToolRoundTripProbePlausible,
  isZeroCostSafeForCompatibilityProbe,
} from "../providerOnboarding/evidence";
import { runtimeAllowsCompatibilityProbe } from "../providerOnboarding/compatibilityProbeRuntimeGate";
import {
  orderSafeCandidatesWithProviderDiversity,
  scoreManagedFreeCandidate,
} from "./managedFreeCandidateRanking";
import { deriveManagedFreeLifecycle, type ManagedFreeLifecycleState } from "./managedFreeLifecycle";
import { candidateFromResolvedObservation } from "./failoverA3Adapter";
import type { FailoverCandidate } from "./failoverDecision";
import { buildSafeCandidateSet, type CandidateDisposition } from "./jarvisSafeCandidateSet";
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
  isHidden?: boolean;
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
    isHidden: r.isHidden === true,
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
// Live observed-models snapshot (R1) — connection-scoped synced catalog
// ---------------------------------------------------------------------------

/** One connection's currently-persisted synced model rows. Raw model entries
 * are intentionally left as `unknown` here — A2's own `normalizeObservedModels`
 * (via `applyObservationRefresh` below) already tolerates and fails closed on
 * malformed individual entries; duplicating that validation here would only
 * risk drifting out of sync with it. */
export interface ShadowObservedModelsConnection {
  connectionId: string;
  models: readonly unknown[];
}

export interface ShadowObservedModelsProvider {
  providerId: string;
  connections: readonly ShadowObservedModelsConnection[];
}

export interface ShadowObservedModelsSnapshot {
  providers: readonly ShadowObservedModelsProvider[];
}

function mapRawObservedModelsConnection(raw: unknown): ShadowObservedModelsConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.connectionId !== "string" || r.connectionId.trim() === "") return null;
  if (!Array.isArray(r.models)) return null;
  return { connectionId: r.connectionId, models: r.models };
}

function mapRawObservedModelsProvider(raw: unknown): ShadowObservedModelsProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.providerId !== "string" || r.providerId.trim() === "") return null;
  if (!Array.isArray(r.connections)) return null;
  const connections: ShadowObservedModelsConnection[] = [];
  for (const item of r.connections) {
    const mapped = mapRawObservedModelsConnection(item);
    // One malformed connection row must not hide the provider's other,
    // well-formed connections — same "skip, don't fail the batch" rule as
    // `fetchShadowProviderConnections`/`fetchShadowCombos` above.
    if (mapped) connections.push(mapped);
  }
  return { providerId: r.providerId, connections };
}

export async function fetchShadowObservedModels(
  deps: ShadowClientDeps
): Promise<ShadowReadResult<ShadowObservedModelsSnapshot>> {
  const result = await fetchShadowJson<{ providers?: unknown }>(
    deps,
    "/api/providers/observed-models"
  );
  if (result.ok === false) return { ok: false, status: result.status, error: result.error };
  const raw = result.data && Array.isArray(result.data.providers) ? result.data.providers : null;
  if (!raw) return { ok: false, status: null, error: "malformed_response" };
  const providers: ShadowObservedModelsProvider[] = [];
  for (const item of raw) {
    const mapped = mapRawObservedModelsProvider(item);
    if (mapped) providers.push(mapped);
  }
  return { ok: true, data: { providers } };
}

/** Distinct from `/api/providers` and `/api/combos`'s own read paths — this is
 * A2's own refresh-source label, never confused with a live `/models` probe. */
const SHADOW_OBSERVED_MODELS_SOURCE = "shadow-observed-models-endpoint";

/**
 * Pure transform: turns one `ShadowObservedModelsSnapshot` read into the
 * per-connection `ProviderObservationInventory` map `runShadowManagedComboPipeline`
 * accepts as `observationInventoryByConnection`. A connection absent from the
 * snapshot is simply absent from this map — the pipeline runner already
 * defaults an absent connection to `emptyInventory` (genuinely "never
 * observed"), so this function never needs to fabricate one itself.
 */
export function buildObservationInventoryFromShadowObservedModels(
  snapshot: ShadowObservedModelsSnapshot,
  nowMs: number
): ReadonlyMap<string, ProviderObservationInventory> {
  const observedAt = new Date(nowMs).toISOString();
  const byConnection = new Map<string, ProviderObservationInventory>();
  for (const provider of snapshot.providers) {
    for (const connection of provider.connections) {
      // A connectionId repeated under a second provider row would be a
      // malformed/ambiguous response — first-seen wins, never merged or
      // overwritten across providers.
      if (byConnection.has(connection.connectionId)) continue;
      byConnection.set(
        connection.connectionId,
        applyObservationRefresh(null, {
          providerId: provider.providerId,
          connectionId: connection.connectionId,
          source: SHADOW_OBSERVED_MODELS_SOURCE,
          observedAt,
          outcome: { ok: true, items: connection.models },
        })
      );
    }
  }
  return byConnection;
}

// ---------------------------------------------------------------------------
// Live passive discovery snapshot (R2) — outbound provider catalog requests
// ---------------------------------------------------------------------------

/**
 * O9-F3.5 A7.1 "R2" — passive provider model discovery. Unlike
 * `fetchShadowObservedModels` (R1, a pure local read), calling
 * `POST /api/provider-observations/passive-model-discovery` makes Shadow
 * itself perform a real outbound provider model-CATALOG request (never
 * inference) using that connection's own stored credential. This adapter
 * never receives or forwards that credential — only
 * `providerId`/`connectionId`/`status`/raw `models` cross the boundary. See
 * `src/app/api/provider-observations/passive-model-discovery/
 * passiveModelDiscovery.ts` for the server-side write/inference exclusions.
 *
 * Route namespace (R2.2): this was `POST /api/providers/passive-model-
 * discovery` in R2/R2.1, but `/api/providers/*` classifies every mutating
 * verb as `admin` (`ADMIN_MUTATION_PREFIXES`), so the live R2.1 proof against
 * Shadow got a `403 AUTH_SCOPE` before the handler ever ran — Jarvis's
 * management credential is deliberately not `admin`. `/api/provider-
 * observations/*` sits outside that prefix, so this POST needs only the
 * default mutation scope (`write` for a CLI access token). The old path is
 * no longer served.
 */
export type ShadowPassiveDiscoveryStatus =
  | "OK"
  | "UNSUPPORTED"
  | "INACTIVE"
  | "NO_CREDENTIAL"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "MALFORMED_RESPONSE";

export interface ShadowPassiveDiscoveryConnectionResult {
  providerId: string;
  connectionId: string;
  status: ShadowPassiveDiscoveryStatus;
  models: readonly unknown[];
}

export interface ShadowPassiveDiscoverySnapshot {
  fetchedAt: string;
  connections: readonly ShadowPassiveDiscoveryConnectionResult[];
}

function mapRawPassiveDiscoveryConnection(
  raw: unknown
): ShadowPassiveDiscoveryConnectionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.providerId !== "string" || r.providerId.trim() === "") return null;
  if (typeof r.connectionId !== "string" || r.connectionId.trim() === "") return null;
  if (typeof r.status !== "string") return null;
  return {
    providerId: r.providerId,
    connectionId: r.connectionId,
    status: r.status as ShadowPassiveDiscoveryStatus,
    models: Array.isArray(r.models) ? r.models : [],
  };
}

export async function fetchShadowPassiveDiscovery(
  deps: ShadowClientDeps,
  connectionIds?: readonly string[]
): Promise<ShadowReadResult<ShadowPassiveDiscoverySnapshot>> {
  assertShadowManagementBaseUrl(deps.baseUrl);
  let response: Response;
  try {
    response = await deps.fetchImpl(
      `${deps.baseUrl}/api/provider-observations/passive-model-discovery`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.getAuthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(connectionIds && connectionIds.length > 0 ? { connectionIds } : {}),
      }
    );
  } catch {
    return { ok: false, status: null, error: "network_error" };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: `http_${response.status}` };
  }
  let data: { fetchedAt?: unknown; connections?: unknown };
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: response.status, error: "invalid_json" };
  }
  if (typeof data.fetchedAt !== "string" || !Array.isArray(data.connections)) {
    return { ok: false, status: null, error: "malformed_response" };
  }
  const connections: ShadowPassiveDiscoveryConnectionResult[] = [];
  for (const item of data.connections) {
    const mapped = mapRawPassiveDiscoveryConnection(item);
    if (mapped) connections.push(mapped);
  }
  return { ok: true, data: { fetchedAt: data.fetchedAt, connections } };
}

/** Distinct from R1's own refresh-source label — this IS a live upstream probe, R1's is not. */
const SHADOW_PASSIVE_DISCOVERY_SOURCE = "shadow-passive-discovery-endpoint";

/**
 * Pure merge: folds a live R2 passive-discovery snapshot into an existing
 * (typically R1-built) per-connection inventory map. Reuses A2's own
 * `applyObservationRefresh` as the single merge rule — a connection's R1
 * inventory becomes the `previous` argument, so a model both R1 and R2 agree
 * on stays `currentlyObserved: true` (keeping R1's `firstObservedAt`), and a
 * model R1 had but this R2 read no longer lists correctly flips to
 * `currentlyObserved: false` (never silently kept alive). A connection R2
 * could not read (`status !== "OK"`) applies as a failed refresh — R1's last
 * good models are preserved untouched, exactly like a real refresh outage.
 * Never merges across connections or providers.
 */
export function mergePassiveDiscoveryIntoObservationInventory(
  previousByConnection: ReadonlyMap<string, ProviderObservationInventory>,
  snapshot: ShadowPassiveDiscoverySnapshot,
  nowMs: number
): ReadonlyMap<string, ProviderObservationInventory> {
  const observedAt = new Date(nowMs).toISOString();
  const merged = new Map(previousByConnection);
  for (const connection of snapshot.connections) {
    const previous = previousByConnection.get(connection.connectionId) ?? null;
    const outcome =
      connection.status === "OK"
        ? ({ ok: true, items: connection.models } as const)
        : ({ ok: false, reason: connection.status } as const);
    merged.set(
      connection.connectionId,
      applyObservationRefresh(previous, {
        providerId: connection.providerId,
        connectionId: connection.connectionId,
        source: SHADOW_PASSIVE_DISCOVERY_SOURCE,
        observedAt,
        outcome,
      })
    );
  }
  return merged;
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
 * `connectionId` is required on `ManagedComboMember`, while native Combo
 * persistence may omit it. For allowlisted no-auth providers that omission is
 * the canonical persisted representation of the synthetic `noauth` connection:
 * DB health intentionally removes a pin that has no provider_connections row.
 * Rehydrate that synthetic identity here so Jarvis does not detect false drift
 * immediately after its own successful apply. Unknown/foreign providers keep a
 * fail-closed sentinel instead.
 */
const UNSPECIFIED_CONNECTION_SENTINEL = "unspecified-connection";
const LEGACY_RETIRED_NOAUTH_PROVIDER = "opencode";
const LEGACY_RETIRED_NOAUTH_LOGICAL_ID = buildManagedComboLogicalId("free-coding");

function shouldRehydrateLegacyManagedNoAuth(
  providerId: string,
  ownership: CurrentComboOwnershipRecord | null
): boolean {
  return (
    providerId === LEGACY_RETIRED_NOAUTH_PROVIDER &&
    ownership?.logicalId === LEGACY_RETIRED_NOAUTH_LOGICAL_ID
  );
}

export function mapComboToCurrentComboState(combo: ShadowComboSnapshot): CurrentComboState {
  const jarvisManagedRaw = combo.config ? combo.config.jarvisManaged : undefined;
  const ownership = parseJarvisManagedOwnership(jarvisManagedRaw);
  const members: ManagedComboMember[] = [];
  for (const rawStep of combo.models) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    if (step.kind !== undefined && step.kind !== "model") continue;
    if (typeof step.model !== "string" || step.model.trim() === "") continue;
    if (typeof step.providerId !== "string" || step.providerId.trim() === "") continue;
    const providerId = step.providerId.trim();
    const rawModel = step.model.trim();
    const providerPrefix = `${providerId}/`;
    const model = rawModel.startsWith(providerPrefix)
      ? rawModel.slice(providerPrefix.length)
      : rawModel;
    members.push({
      routeId: `${providerId}/${model}`,
      providerId,
      connectionId:
        typeof step.connectionId === "string" && step.connectionId.trim() !== ""
          ? step.connectionId
          : AUTO_COMBO_NOAUTH_ALLOWLIST.has(providerId) ||
              shouldRehydrateLegacyManagedNoAuth(providerId, ownership)
            ? SYNTHETIC_NOAUTH_CONNECTION_ID
            : UNSPECIFIED_CONNECTION_SENTINEL,
      model,
    });
  }

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

  // `jarvisManaged` is ownership/audit metadata, not desired Combo settings.
  // Excluding it is essential: otherwise Jarvis's own ownership record changes
  // the fingerprint it is meant to attest and every clean read-back looks drifted.
  const fingerprintConfig: Record<string, unknown> = { ...(combo.config ?? {}) };
  delete fingerprintConfig.jarvisManaged;

  const actualFingerprint = computeEvidenceFingerprint({
    members,
    strategy: combo.strategy,
    policyMode: persistedPolicyMode,
    config: fingerprintConfig,
  });

  return {
    comboId: combo.id,
    name: combo.name,
    strategy: combo.strategy,
    members,
    actualFingerprint,
    ownership,
    isHidden: combo.isHidden,
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

export interface PipelineCandidateDiagnostic {
  routeId: string;
  providerId: string;
  connectionId: string;
  activationState: FailoverCandidate["activationState"];
  strictZeroCostSafe: boolean;
  /** True when this route may safely spend probe traffic and has no fresh compatibility evidence. */
  compatibilityProbeEligible?: boolean;
  /** Provider-neutral metadata score used only to order bounded compatibility probes. */
  compatibilityProbePriority?: number;
  /** Any PASS/INCOMPATIBLE/TRANSIENT result suppresses re-probing until its TTL expires. */
  compatibilityEvidenceFresh?: boolean;
  rankScore?: number;
  rankReasons?: readonly string[];
  lifecycleState?: ManagedFreeLifecycleState;
  lastObservedAt?: string;
  compatibilityCheckedAt?: string | null;
  lastSuccessAt?: number | null;
  costEvidence?: string | null;
  strictZeroCostReason?: string;
  contextWindow?: number | null;
  toolCalling?: boolean | null;
  compatibilityState?: string | null;
  providerHealth?: ProviderRuntimeState["providerHealth"];
  accountState?: ProviderRuntimeState["accountState"];
  quotaState?: ProviderRuntimeState["quotaState"];
  cooldownUntil?: number | null;
  disposition: CandidateDisposition;
}

export interface PipelineSummary {
  policyMode: ActivationPolicyMode;
  connections: readonly ShadowConnectionPipelineResult[];
  totalCandidates: number;
  safeCandidateCount: { general: number; strictZeroCost: number };
  candidates: readonly PipelineCandidateDiagnostic[];
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
  compatibilityInventoryByConnection?: ReadonlyMap<string, ProviderModelCompatibilityInventory>;
  resolveApproval?: (
    canonicalModelId: string,
    connectionId: string
  ) => ActivationApprovalRecord | null | undefined;
  /**
   * Per-exact-route runtime state. Key format: `${connectionId}::${canonicalModelId}`.
   * Preferred over the legacy per-connection map because quota/cooldown/lockout
   * can be model-scoped on one connection.
   */
  runtimeStateByRoute?: ReadonlyMap<string, ProviderRuntimeState>;
  /** Legacy/test fallback when no exact-route state was supplied. */
  runtimeStateByConnection?: ReadonlyMap<string, ProviderRuntimeState>;
  /**
   * Ground truth for "is this model already in the live synced/custom-models
   * pool" — R0 has no safe read source for this yet (documented at the top
   * of this file), so the live default is always `false`; tests inject a
   * resolver to prove the `ALREADY_ROUTABLE` path.
   *
   * O9-F3.5 A7.1 "R4": takes `connectionId` alongside `canonicalModelId` so a
   * model already routable on one connection can never leak `true` onto a
   * different connection that happens to share the same provider/model id
   * (`canonicalModelId` alone — `${providerId}/${providerModelId}` — carries
   * no connection identity). `oneModelActivationPlanner.ts` (R4) is the
   * intended real-world resolver source once wired: it reads a specific
   * connection's synced-model list and answers per exact connection.
   */
  alreadyRoutableResolver?: (canonicalModelId: string, connectionId: string) => boolean;
}

export function runShadowManagedComboPipeline(
  input: RunShadowManagedComboPipelineInput
): ShadowManagedComboArtifact {
  const logicalId = buildManagedComboLogicalId(input.purpose);
  const physicalName = managedComboPhysicalName(logicalId);
  const alreadyRoutable = input.alreadyRoutableResolver ?? (() => false);

  const connectionResults: ShadowConnectionPipelineResult[] = [];
  const candidates: FailoverCandidate[] = [];
  const compatibilityProbeByCandidateKey = new Map<
    string,
    { eligible: boolean; evidenceFresh: boolean; priority: number }
  >();
  const rankByCandidateKey = new Map<string, { score: number; reasons: string[] }>();
  const lifecycleByCandidateKey = new Map<string, ManagedFreeLifecycleState>();

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
    const compatibilityInventory = input.compatibilityInventoryByConnection?.get(
      connection.connectionId
    );
    const connectionProbeBackoffUntil = compatibilityConnectionProbeBackoffUntil(
      compatibilityInventory,
      input.now
    );

    const resolution = resolveProviderObservations({
      inventory,
      connection: billable,
      compatibilityInventory,
      nowMs: input.now,
    });

    const gate = resolveActivationGate({
      provider: connection.provider,
      connectionId: connection.connectionId,
      resolved: resolution.models,
      connectionActive: connection.isActive,
      policyMode: input.policyMode,
      resolveApproval: (canonicalModelId) =>
        input.resolveApproval?.(canonicalModelId, connection.connectionId),
    });

    let candidatesBuilt = 0;
    for (let i = 0; i < resolution.models.length; i++) {
      const resolved = resolution.models[i];
      const runtimeState =
        input.runtimeStateByRoute?.get(
          `${connection.connectionId}::${resolved.record.canonicalModelId}`
        ) ??
        input.runtimeStateByConnection?.get(connection.connectionId) ??
        conservativeRuntimeStateFromConnection(connection, input.now);
      // A model no longer listed by the last refresh is observation
      // history, not a live routing candidate — never built into a
      // FailoverCandidate.
      if (!resolved.record.currentlyObserved) continue;
      const activation = gate.decisions[i];
      const compatibilityEvidence =
        compatibilityInventory?.models?.[resolved.record.providerModelId];
      const evidenceFresh = compatibilityEvidenceFresh(compatibilityEvidence, input.now);
      const compatibilityProbeEligible =
        connection.isActive === true &&
        resolved.record.currentlyObserved === true &&
        runtimeAllowsCompatibilityProbe(runtimeState, input.now) &&
        connectionProbeBackoffUntil === null &&
        resolved.evidence.claudeCodeEligible === null &&
        resolved.evidence.knownProtocolConflict !== true &&
        !evidenceFresh &&
        isZeroCostSafeForCompatibilityProbe(resolved.evidence) &&
        isToolRoundTripProbePlausible(resolved.record, resolved.evidence);
      const candidate = candidateFromResolvedObservation({
        providerId: connection.provider,
        connectionId: connection.connectionId,
        resolved,
        runtimeState,
        activation,
        connectionActive: connection.isActive,
        alreadyRoutable: alreadyRoutable(resolved.record.canonicalModelId, connection.connectionId),
      });
      candidates.push(candidate);
      const candidateKey = `${candidate.providerId}::${candidate.connectionId}::${candidate.routeId}`;
      compatibilityProbeByCandidateKey.set(candidateKey, {
        eligible: compatibilityProbeEligible,
        evidenceFresh,
        priority: compatibilityProbePriority(resolved.record),
      });
      lifecycleByCandidateKey.set(
        candidateKey,
        deriveManagedFreeLifecycle({
          record: resolved.record,
          compatibility: compatibilityEvidence,
          runtimeState,
          nowMs: input.now,
        })
      );
      rankByCandidateKey.set(
        candidateKey,
        scoreManagedFreeCandidate({
          routeId: candidate.routeId,
          providerId: candidate.providerId,
          connectionId: candidate.connectionId,
          providerModelId: resolved.record.providerModelId,
          toolCalling: resolved.evidence.toolCalling,
          contextWindow: resolved.record.contextWindow,
          supportedParameters: filterSupportedParametersForRoute(
            candidate.providerId,
            resolved.record.providerModelId,
            resolved.record.supportedParameters
          ),
          compatibilityLatencyMs: compatibilityEvidence?.latencyMs ?? null,
          runtimeState,
          nowMs: input.now,
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
  const scoreByKey = new Map(
    [...rankByCandidateKey.entries()].map(([key, rank]) => [key, rank.score] as const)
  );
  const rankedSafeSet = {
    ...safeSet,
    general: orderSafeCandidatesWithProviderDiversity(safeSet.general, scoreByKey),
    strictZeroCost: orderSafeCandidatesWithProviderDiversity(safeSet.strictZeroCost, scoreByKey),
  };
  const candidateDiagnostics: PipelineCandidateDiagnostic[] = candidates.map((candidate) => {
    const key = `${candidate.providerId}::${candidate.connectionId}::${candidate.routeId}`;
    const probe = compatibilityProbeByCandidateKey.get(key);
    return {
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      connectionId: candidate.connectionId,
      activationState: candidate.activationState,
      strictZeroCostSafe: candidate.strictZeroCostSafe,
      compatibilityProbeEligible: probe?.eligible ?? false,
      compatibilityProbePriority: probe?.priority ?? 0,
      compatibilityEvidenceFresh: probe?.evidenceFresh ?? false,
      rankScore: rankByCandidateKey.get(key)?.score ?? 0,
      rankReasons: rankByCandidateKey.get(key)?.reasons ?? [],
      lifecycleState: lifecycleByCandidateKey.get(key),
      lastObservedAt: (() => {
        for (const connection of input.connections) {
          if (connection.connectionId !== candidate.connectionId) continue;
          const inventory = input.observationInventoryByConnection?.get(connection.connectionId);
          const record = inventory?.models.find((m) => m.canonicalModelId === candidate.routeId);
          if (record) return record.lastObservedAt;
        }
        return undefined;
      })(),
      compatibilityCheckedAt: (() => {
        const inventory = input.compatibilityInventoryByConnection?.get(candidate.connectionId);
        const prefix = `${candidate.providerId}/`;
        const modelId = candidate.routeId.startsWith(prefix)
          ? candidate.routeId.slice(prefix.length)
          : candidate.routeId;
        return inventory?.models?.[modelId]?.checkedAt ?? null;
      })(),
      lastSuccessAt: candidate.runtimeState.lastSuccessAt,
      costEvidence: (() => {
        const inventory = input.observationInventoryByConnection?.get(candidate.connectionId);
        const record = inventory?.models.find((m) => m.canonicalModelId === candidate.routeId);
        if (!record) return null;
        const connection = input.connections.find((c) => c.connectionId === candidate.connectionId);
        if (!connection) return null;
        return (
          resolveProviderObservations({
            inventory: { ...inventory, models: [record] },
            connection: {
              provider: connection.provider,
              authType: connection.authType,
              connectionId: connection.connectionId,
              providerSpecificData: connection.providerSpecificData,
              isActive: connection.isActive,
            },
            compatibilityInventory: input.compatibilityInventoryByConnection?.get(
              candidate.connectionId
            ),
            nowMs: input.now,
          }).models[0]?.evidence.freeEvidenceSource ?? null
        );
      })(),
      strictZeroCostReason: (() => {
        const inventory = input.observationInventoryByConnection?.get(candidate.connectionId);
        const record = inventory?.models.find((m) => m.canonicalModelId === candidate.routeId);
        if (!record) return "unknown";
        const connection = input.connections.find((c) => c.connectionId === candidate.connectionId);
        if (!connection) return "unknown";
        return (
          resolveProviderObservations({
            inventory: { ...inventory, models: [record] },
            connection: {
              provider: connection.provider,
              authType: connection.authType,
              connectionId: connection.connectionId,
              providerSpecificData: connection.providerSpecificData,
              isActive: connection.isActive,
            },
            compatibilityInventory: input.compatibilityInventoryByConnection?.get(
              candidate.connectionId
            ),
            nowMs: input.now,
          }).models[0]?.evidence.strictZeroCostReason ?? "unknown"
        );
      })(),
      contextWindow: (() => {
        const inventory = input.observationInventoryByConnection?.get(candidate.connectionId);
        return (
          inventory?.models.find((m) => m.canonicalModelId === candidate.routeId)?.contextWindow ??
          null
        );
      })(),
      toolCalling: candidate.runtimeState.capabilities.genericToolEligible,
      providerHealth: candidate.runtimeState.providerHealth,
      accountState: candidate.runtimeState.accountState,
      quotaState: candidate.runtimeState.quotaState,
      cooldownUntil: candidate.runtimeState.cooldownUntil,
      compatibilityState: (() => {
        const inventory = input.compatibilityInventoryByConnection?.get(candidate.connectionId);
        const prefix = `${candidate.providerId}/`;
        const modelId = candidate.routeId.startsWith(prefix)
          ? candidate.routeId.slice(prefix.length)
          : candidate.routeId;
        return inventory?.models?.[modelId]?.state ?? null;
      })(),
      disposition: rankedSafeSet.dispositionByKey.get(key) ?? {
        kind: "JARVIS_REJECTED",
        reason: "NO_SAFE_ROUTE",
      },
    };
  });
  const poolKind = input.policyMode === "strict_zero_cost" ? "strictZeroCost" : "general";
  const recommendation = recommendStrategy({
    safeSet: rankedSafeSet,
    poolKind,
    requestClass: input.requestClass,
    telemetry: input.telemetry,
    quota: input.quota,
  });

  const desired = buildManagedComboDesiredState({
    logicalId,
    name: physicalName,
    safeSet: rankedSafeSet,
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
      candidates: candidateDiagnostics,
      strategy: recommendation.strategy,
      strategyConfidence: recommendation.confidence,
      strategyReasons: recommendation.reasons,
    },
    desiredState: desired,
    reconciliationPlan,
  };
}
