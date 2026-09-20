/**
 * O9-F3.5 A7.1 "R4" — writer-boundary integration proof.
 *
 * Proves `executeActivationPlan`/`executeActivationRollback`, when injected
 * with the REAL `replaceSyncedAvailableModelsForConnection` (never a fake),
 * write and roll back correctly end-to-end. Runs against an isolated,
 * throwaway temp-directory SQLite DB (`DATA_DIR` below) — NEVER Shadow's or
 * Production's database. Same isolated-DATA_DIR pattern as
 * `observationAuthBoundaryR22.test.ts`. DB handle closed in `test.after`.
 *
 * This file requires a real `better-sqlite3` binding (see R2.3's Node-version
 * note); it is intentionally separate from `oneModelActivationPlannerR4.test.ts`
 * so the purely-in-memory planner tests never pay the DB-setup cost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-r4-writer-boundary-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const models = await import("../../src/lib/db/models.ts");
const approvals = await import("../../src/lib/db/providerActivationApprovals.ts");
const { evaluateActivationDecision } =
  await import("../../src/lib/providerOnboarding/activationPolicy.ts");
const { applyObservationRefresh } = await import("../../src/lib/providerOnboarding/catalog.ts");
const { resolveProviderObservations } =
  await import("../../src/lib/providerOnboarding/onboarding.ts");
const { planOneModelActivation, executeActivationPlan, executeActivationRollback } =
  await import("../../src/lib/providerOnboarding/oneModelActivationPlanner.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

const PROVIDER_ID = "nvidia";
const CONNECTION_ID = "conn-nv-writer-boundary";
const CANONICAL = `${PROVIDER_ID}/moonshotai/kimi-k3`;
const T1 = "2026-09-01T00:00:00.000Z";

test("R4 writer boundary: real DB — seed unrelated model, ACTIVATE adds exactly one, preserves the seed, then rollback restores the exact original list", async () => {
  // Seed: one unrelated pre-existing synced model on this exact connection —
  // the write must preserve it untouched.
  const seeded = await models.replaceSyncedAvailableModelsForConnection(
    PROVIDER_ID,
    CONNECTION_ID,
    [{ id: "deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" }]
  );
  assert.equal(seeded.length, 1);

  const before = await models.getSyncedAvailableModelsForConnection(PROVIDER_ID, CONNECTION_ID);
  assert.equal(before.length, 1);
  assert.equal(before[0].id, "deepseek-ai/deepseek-v4-flash-0731");

  // Real approval store — same one A3 reads, never a second approval mechanism.
  assert.equal(approvals.getActivationApproval(CONNECTION_ID, CANONICAL), null);
  approvals.setActivationApproval(CONNECTION_ID, {
    canonicalModelId: CANONICAL,
    approved: true,
    approvedBy: "test",
    approvedAt: T1,
    note: null,
  });
  const approval = approvals.getActivationApproval(CONNECTION_ID, CANONICAL);
  assert.ok(approval);

  const inventory = applyObservationRefresh(null, {
    providerId: PROVIDER_ID,
    connectionId: CONNECTION_ID,
    source: "test",
    observedAt: T1,
    outcome: { ok: true, items: [{ id: "moonshotai/kimi-k3", name: "Kimi K3" }] },
  });
  const resolved = resolveProviderObservations({
    inventory,
    connection: {
      provider: PROVIDER_ID,
      authType: "apikey",
      connectionId: CONNECTION_ID,
      providerSpecificData: {},
      isActive: true,
    },
  }).models.find((m) => m.record.providerModelId === "moonshotai/kimi-k3");
  assert.ok(resolved);
  assert.equal(resolved!.status, "READY");

  const activation = evaluateActivationDecision({
    resolved: resolved!,
    connectionActive: true,
    policyMode: "manual",
    approval,
  });
  assert.equal(activation.activate, true);

  const plan = planOneModelActivation({
    providerId: PROVIDER_ID,
    connectionId: CONNECTION_ID,
    canonicalModelId: CANONICAL,
    currentSyncedModels: before,
    resolved: resolved!,
    connectionActive: true,
    activation,
  });
  assert.equal(plan.kind, "ACTIVATE");
  if (plan.kind !== "ACTIVATE") return;

  const writer = {
    replaceSyncedAvailableModelsForConnection: models.replaceSyncedAvailableModelsForConnection,
  };
  await executeActivationPlan(plan, writer);

  const after = await models.getSyncedAvailableModelsForConnection(PROVIDER_ID, CONNECTION_ID);
  assert.equal(after.length, 2);
  assert.ok(
    after.some((m) => m.id === "deepseek-ai/deepseek-v4-flash-0731"),
    "seed model preserved"
  );
  assert.ok(
    after.some((m) => m.id === "moonshotai/kimi-k3"),
    "target model activated"
  );

  // Idempotency: planning again against the real post-write state -> NO_CHANGE.
  const secondPlan = planOneModelActivation({
    providerId: PROVIDER_ID,
    connectionId: CONNECTION_ID,
    canonicalModelId: CANONICAL,
    currentSyncedModels: after,
    resolved: resolved!,
    connectionActive: true,
    activation,
  });
  assert.equal(secondPlan.kind, "NO_CHANGE");

  // Rollback: restores the exact original (pre-activation) list.
  await executeActivationRollback(plan.rollback, writer);
  const rolledBack = await models.getSyncedAvailableModelsForConnection(PROVIDER_ID, CONNECTION_ID);
  assert.equal(rolledBack.length, 1);
  assert.equal(rolledBack[0].id, "deepseek-ai/deepseek-v4-flash-0731");

  // Revocation: real approval store round-trip, never a second store.
  approvals.setActivationApproval(CONNECTION_ID, {
    canonicalModelId: CANONICAL,
    approved: false,
    approvedBy: "test",
    approvedAt: T1,
    note: "revoked for test",
  });
  assert.equal(approvals.getActivationApproval(CONNECTION_ID, CANONICAL)?.approved, false);
});
