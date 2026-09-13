/**
 * O9-F3.5 A7.1 "R4.2" — Controlled Activation Orchestrator.
 *
 * Pure/unit tests only: no DB, no HTTP, no provider request, no inference,
 * no real `replaceSyncedAvailableModelsForConnection` call, no Combo write,
 * no Shadow/Production contact. `fakeStore()` below is an in-memory
 * per-connection synced-model map that only ever records what WOULD be
 * written — it is never the real DB-backed writer.
 *
 * Scope note: `orchestrateModelActivation` deliberately never re-implements
 * any of `planOneModelActivation`'s (R4) gating logic — it only calls it.
 * Every individual technical BLOCKED reason (`not-executable`,
 * `not-claude-eligible`, `known-protocol-conflict`, `not-ready`,
 * `not-activation-candidate`) is already exhaustively proven against literal
 * `ResolvedObservation` fixtures in `oneModelActivationPlannerR4.test.ts`
 * and `providerActivationGateA3.test.ts`, which R4.2 reuses unmodified
 * (see mission "quality gates" — run R4/A3 alongside R4.2, not duplicate
 * them). What is new and unique to this file is the orchestration layer
 * itself: connection/provider resolution, observation-freshness gating, the
 * approval-required override, the real write + read-back + rollback cycle,
 * idempotency, and connection isolation. Reuses the real A2 evidence
 * resolver and the same NVIDIA live-catalog fixture + canonical id
 * (`nvidia/moonshotai/kimi-k3`) `oneModelActivationPlannerR4.test.ts` uses,
 * so the happy-path proof is against genuine evidence, not hand-faked
 * booleans.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyObservationRefresh } from "../../src/lib/providerOnboarding/catalog.ts";
import type { ProviderObservationInventory } from "../../src/lib/providerOnboarding/types.ts";
import type {
  ActivationApprovalRecord,
  ActivationPolicyMode,
} from "../../src/lib/providerOnboarding/activationPolicy.ts";
import {
  OBSERVATION_MAX_AGE_MS,
  orchestrateModelActivation,
  type ActivationOrchestrationDeps,
  type OrchestrationConnection,
} from "../../src/lib/providerOnboarding/activationOrchestrator.ts";
import type {
  SyncedAvailableModel,
  SyncedAvailableModelInput,
} from "../../src/lib/db/models/synced.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const NVIDIA = fixture("nvidia-models-live-a2.json");
const T1 = "2026-09-12T00:00:00.000Z";
const T1_MS = Date.parse(T1);
const PROVIDER = "nvidia";
const PROVIDER_MODEL_ID = "moonshotai/kimi-k3";
const CANONICAL = `${PROVIDER}/${PROVIDER_MODEL_ID}`;

function buildInventory(
  connectionId: string,
  items: readonly unknown[] = NVIDIA.data,
  observedAt: string = T1
): ProviderObservationInventory {
  return applyObservationRefresh(null, {
    providerId: PROVIDER,
    connectionId,
    source: "test-fixture",
    observedAt,
    outcome: { ok: true, items },
  });
}

/** Shared, per-connection in-memory synced-model store — same shape `getSyncedAvailableModelsByConnection` returns keyed by connectionId. */
function fakeStore(seed: Record<string, SyncedAvailableModel[]> = {}) {
  const byConnection = new Map<string, SyncedAvailableModel[]>(
    Object.entries(seed).map(([k, v]) => [k, [...v]])
  );
  return {
    get: (connectionId: string) => [...(byConnection.get(connectionId) ?? [])],
    set: (connectionId: string, models: SyncedAvailableModel[]) =>
      byConnection.set(connectionId, [...models]),
  };
}

interface DepsOverrides {
  connection?: Partial<OrchestrationConnection> | null;
  inventory?: ProviderObservationInventory | null;
  policyMode?: ActivationPolicyMode;
  approval?: ActivationApprovalRecord | null;
  store?: ReturnType<typeof fakeStore>;
  connectionId?: string;
  /** Records every write call, in order, for assertion. */
  writeCalls?: Array<readonly SyncedAvailableModelInput[]>;
  /** Override the writer entirely (e.g. to simulate a corrupted write). */
  writeSyncedModels?: ActivationOrchestrationDeps["writeSyncedModels"];
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: ActivationOrchestrationDeps;
  store: ReturnType<typeof fakeStore>;
  connectionId: string;
} {
  const connectionId = overrides.connectionId ?? "conn-nv-1";
  const store = overrides.store ?? fakeStore();
  const writeCalls = overrides.writeCalls ?? [];
  const connectionOverride = overrides.connection;
  const connection: OrchestrationConnection | null =
    connectionOverride === null
      ? null
      : {
          connectionId,
          providerId: PROVIDER,
          isActive: true,
          authType: "apikey",
          providerSpecificData: {},
          ...connectionOverride,
        };
  const inventory =
    overrides.inventory === undefined ? buildInventory(connectionId) : overrides.inventory;

  const deps: ActivationOrchestrationDeps = {
    loadConnection: async () => connection,
    loadObservationInventory: async () => inventory,
    loadPolicyMode: async () => overrides.policyMode ?? "manual",
    loadApproval: async () => overrides.approval ?? null,
    loadCurrentSyncedModels: async () => store.get(connectionId),
    writeSyncedModels:
      overrides.writeSyncedModels ??
      (async (models) => {
        writeCalls.push(models);
        store.set(connectionId, models as SyncedAvailableModel[]);
      }),
  };
  return { deps, store, connectionId };
}

function approvedRecord(
  overrides: Partial<ActivationApprovalRecord> = {}
): ActivationApprovalRecord {
  return {
    canonicalModelId: CANONICAL,
    approved: true,
    approvedBy: "test-operator",
    approvedAt: T1,
    note: null,
    ...overrides,
  };
}

const FRESH_NOW_MS = T1_MS + 1000;

// ---------------------------------------------------------------------------
// F. unknown connection -> BLOCKED
// ---------------------------------------------------------------------------

test("F: unknown connection -> BLOCKED, no mutation, no observation/approval read attempted to matter", async () => {
  const { deps } = makeDeps({ connection: null });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-missing",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["connection-not-found"]);
  assert.equal(result.beforeCount, 0);
  assert.equal(result.afterCount, 0);
});

// ---------------------------------------------------------------------------
// G. provider/connection mismatch -> BLOCKED
// ---------------------------------------------------------------------------

test("G: providerId does not match the resolved connection's own provider -> BLOCKED", async () => {
  const { deps } = makeDeps({ connection: { providerId: "openrouter" } });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["provider-mismatch"]);
});

test("invalid canonicalModelId (wrong provider prefix) -> BLOCKED before any read", async () => {
  const { deps } = makeDeps();
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: "openrouter/some-model",
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["invalid-canonical-model-id"]);
});

// ---------------------------------------------------------------------------
// J. missing / stale observation -> VALIDATION_REQUIRED
// ---------------------------------------------------------------------------

test("J: no persisted observation inventory at all -> VALIDATION_REQUIRED", async () => {
  const { deps } = makeDeps({ inventory: null });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "VALIDATION_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["no-observation-inventory"]);
});

test("J: last refresh attempt failed (refreshStatus != ok) -> VALIDATION_REQUIRED, never trusts the older good models", async () => {
  const good = buildInventory("conn-nv-1");
  const failed = applyObservationRefresh(good, {
    providerId: PROVIDER,
    connectionId: "conn-nv-1",
    source: "test-fixture",
    observedAt: T1,
    outcome: { ok: false, reason: "fetch-error" },
  });
  const { deps } = makeDeps({ inventory: failed });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "VALIDATION_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["observation-not-fresh", "refresh-status-failed"]);
});

test("J: a successful refresh older than OBSERVATION_MAX_AGE_MS -> VALIDATION_REQUIRED (stale)", async () => {
  const { deps } = makeDeps();
  const staleNowMs = T1_MS + OBSERVATION_MAX_AGE_MS + 1;
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: staleNowMs,
    },
    deps
  );
  assert.equal(result.status, "VALIDATION_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["stale-observation"]);
});

test("J: a model never observed for this connection at all -> VALIDATION_REQUIRED (model-not-observed)", async () => {
  const { deps } = makeDeps();
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: `${PROVIDER}/totally-unheard-of-model-xyz`,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "VALIDATION_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["model-not-observed"]);
});

// ---------------------------------------------------------------------------
// K. inactive connection -> BLOCKED (via the real planner, real evidence)
// ---------------------------------------------------------------------------

test("K: an inactive connection blocks activation even for an otherwise-READY, approved model", async () => {
  const { deps } = makeDeps({
    connection: { isActive: false },
    approval: approvedRecord(),
  });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["connection-inactive"]);
});

// ---------------------------------------------------------------------------
// M/O-ish: an unregistered model resolves to unknown evidence -> BLOCKED (not-executable),
// proving the orchestrator faithfully passes through whatever the real
// planner decides, rather than hand-computing its own verdict.
// ---------------------------------------------------------------------------

test("an unregistered/unclassified model observed by the provider -> BLOCKED (not-executable), never a fabricated eligibility", async () => {
  const unknownModelId = "some-vendor/totally-unregistered-model-9000";
  const items = [{ id: unknownModelId }];
  const { deps } = makeDeps({
    inventory: buildInventory("conn-nv-1", items),
    approval: approvedRecord({ canonicalModelId: `${PROVIDER}/${unknownModelId}` }),
  });
  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: `${PROVIDER}/${unknownModelId}`,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  // Real evidence resolution: an id with no static-registry/capability entry
  // resolves `executable: true` (default-permissive) but `claudeCodeEligible:
  // null` (genuinely unknown) — the planner fails closed on that unknown,
  // never fabricating an eligibility verdict the codebase does not have.
  assert.deepEqual(result.reasonCodes, ["not-claude-eligible"]);
});

// ---------------------------------------------------------------------------
// H. missing approval -> APPROVAL_REQUIRED (real READY model, manual mode)
// ---------------------------------------------------------------------------

test("H: an otherwise-activatable model with no approval on record -> APPROVAL_REQUIRED, no mutation", async () => {
  const { deps, store, connectionId } = makeDeps({ approval: null });
  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(result.status, "APPROVAL_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["no-approval-on-record"]);
  assert.deepEqual(store.get(connectionId), [], "no mutation must occur");
});

test("H: APPROVAL_REQUIRED even under approved_ready policy mode — this endpoint's own gate is independent of policy mode", async () => {
  const { deps, store, connectionId } = makeDeps({ approval: null, policyMode: "approved_ready" });
  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(result.status, "APPROVAL_REQUIRED");
  assert.deepEqual(
    store.get(connectionId),
    [],
    "approved_ready must never auto-activate through this endpoint without an explicit approval record"
  );
});

// ---------------------------------------------------------------------------
// I. revoked approval -> BLOCKED (distinct from "no approval on record")
// ---------------------------------------------------------------------------

test("I: an explicit revocation (approved: false) -> BLOCKED, never APPROVAL_REQUIRED", async () => {
  const { deps, store, connectionId } = makeDeps({
    approval: approvedRecord({ approved: false }),
  });
  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["approval-revoked"]);
  assert.deepEqual(store.get(connectionId), []);
});

// ---------------------------------------------------------------------------
// Q. already present -> NO_CHANGE (when approved — see note below for the
// no-approval case, which is intentionally APPROVAL_REQUIRED instead)
// ---------------------------------------------------------------------------

test("Q: approved model already present in the connection's synced list -> NO_CHANGE", async () => {
  const already: SyncedAvailableModel = {
    id: PROVIDER_MODEL_ID,
    name: "Kimi K3",
    source: "imported",
  };
  const { deps, store, connectionId } = makeDeps({
    approval: approvedRecord(),
    store: fakeStore({ "conn-nv-1": [already] }),
  });
  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(result.status, "NO_CHANGE");
  assert.deepEqual(result.reasonCodes, ["already-present"]);
  assert.equal(result.alreadyRoutable, true);
  assert.equal(result.beforeCount, 1);
  assert.equal(result.afterCount, 1);
  assert.deepEqual(store.get(connectionId), [already], "no write attempted");
});

test("Q-note: already-present but NO approval on record -> APPROVAL_REQUIRED, not NO_CHANGE (R4's own gate order: policy is checked before presence)", async () => {
  const already: SyncedAvailableModel = {
    id: PROVIDER_MODEL_ID,
    name: "Kimi K3",
    source: "imported",
  };
  const { deps, store, connectionId } = makeDeps({
    approval: null,
    store: fakeStore({ "conn-nv-1": [already] }),
  });
  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(result.status, "APPROVAL_REQUIRED");
  assert.deepEqual(store.get(connectionId), [already], "no write attempted either way");
});

// ---------------------------------------------------------------------------
// R/S/T. approved + READY + absent -> ACTIVATE/ACTIVATED, preserving existing rows
// ---------------------------------------------------------------------------

test("R/S/T: approved + READY + absent -> ACTIVATED, preserving every pre-existing row, verified by read-back", async () => {
  const preexisting: SyncedAvailableModel = {
    id: "some-other-model",
    name: "Other",
    source: "imported",
  };
  const writeCalls: Array<readonly SyncedAvailableModelInput[]> = [];
  const { deps, store, connectionId } = makeDeps({
    approval: approvedRecord(),
    store: fakeStore({ "conn-nv-1": [preexisting] }),
    writeCalls,
  });

  const result = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );

  assert.equal(result.status, "ACTIVATED");
  assert.deepEqual(result.reasonCodes, ["activated", "policy-manual-approved"]);
  assert.equal(result.alreadyRoutable, false, "was not already routable before this call");
  assert.equal(result.beforeCount, 1);
  assert.equal(result.afterCount, 2);

  const finalModels = store.get(connectionId);
  assert.equal(finalModels.length, 2);
  assert.ok(
    finalModels.some((m) => m.id === "some-other-model"),
    "pre-existing row preserved"
  );
  assert.ok(
    finalModels.some((m) => m.id === PROVIDER_MODEL_ID),
    "target model activated"
  );

  assert.equal(writeCalls.length, 1, "exactly one canonical write");
  const written = writeCalls[0].find((m) => m.id === PROVIDER_MODEL_ID) as
    Record<string, unknown> | undefined;
  assert.ok(written);
  // X. strict-zero-cost / billing evidence is never fabricated into the synced-model row.
  for (const forbiddenField of [
    "verifiedFree",
    "hardStopGuaranteed",
    "connectionSafeForZeroCost",
    "strictZeroCostEligible",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(written!, forbiddenField), false);
  }
});

// ---------------------------------------------------------------------------
// V. idempotency — second identical request -> NO_CHANGE, no duplicate row, no second write
// ---------------------------------------------------------------------------

test("V: a second identical activation request after ACTIVATED -> NO_CHANGE, writer not called again", async () => {
  const writeCalls: Array<readonly SyncedAvailableModelInput[]> = [];
  const { deps, store, connectionId } = makeDeps({ approval: approvedRecord(), writeCalls });

  const first = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS },
    deps
  );
  assert.equal(first.status, "ACTIVATED");
  assert.equal(writeCalls.length, 1);

  const second = await orchestrateModelActivation(
    { providerId: PROVIDER, connectionId, canonicalModelId: CANONICAL, nowMs: FRESH_NOW_MS + 1 },
    deps
  );
  assert.equal(second.status, "NO_CHANGE");
  assert.equal(writeCalls.length, 1, "no duplicate write on the idempotent replay");
  assert.equal(store.get(connectionId).filter((m) => m.id === PROVIDER_MODEL_ID).length, 1);
});

// ---------------------------------------------------------------------------
// W. connection isolation — same provider+model, two connections, one shared store object
// ---------------------------------------------------------------------------

test("W: activating on connection A never mutates connection B's synced list, even sharing one store", async () => {
  const sharedStore = fakeStore({ "conn-a": [], "conn-b": [] });
  const depsFor = (connectionId: string, approval: ActivationApprovalRecord | null) => ({
    loadConnection: async (): Promise<OrchestrationConnection | null> => ({
      connectionId,
      providerId: PROVIDER,
      isActive: true,
      authType: "apikey",
      providerSpecificData: {},
    }),
    loadObservationInventory: async () => buildInventory(connectionId),
    loadPolicyMode: async (): Promise<ActivationPolicyMode> => "manual",
    loadApproval: async () => approval,
    loadCurrentSyncedModels: async () => sharedStore.get(connectionId),
    writeSyncedModels: async (models: readonly SyncedAvailableModelInput[]) =>
      sharedStore.set(connectionId, models as SyncedAvailableModel[]),
  });

  const resultA = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-a",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    depsFor("conn-a", approvedRecord())
  );
  assert.equal(resultA.status, "ACTIVATED");
  assert.equal(sharedStore.get("conn-a").length, 1);
  assert.equal(sharedStore.get("conn-b").length, 0, "connection B must remain untouched");

  const resultBWithoutApproval = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-b",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    depsFor("conn-b", null)
  );
  assert.equal(resultBWithoutApproval.status, "APPROVAL_REQUIRED");
  assert.equal(sharedStore.get("conn-b").length, 0);
  assert.equal(
    sharedStore.get("conn-a").length,
    1,
    "connection A must remain untouched by B's request"
  );
});

// ---------------------------------------------------------------------------
// U. read-back verification failure -> rollback restores exact before-state
// ---------------------------------------------------------------------------

test("U: a corrupted write fails read-back verification and is rolled back to the exact before-state", async () => {
  const preexisting: SyncedAvailableModel = {
    id: "some-other-model",
    name: "Other",
    source: "imported",
  };
  let callCount = 0;
  const written: Array<readonly SyncedAvailableModelInput[]> = [];
  const backingStore = fakeStore({ "conn-nv-1": [preexisting] });

  const deps: ActivationOrchestrationDeps = {
    loadConnection: async () => ({
      connectionId: "conn-nv-1",
      providerId: PROVIDER,
      isActive: true,
      authType: "apikey",
      providerSpecificData: {},
    }),
    loadObservationInventory: async () => buildInventory("conn-nv-1"),
    loadPolicyMode: async () => "manual",
    loadApproval: async () => approvedRecord(),
    loadCurrentSyncedModels: async () => backingStore.get("conn-nv-1"),
    writeSyncedModels: async (models) => {
      callCount++;
      written.push(models);
      if (callCount === 1) {
        // Simulate a corrupted write: silently drops the pre-existing row —
        // never actually possible through the real canonical writer, but
        // proves the verification+rollback path fires when it somehow did.
        backingStore.set(
          "conn-nv-1",
          (models as SyncedAvailableModel[]).filter((m) => m.id !== "some-other-model")
        );
      } else {
        backingStore.set("conn-nv-1", models as SyncedAvailableModel[]);
      }
    },
  };

  const result = await orchestrateModelActivation(
    {
      providerId: PROVIDER,
      connectionId: "conn-nv-1",
      canonicalModelId: CANONICAL,
      nowMs: FRESH_NOW_MS,
    },
    deps
  );

  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["read-back-verification-failed", "rolled-back"]);
  assert.equal(callCount, 2, "exactly one corrective rollback write, no retry loop");
  assert.deepEqual(
    backingStore.get("conn-nv-1"),
    [preexisting],
    "rollback restores the exact original CURRENT list"
  );
});

// ---------------------------------------------------------------------------
// Y/Z. Combo boundary and inference boundary — static source scan
// ---------------------------------------------------------------------------

test("Y: the orchestrator and route source never reference a Combo writer", () => {
  const orchestratorSrc = readFileSync(
    new URL("../../src/lib/providerOnboarding/activationOrchestrator.ts", import.meta.url),
    "utf8"
  );
  const routeSrc = readFileSync(
    new URL("../../src/app/api/provider-observations/activate-model/route.ts", import.meta.url),
    "utf8"
  );
  for (const forbidden of ["createCombo", "updateCombo", "deleteCombo", "reorderCombos"]) {
    assert.equal(
      orchestratorSrc.includes(forbidden),
      false,
      `orchestrator must never call ${forbidden}`
    );
    assert.equal(routeSrc.includes(forbidden), false, `route must never call ${forbidden}`);
  }
});

test("Z: the orchestrator and route source never reference an inference endpoint literal", () => {
  const orchestratorSrc = readFileSync(
    new URL("../../src/lib/providerOnboarding/activationOrchestrator.ts", import.meta.url),
    "utf8"
  );
  const routeSrc = readFileSync(
    new URL("../../src/app/api/provider-observations/activate-model/route.ts", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    "chat/completions",
    "/messages",
    "/responses",
    "/embeddings",
    "/images",
    "/audio",
    "/rerank",
  ]) {
    assert.equal(
      orchestratorSrc.includes(forbidden),
      false,
      `orchestrator must never reference ${forbidden}`
    );
    assert.equal(routeSrc.includes(forbidden), false, `route must never reference ${forbidden}`);
  }
});
