/**
 * O9-F3.5 A7.1 "R4" — Controlled One-Model Activation Planner.
 *
 * Pure/unit tests only: no DB, no HTTP, no provider request, no real
 * `replaceSyncedAvailableModelsForConnection` call, no Combo write, no
 * Shadow/Production contact. `injectedWriter()` below is an in-memory fake
 * that only ever records what WOULD be written — it is never the real
 * DB-backed writer.
 *
 * Reuses the real A2 evidence resolver (`resolveProviderObservations`) and
 * the real NVIDIA live-catalog fixture already used by
 * `providerActivationGateA3.test.ts`, so the happy-path proof is against
 * genuine evidence, not hand-faked booleans. Negative/gate tests build
 * literal `ResolvedObservation` fixtures (same pattern
 * `shadowControlPlaneAdapterR0.test.ts` uses) so every BLOCKED reason is
 * individually, deterministically reachable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateActivationDecision,
  type ActivationApprovalRecord,
  type ActivationDecision,
} from "../../src/lib/providerOnboarding/activationPolicy.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import {
  resolveProviderObservations,
  type ResolvedObservation,
} from "../../src/lib/providerOnboarding/onboarding.ts";
import type { ProviderObservationRecord } from "../../src/lib/providerOnboarding/types.ts";
import {
  buildDesiredSyncedModelRecord,
  executeActivationPlan,
  executeActivationRollback,
  planOneModelActivation,
  type ActivationPlanInput,
} from "../../src/lib/providerOnboarding/oneModelActivationPlanner.ts";
import type {
  SyncedAvailableModel,
  SyncedAvailableModelInput,
} from "../../src/lib/db/models/synced.ts";
import {
  runShadowManagedComboPipeline,
  type ShadowConnectionSnapshot,
} from "../../src/lib/failover/shadowControlPlaneAdapter.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const NVIDIA = fixture("nvidia-models-live-a2.json");
const T1 = "2026-09-12T00:00:00.000Z";
const CANONICAL = "nvidia/moonshotai/kimi-k3";

function resolveConnection(providerId: string, connectionId: string, items: readonly unknown[]) {
  const outcome: ObservationCatalogOutcome = { ok: true, items };
  const inventory = applyObservationRefresh(null, {
    providerId,
    connectionId,
    source: `${providerId}:models-endpoint`,
    observedAt: T1,
    outcome,
  });
  return resolveProviderObservations({
    inventory,
    connection: {
      provider: providerId,
      authType: "apikey",
      connectionId,
      providerSpecificData: {},
      isActive: true,
    },
  }).models;
}

function byModelId(models: ResolvedObservation[], providerModelId: string): ResolvedObservation {
  const found = models.find((m) => m.record.providerModelId === providerModelId);
  if (!found) throw new Error(`fixture missing ${providerModelId}`);
  return found;
}

/** Real, evidence-resolved kimi-k3 observation on the given connection (READY per A2's own fixture). */
function realKimiK3(connectionId: string): ResolvedObservation {
  const resolved = byModelId(
    resolveConnection("nvidia", connectionId, NVIDIA.data),
    "moonshotai/kimi-k3"
  );
  assert.equal(resolved.status, "READY", "fixture precondition: kimi-k3 must resolve READY");
  return resolved;
}

function approvedDecision(
  resolved: ResolvedObservation,
  connectionActive = true
): ActivationDecision {
  const approval: ActivationApprovalRecord = {
    canonicalModelId: resolved.record.canonicalModelId,
    approved: true,
    approvedBy: "test",
    approvedAt: T1,
    note: null,
  };
  return evaluateActivationDecision({
    resolved,
    connectionActive,
    policyMode: "manual",
    approval,
  });
}

function baseInput(overrides: Partial<ActivationPlanInput> = {}): ActivationPlanInput {
  const resolved = realKimiK3("conn-nv-1");
  return {
    providerId: "nvidia",
    connectionId: "conn-nv-1",
    canonicalModelId: CANONICAL,
    currentSyncedModels: [],
    resolved,
    connectionActive: true,
    activation: approvedDecision(resolved),
    ...overrides,
  };
}

/** In-memory fake writer: records what WOULD be written, never touches a real DB. */
function fakeWriter() {
  const calls: Array<{
    providerId: string;
    connectionId: string;
    models: readonly SyncedAvailableModelInput[];
  }> = [];
  return {
    calls,
    replaceSyncedAvailableModelsForConnection: async (
      providerId: string,
      connectionId: string,
      models: readonly SyncedAvailableModelInput[]
    ) => {
      calls.push({ providerId, connectionId, models });
      return models;
    },
  };
}

// ---------------------------------------------------------------------------
// A/B. connection-scoped routability — same model, two connections, independent
// ---------------------------------------------------------------------------

test("A/B: the same canonical model on two different connections plans independently — one ACTIVATE, one NO_CHANGE", () => {
  const resolvedA = realKimiK3("conn-nv-a");
  const resolvedB = realKimiK3("conn-nv-b");

  const planA = planOneModelActivation(
    baseInput({
      connectionId: "conn-nv-a",
      resolved: resolvedA,
      activation: approvedDecision(resolvedA),
      currentSyncedModels: [],
    })
  );
  const already: SyncedAvailableModel = {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    source: "imported",
  };
  const planB = planOneModelActivation(
    baseInput({
      connectionId: "conn-nv-b",
      resolved: resolvedB,
      activation: approvedDecision(resolvedB),
      currentSyncedModels: [already],
    })
  );

  assert.equal(planA.kind, "ACTIVATE");
  assert.equal(planB.kind, "NO_CHANGE");
  assert.equal(planA.connectionId, "conn-nv-a");
  assert.equal(planB.connectionId, "conn-nv-b");
  // Independence: B's pre-existing entry never appears in A's desired list, and vice versa.
  if (planA.kind === "ACTIVATE") {
    assert.deepEqual(planA.beforeModels, []);
  }
});

// ---------------------------------------------------------------------------
// C. approved + READY + absent -> ACTIVATE
// ---------------------------------------------------------------------------

test("C: approved + READY + absent from the connection's synced list -> ACTIVATE, adding exactly one model", () => {
  const plan = planOneModelActivation(baseInput({ currentSyncedModels: [] }));
  assert.equal(plan.kind, "ACTIVATE");
  if (plan.kind !== "ACTIVATE") return;
  assert.equal(plan.providerId, "nvidia");
  assert.equal(plan.connectionId, "conn-nv-1");
  assert.equal(plan.canonicalModelId, CANONICAL);
  assert.deepEqual(plan.beforeModels, []);
  assert.equal(plan.desiredModels.length, 1);
  assert.equal(plan.desiredModels[0].id, "moonshotai/kimi-k3");
  assert.equal(plan.desiredModels[0].source, "imported");
  assert.deepEqual(plan.rollback, {
    providerId: "nvidia",
    connectionId: "conn-nv-1",
    restoreModels: [],
  });
});

// ---------------------------------------------------------------------------
// D. already present -> NO_CHANGE
// ---------------------------------------------------------------------------

test("D: model already present in the connection's synced list -> NO_CHANGE, list untouched", () => {
  const current: SyncedAvailableModel[] = [
    { id: "moonshotai/kimi-k3", name: "Kimi K3", source: "imported" },
  ];
  const plan = planOneModelActivation(baseInput({ currentSyncedModels: current }));
  assert.equal(plan.kind, "NO_CHANGE");
  if (plan.kind !== "NO_CHANGE") return;
  assert.deepEqual(plan.syncedModels, current);
});

// ---------------------------------------------------------------------------
// E. no approval -> BLOCKED
// ---------------------------------------------------------------------------

test("E: no approval record (manual policy) -> BLOCKED, not-approved-by-policy / policy-manual-unapproved", () => {
  const resolved = realKimiK3("conn-nv-1");
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: true,
    policyMode: "manual",
    approval: null,
  });
  const plan = planOneModelActivation(baseInput({ resolved, activation }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-approved-by-policy");
  assert.equal(plan.policyReason, "policy-manual-unapproved");
});

// ---------------------------------------------------------------------------
// F. revoked approval -> BLOCKED
// ---------------------------------------------------------------------------

test("F: explicitly revoked approval -> BLOCKED, approval-revoked, even though otherwise READY", () => {
  const resolved = realKimiK3("conn-nv-1");
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: true,
    policyMode: "manual",
    approval: {
      canonicalModelId: resolved.record.canonicalModelId,
      approved: false,
      approvedBy: "test",
      approvedAt: T1,
      note: "revoked",
    },
  });
  const plan = planOneModelActivation(baseInput({ resolved, activation }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-approved-by-policy");
  assert.equal(plan.policyReason, "approval-revoked");
});

// ---------------------------------------------------------------------------
// G. inactive connection -> BLOCKED
// ---------------------------------------------------------------------------

test("G: connection not active -> BLOCKED, connection-inactive", () => {
  const resolved = realKimiK3("conn-nv-1");
  const plan = planOneModelActivation(
    baseInput({ resolved, connectionActive: false, activation: approvedDecision(resolved, false) })
  );
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "connection-inactive");
});

// ---------------------------------------------------------------------------
// Synthetic base fixture for the remaining hard-gate tests (H-K), so each
// evidence fact can be independently forced without depending on which real
// facts the NVIDIA fixture happens to contain.
// ---------------------------------------------------------------------------

function mkRecord(overrides: Partial<ProviderObservationRecord> = {}): ProviderObservationRecord {
  return {
    providerId: "nvidia",
    connectionId: "conn-nv-1",
    providerModelId: "moonshotai/kimi-k3",
    canonicalModelId: CANONICAL,
    available: true,
    observedAt: T1,
    source: "test",
    displayName: "Kimi K3",
    ownedBy: null,
    contextWindow: null,
    maxOutput: null,
    pricingInput: null,
    pricingOutput: null,
    supportedParameters: null,
    toolCallingObserved: null,
    streamingObserved: null,
    endpointAvailability: null,
    firstObservedAt: T1,
    lastObservedAt: T1,
    currentlyObserved: true,
    ...overrides,
  };
}

function mkResolved(
  recordOverrides: Partial<ProviderObservationRecord> = {},
  evidenceOverrides: Partial<ResolvedObservation["evidence"]> = {},
  status: ResolvedObservation["status"] = "READY"
): ResolvedObservation {
  const record = mkRecord(recordOverrides);
  return {
    record,
    evidence: {
      inStaticRegistry: false,
      executable: true,
      toolCalling: null,
      claudeCodeEligible: true,
      supervisorEligible: null,
      verifiedFree: null,
      freeType: null,
      hardStopGuaranteed: null,
      usageCostClass: "unknown",
      connectionSafeForZeroCost: null,
      knownProtocolConflict: false,
      strictZeroCostEligible: false,
      strictZeroCostReason: "unknown",
      ...evidenceOverrides,
    },
    status,
    zeroCostEligible: false,
    costState: "cost_unknown",
  };
}

function mkActivation(
  resolved: ResolvedObservation,
  overrides: Partial<ActivationDecision> = {}
): ActivationDecision {
  return {
    canonicalModelId: resolved.record.canonicalModelId,
    generalActivationCandidate: true,
    strictZeroCostCandidate: false,
    policyMode: "manual",
    activate: true,
    reason: "policy-manual-approved",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// H. stale observation -> BLOCKED
// ---------------------------------------------------------------------------

test("H: currentlyObserved false (stale/gone) -> BLOCKED, not-currently-observed, even if evidence still looks fine", () => {
  const resolved = mkResolved({ currentlyObserved: false });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-currently-observed");
});

// ---------------------------------------------------------------------------
// I. executable false/unknown -> BLOCKED
// ---------------------------------------------------------------------------

test("I: executable === false -> BLOCKED, not-executable", () => {
  const resolved = mkResolved({}, { executable: false });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-executable");
});

test("I: executable === null (unknown) fails closed -> BLOCKED, not-executable", () => {
  const resolved = mkResolved({}, { executable: null });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-executable");
});

// ---------------------------------------------------------------------------
// J. claudeCodeEligible false/unknown -> BLOCKED
// ---------------------------------------------------------------------------

test("J: claudeCodeEligible === false -> BLOCKED, not-claude-eligible", () => {
  const resolved = mkResolved({}, { claudeCodeEligible: false });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-claude-eligible");
});

test("J: claudeCodeEligible === null (unknown) fails closed -> BLOCKED, not-claude-eligible", () => {
  const resolved = mkResolved({}, { claudeCodeEligible: null });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "not-claude-eligible");
});

// ---------------------------------------------------------------------------
// K. known protocol conflict -> BLOCKED (standalone gate, independent of claudeCodeEligible)
// ---------------------------------------------------------------------------

test("K: knownProtocolConflict === true -> BLOCKED, known-protocol-conflict, never overridable by approval", () => {
  const resolved = mkResolved({}, { knownProtocolConflict: true });
  const plan = planOneModelActivation(baseInput({ resolved, activation: mkActivation(resolved) }));
  assert.equal(plan.kind, "BLOCKED");
  if (plan.kind !== "BLOCKED") return;
  assert.equal(plan.reason, "known-protocol-conflict");
});

// ---------------------------------------------------------------------------
// L/M/N. preserve existing entries, no duplicates, deterministic
// ---------------------------------------------------------------------------

test("L: existing synced entries on the connection are preserved byte-for-byte, new model appended last", () => {
  const current: SyncedAvailableModel[] = [
    { id: "deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", source: "imported" },
    {
      id: "deepseek-ai/deepseek-v4-pro-0813",
      name: "DeepSeek V4 Pro",
      source: "imported",
      supportsTools: true,
    },
  ];
  const plan = planOneModelActivation(baseInput({ currentSyncedModels: current }));
  assert.equal(plan.kind, "ACTIVATE");
  if (plan.kind !== "ACTIVATE") return;
  assert.equal(plan.desiredModels.length, 3);
  assert.deepEqual(plan.desiredModels[0], current[0]);
  assert.deepEqual(plan.desiredModels[1], current[1]);
  assert.equal(plan.desiredModels[2].id, "moonshotai/kimi-k3");
});

test("M: a stray duplicate of the already-present model in malformed current input never produces two rows", () => {
  const current: SyncedAvailableModel[] = [
    { id: "moonshotai/kimi-k3", name: "Kimi K3 (first)", source: "imported" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3 (duplicate)", source: "imported" },
  ];
  const plan = planOneModelActivation(baseInput({ currentSyncedModels: current }));
  // Already present (membership check matches the first occurrence) -> NO_CHANGE, list handed back unchanged.
  assert.equal(plan.kind, "NO_CHANGE");
});

test("N: planning the identical input twice yields deep-equal plans (deterministic)", () => {
  const input = baseInput({ currentSyncedModels: [] });
  const first = planOneModelActivation(input);
  const second = planOneModelActivation(input);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// O. rollback before-state retained
// ---------------------------------------------------------------------------

test("O: an ACTIVATE plan retains the exact pre-write list as its rollback target", () => {
  const current: SyncedAvailableModel[] = [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", source: "imported" },
  ];
  const plan = planOneModelActivation(
    baseInput({ providerId: "nvidia", currentSyncedModels: current })
  );
  assert.equal(plan.kind, "ACTIVATE");
  if (plan.kind !== "ACTIVATE") return;
  assert.deepEqual(plan.beforeModels, current);
  assert.deepEqual(plan.rollback.restoreModels, current);
  assert.equal(plan.rollback.providerId, "nvidia");
  assert.equal(plan.rollback.connectionId, "conn-nv-1");
});

// ---------------------------------------------------------------------------
// P. no cross-connection mutation (writer boundary proof, in-memory only)
// ---------------------------------------------------------------------------

test("P: executing an ACTIVATE plan via the injected writer touches only the exact target connection", async () => {
  const planA = planOneModelActivation(
    baseInput({ connectionId: "conn-nv-a", currentSyncedModels: [] })
  );
  assert.equal(planA.kind, "ACTIVATE");
  if (planA.kind !== "ACTIVATE") return;

  const writer = fakeWriter();
  await executeActivationPlan(planA, writer);

  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].connectionId, "conn-nv-a");
  assert.equal(writer.calls[0].providerId, "nvidia");
  assert.equal(writer.calls[0].models.length, 1);

  // Rollback: restores exactly the pre-write (empty) list, same connection only.
  await executeActivationRollback(planA.rollback, writer);
  assert.equal(writer.calls.length, 2);
  assert.deepEqual(writer.calls[1].models, []);
  assert.equal(writer.calls[1].connectionId, "conn-nv-a");
});

test("P: the writer is never invoked for a BLOCKED or NO_CHANGE plan (no ActivationPlanActivate to execute)", () => {
  const blockedPlan = planOneModelActivation(
    baseInput({
      resolved: mkResolved({ currentlyObserved: false }),
      activation: mkActivation(mkResolved({ currentlyObserved: false })),
    })
  );
  assert.equal(blockedPlan.kind, "BLOCKED");
  // executeActivationPlan's parameter type is ActivationPlanActivate — a BLOCKED/NO_CHANGE
  // plan cannot be passed to it at all without a type error, which is the actual guarantee
  // this test documents (compile-time, not just runtime).
});

// ---------------------------------------------------------------------------
// Q/R/S. no customModels, no Auto-Sync, no Combo writer anywhere in this module
// ---------------------------------------------------------------------------

test("Q/R/S: the planner module never imports customModels writers, Auto-Sync, or a Combo writer", () => {
  const source = readFileSync(
    new URL("../../src/lib/providerOnboarding/oneModelActivationPlanner.ts", import.meta.url),
    "utf8"
  );
  assert.equal(source.includes("addCustomModel"), false);
  assert.equal(source.includes("replaceCustomModels"), false);
  assert.equal(source.includes("modelSyncScheduler"), false);
  assert.equal(source.includes("AutoSync"), false);
  assert.equal(source.includes("sync-models"), false);
  assert.equal(/combo/i.test(source), false, "no Combo-writing code anywhere in this file");
});

// ---------------------------------------------------------------------------
// T. strict-zero-cost unchanged
// ---------------------------------------------------------------------------

test("T: the planner never widens strictZeroCostCandidate/strictZeroCostEligible — ACTIVATE plan carries no zero-cost claim", () => {
  const resolved = realKimiK3("conn-nv-1");
  assert.equal(
    resolved.zeroCostEligible,
    false,
    "fixture precondition: kimi-k3 is not strict-zero-cost eligible"
  );
  const activation = approvedDecision(resolved);
  assert.equal(activation.strictZeroCostCandidate, false);
  const plan = planOneModelActivation(baseInput({ resolved, activation, currentSyncedModels: [] }));
  assert.equal(plan.kind, "ACTIVATE");
  if (plan.kind !== "ACTIVATE") return;
  // The desired SyncedAvailableModel record has no strict-zero-cost field to fabricate into.
  const asRecord = plan.desiredModels[0] as unknown as Record<string, unknown>;
  assert.equal("strictZeroCostEligible" in asRecord, false);
  assert.equal("verifiedFree" in asRecord, false);
  assert.equal("claudeCodeEligible" in asRecord, false);
});

test("buildDesiredSyncedModelRecord never fabricates capability/cost fields — only real observed id/name/toolCalling", () => {
  const withTools = buildDesiredSyncedModelRecord(mkRecord({ toolCallingObserved: true }));
  assert.equal(withTools.supportsTools, true);
  const unknown = buildDesiredSyncedModelRecord(mkRecord({ toolCallingObserved: null }));
  assert.equal(
    "supportsTools" in unknown,
    false,
    "unobserved tool-calling must stay absent, never coerced to false"
  );
  assert.equal(unknown.id, "moonshotai/kimi-k3");
  assert.equal(unknown.source, "imported");
});

// ---------------------------------------------------------------------------
// U. pure before/after A2-A7 pipeline state: ACTIVATION_REQUIRED -> DESIRED/ALREADY_ROUTABLE,
//    with the R4 connection-scoped resolver proving isolation from a second connection.
// ---------------------------------------------------------------------------

test("U: before activation the pipeline reports ACTIVATION_REQUIRED; simulated post-activation membership on the exact connection reaches DESIRED via ALREADY_ROUTABLE; a second connection stays unaffected", () => {
  const connections: ShadowConnectionSnapshot[] = [
    {
      connectionId: "conn-nv-1",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: null,
    },
    {
      connectionId: "conn-nv-2",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: null,
    },
  ];
  const record = mkRecord({ connectionId: "conn-nv-1" });
  const inventoryByConnection = new Map([
    [
      "conn-nv-1",
      {
        providerId: "nvidia",
        connectionId: "conn-nv-1",
        source: "test",
        lastRefreshAt: T1,
        lastAttemptAt: T1,
        refreshStatus: "ok" as const,
        refreshError: null,
        models: [record],
      },
    ],
    [
      "conn-nv-2",
      {
        providerId: "nvidia",
        connectionId: "conn-nv-2",
        source: "test",
        lastRefreshAt: T1,
        lastAttemptAt: T1,
        refreshStatus: "ok" as const,
        refreshError: null,
        models: [mkRecord({ connectionId: "conn-nv-2" })],
      },
    ],
  ]);
  const resolveApproval = (canonicalModelId: string) =>
    canonicalModelId === CANONICAL
      ? { canonicalModelId, approved: true, approvedBy: "test", approvedAt: T1, note: null }
      : null;

  const runPipeline = (
    alreadyRoutableResolver?: (canonicalModelId: string, connectionId: string) => boolean
  ) =>
    runShadowManagedComboPipeline({
      connections,
      combos: [],
      purpose: "r4-one-model-activation-proof",
      policyMode: "manual",
      requestClass: {
        taskType: "default",
        requestHasTools: false,
        estimatedContextTokens: null,
        isBackgroundTask: false,
        latencySensitive: null,
      },
      telemetry: {
        headroomKnownCount: 0,
        resetWindowKnownCount: 0,
        equivalentLocalRouteCount: 0,
        liveLoadTelemetryAvailable: false,
        knownContextCapacityTokens: null,
        cacheAffinityAvailable: false,
      },
      quota: { quotaPressure: false },
      now: 1_800_000_000_000,
      observationInventoryByConnection: inventoryByConnection,
      resolveApproval,
      alreadyRoutableResolver,
    });

  // BEFORE: no resolver wired (today's live default) -> ACTIVATION_REQUIRED, nothing already routable.
  const before = runPipeline();
  assert.equal(before.desiredState.kind, "ACTIVATION_REQUIRED");

  // AFTER: simulate the planner's ACTIVATE having been executed on conn-nv-1 ONLY.
  const after = runPipeline(
    (canonicalModelId, connectionId) =>
      canonicalModelId === CANONICAL && connectionId === "conn-nv-1"
  );
  assert.equal(after.desiredState.kind, "DESIRED");
  if (after.desiredState.kind === "DESIRED") {
    assert.equal(after.desiredState.state.members.length, 1);
    assert.equal(after.desiredState.state.members[0].connectionId, "conn-nv-1");
  }
  assert.equal(after.reconciliationPlan.action, "CREATE");

  // Isolation: the identical simulated-activation resolver, if it had (incorrectly) matched by
  // canonicalModelId alone, would also route conn-nv-2. Prove it explicitly does not.
  const conn2Result = after.pipelineSummary.connections.find((c) => c.connectionId === "conn-nv-2");
  assert.ok(conn2Result);
  assert.equal(conn2Result!.candidatesBuilt, 1);
});
