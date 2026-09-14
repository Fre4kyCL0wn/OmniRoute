/**
 * Dynamic managed free-coding control plane (O9-F3.5 R4.5b).
 *
 * Provider-agnostic by construction: every active connection with persisted
 * observations participates. Optional refresh asks the native generic catalog
 * layer whether each provider is supported; no Jarvis provider allowlist exists.
 */
import { createCombo, getComboById, getComboByName, getCombos, updateCombo } from "@/lib/db/combos";
import { getActivationApproval } from "@/lib/db/providerActivationApprovals";
import { getProviderObservationInventory } from "@/lib/db/providerObservedModels";
import { getRawProviderConnections } from "@/lib/db/providers";
import {
  getSyncedAvailableModelsByConnection,
  SYNCED_AVAILABLE_MODELS_MALFORMED,
} from "@/lib/db/models";
import { getProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";
import { parseConnectionBillingEvidence } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import {
  refreshConnectionObservations,
  supportsObservationCatalogProvider,
} from "@/app/api/providers/[id]/models/discovery/providerObservationRefresh";
import {
  runShadowManagedComboPipeline,
  type ShadowComboSnapshot,
  type ShadowConnectionSnapshot,
  type ShadowManagedComboArtifact,
} from "./shadowControlPlaneAdapter";
import type { ProviderObservationInventory } from "../providerOnboarding/types";
import { applyManagedComboReconciliation, type ManagedComboApplyResult } from "./managedComboApply";
import {
  observeConnectionBillingSafety,
  type ConnectionBillingObservation,
} from "./connectionBillingObservation";

export interface ManagedFreeCodingRefreshResult {
  providerId: string;
  connectionId: string;
  status: string;
}

export interface ManagedFreeCodingDryRun {
  artifact: ShadowManagedComboArtifact;
  observationRefresh: ManagedFreeCodingRefreshResult[];
  billingObservation: ConnectionBillingObservation[];
  discoveredProviderCount: number;
  activeConnectionCount: number;
}

export interface ManagedFreeCodingControlPlaneOptions {
  refreshObservations?: boolean;
  nowMs?: number;
}

export interface ManagedFreeCodingApply {
  dryRun: ManagedFreeCodingDryRun;
  apply: ManagedComboApplyResult;
}

interface ConnectionRow {
  id?: unknown;
  provider?: unknown;
  authType?: unknown;
  isActive?: unknown;
  testStatus?: unknown;
  providerSpecificData?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function applyBillingObservation(
  connection: ShadowConnectionSnapshot,
  observation: ConnectionBillingObservation | undefined
): ShadowConnectionSnapshot {
  if (!observation?.evidence) return connection;
  const providerSpecificData = asRecord(connection.providerSpecificData);
  const existing = parseConnectionBillingEvidence(providerSpecificData);
  if (existing?.billingLinked === true && observation.evidence.billingLinked === false) {
    return connection;
  }
  return {
    ...connection,
    providerSpecificData: { ...providerSpecificData, billingEvidence: observation.evidence },
  };
}

function toConnectionSnapshot(row: ConnectionRow): ShadowConnectionSnapshot | null {
  if (typeof row.id !== "string" || typeof row.provider !== "string") return null;
  return {
    connectionId: row.id,
    provider: row.provider,
    authType: typeof row.authType === "string" ? row.authType : null,
    isActive: row.isActive === true,
    testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
    providerSpecificData: row.providerSpecificData ?? null,
  };
}

function toComboSnapshot(raw: Record<string, unknown>): ShadowComboSnapshot | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    strategy: typeof raw.strategy === "string" ? raw.strategy : "priority",
    models: Array.isArray(raw.models) ? raw.models : [],
    config:
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? (raw.config as Record<string, unknown>)
        : null,
    isHidden: raw.isHidden === true,
  };
}

async function refreshEligibleConnections(
  connections: readonly ShadowConnectionSnapshot[]
): Promise<ManagedFreeCodingRefreshResult[]> {
  const queue = connections.filter(
    (c) => c.isActive && supportsObservationCatalogProvider(c.provider)
  );
  const results: ManagedFreeCodingRefreshResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= queue.length) return;
      const connection = queue[index];
      try {
        const result = await refreshConnectionObservations(connection.connectionId);
        results[index] = {
          providerId: connection.provider,
          connectionId: connection.connectionId,
          status: result.status === "refreshed" ? result.inventory.refreshStatus : result.status,
        };
      } catch {
        results[index] = {
          providerId: connection.provider,
          connectionId: connection.connectionId,
          status: "refresh-error",
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, () => worker()));
  return results.filter(Boolean);
}

export async function buildManagedFreeCodingDryRun(
  options: ManagedFreeCodingControlPlaneOptions = {}
): Promise<ManagedFreeCodingDryRun> {
  const nowMs = options.nowMs ?? Date.now();
  const rawConnections = (await getRawProviderConnections({}, undefined, undefined, [
    "id",
    "provider",
    "auth_type",
    "is_active",
    "test_status",
    "provider_specific_data",
  ])) as ConnectionRow[];
  const connections = rawConnections
    .map(toConnectionSnapshot)
    .filter((value): value is ShadowConnectionSnapshot => value !== null);

  const [observationRefresh, billingObservation] = options.refreshObservations
    ? await Promise.all([
        refreshEligibleConnections(connections),
        Promise.all(
          connections
            .filter((connection) => connection.isActive)
            .map((connection) => observeConnectionBillingSafety(connection))
        ),
      ])
    : [[], []];
  const billingByConnection = new Map(
    billingObservation.map((observation) => [observation.connectionId, observation])
  );
  const pipelineConnections = connections.map((connection) =>
    applyBillingObservation(connection, billingByConnection.get(connection.connectionId))
  );

  const observationInventoryByConnection = new Map<string, ProviderObservationInventory>();
  for (const connection of connections) {
    const inventory = getProviderObservationInventory(connection.connectionId);
    if (inventory) observationInventoryByConnection.set(connection.connectionId, inventory);
  }

  const providers = [...new Set(connections.map((c) => c.provider))];
  const syncedByProvider = new Map<
    string,
    Awaited<ReturnType<typeof getSyncedAvailableModelsByConnection>>
  >();
  await Promise.all(
    providers.map(async (provider) => {
      syncedByProvider.set(provider, await getSyncedAvailableModelsByConnection(provider));
    })
  );

  const runtimeStateByRoute = new Map<
    string,
    Awaited<ReturnType<typeof getProviderRuntimeState>>
  >();
  for (const connection of connections) {
    const inventory = observationInventoryByConnection.get(connection.connectionId);
    if (!inventory) continue;
    for (const model of inventory.models) {
      if (!model.currentlyObserved) continue;
      try {
        const state = await getProviderRuntimeState(
          connection.provider,
          connection.connectionId,
          model.providerModelId
        );
        runtimeStateByRoute.set(`${connection.connectionId}::${model.canonicalModelId}`, state);
      } catch {
        // Omit the exact-route override: the pipeline falls back to its
        // conservative unknown-state projection, never an optimistic state.
      }
    }
  }

  const rawCombos = (await getCombos()) as unknown as Record<string, unknown>[];
  const combos = rawCombos
    .map(toComboSnapshot)
    .filter((value): value is ShadowComboSnapshot => value !== null);

  const quotaPressure = [...runtimeStateByRoute.values()].some(
    (state) =>
      state.accountState === "quota_exhausted" ||
      state.accountState === "rate_limited" ||
      (state.cooldownUntil !== null && state.cooldownUntil > nowMs)
  );
  const resetWindowKnownCount = [...runtimeStateByRoute.values()].filter(
    (state) => state.quotaResetAt !== null
  ).length;

  const providerByConnection = new Map(
    pipelineConnections.map((c) => [c.connectionId, c.provider])
  );
  const artifact = runShadowManagedComboPipeline({
    connections: pipelineConnections,
    combos,
    purpose: "free-coding",
    policyMode: "strict_zero_cost",
    requestClass: {
      taskType: "coding",
      requestHasTools: true,
      estimatedContextTokens: null,
      isBackgroundTask: false,
      latencySensitive: null,
    },
    telemetry: {
      headroomKnownCount: 0,
      resetWindowKnownCount,
      equivalentLocalRouteCount: 0,
      liveLoadTelemetryAvailable: false,
      knownContextCapacityTokens: null,
      cacheAffinityAvailable: false,
    },
    quota: { quotaPressure },
    now: nowMs,
    observationInventoryByConnection,
    runtimeStateByRoute,
    resolveApproval: (canonicalModelId, connectionId) =>
      getActivationApproval(connectionId, canonicalModelId),
    alreadyRoutableResolver: (canonicalModelId, connectionId) => {
      const provider = providerByConnection.get(connectionId);
      if (!provider) return false;
      const byConnection = syncedByProvider.get(provider);
      if (!byConnection || byConnection[SYNCED_AVAILABLE_MODELS_MALFORMED]) return false;
      const prefix = `${provider}/`;
      const providerModelId = canonicalModelId.startsWith(prefix)
        ? canonicalModelId.slice(prefix.length)
        : canonicalModelId;
      return (byConnection[connectionId] ?? []).some((model) => model.id === providerModelId);
    },
  });

  return {
    artifact,
    observationRefresh,
    billingObservation,
    discoveredProviderCount: providers.length,
    activeConnectionCount: connections.filter((c) => c.isActive).length,
  };
}

export async function applyManagedFreeCodingDryRun(
  dryRun: ManagedFreeCodingDryRun,
  nowMs: number = Date.now()
): Promise<ManagedComboApplyResult> {
  return applyManagedComboReconciliation({
    desired: dryRun.artifact.desiredState,
    plan: dryRun.artifact.reconciliationPlan,
    nowIso: new Date(nowMs).toISOString(),
    deps: { getComboByName, getComboById, createCombo, updateCombo },
  });
}

export async function applyManagedFreeCoding(
  options: ManagedFreeCodingControlPlaneOptions = {}
): Promise<ManagedFreeCodingApply> {
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = await buildManagedFreeCodingDryRun({
    ...options,
    nowMs,
  });
  const apply = await applyManagedFreeCodingDryRun(dryRun, nowMs);
  return { dryRun, apply };
}
