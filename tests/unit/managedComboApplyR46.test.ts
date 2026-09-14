import test from "node:test";
import assert from "node:assert/strict";

import {
  computeEvidenceFingerprint,
  type ManagedComboBuildResult,
  type ManagedComboMember,
} from "../../src/lib/failover/managedComboDesiredState.ts";
import type { ReconciliationPlan } from "../../src/lib/failover/managedComboReconciliation.ts";
import {
  applyManagedComboReconciliation,
  type ManagedComboApplyDeps,
} from "../../src/lib/failover/managedComboApply.ts";
import { mapComboToCurrentComboState } from "../../src/lib/failover/shadowControlPlaneAdapter.ts";

const LOGICAL_ID = "jarvis-managed:free-coding";
const NAME = "jarvis-managed/free-coding";
const NOW = "2026-09-14T10:45:00.000Z";
const MEMBER: ManagedComboMember = {
  routeId: "openrouter/cohere/north-mini-code:free",
  providerId: "openrouter",
  connectionId: "conn-openrouter",
  model: "cohere/north-mini-code:free",
};
const FINGERPRINT = computeEvidenceFingerprint({
  members: [MEMBER],
  strategy: "priority",
  policyMode: "strict_zero_cost",
  config: {},
});

const DESIRED: ManagedComboBuildResult = {
  kind: "DESIRED",
  logicalId: LOGICAL_ID,
  activationRequiredCount: 0,
  blockedCount: 5,
  state: {
    logicalId: LOGICAL_ID,
    name: NAME,
    strategy: "priority",
    poolKind: "strictZeroCost",
    policyMode: "strict_zero_cost",
    members: [MEMBER],
    config: {},
    transientlySuppressed: [],
    evidenceFingerprint: FINGERPRINT,
    activationRequiredCount: 0,
    blockedCount: 5,
  },
};

function createPlan(overrides: Partial<ReconciliationPlan> = {}): ReconciliationPlan {
  return {
    action: "CREATE",
    blocked: false,
    blockedReason: null,
    logicalId: LOGICAL_ID,
    comboId: null,
    ownership: "unowned",
    beforeFingerprint: null,
    afterFingerprint: FINGERPRINT,
    membershipAdded: [MEMBER],
    membershipRemoved: [],
    strategyChanged: { from: null, to: "priority" },
    reasons: ["create"],
    ...overrides,
  };
}

function makeFakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  let creates = 0;
  let updates = 0;
  function normalize(data: Record<string, unknown>, id: string): Record<string, unknown> {
    const models = Array.isArray(data.models)
      ? data.models.map((raw) => {
          const step = { ...(raw as Record<string, unknown>) };
          if (typeof step.model === "string" && typeof step.providerId === "string") {
            if (!step.model.includes("/")) step.model = `${step.providerId}/${step.model}`;
            else if (!step.model.startsWith(`${step.providerId}/`)) {
              step.model = `${step.providerId}/${step.model}`;
            }
          }
          return step;
        })
      : data.models;
    return { ...data, id, ...(models ? { models } : {}) };
  }
  const deps: ManagedComboApplyDeps = {
    getComboByName: async (name) => [...rows.values()].find((row) => row.name === name) ?? null,
    getComboById: async (id) => rows.get(id) ?? null,
    createCombo: async (data) => {
      creates++;
      const row = normalize(data, `combo-${creates}`);
      rows.set(String(row.id), row);
      return row;
    },
    updateCombo: async (id, data) => {
      updates++;
      const current = rows.get(id);
      if (!current) return null;
      const row = normalize({ ...current, ...data }, id);
      rows.set(id, row);
      return row;
    },
  };
  return { rows, deps, counters: () => ({ creates, updates }) };
}

test("R4.6 A: CREATE writes native combo, ownership, and verifies normalized read-back", async () => {
  const db = makeFakeDb();
  const result = await applyManagedComboReconciliation({
    desired: DESIRED,
    plan: createPlan(),
    nowIso: NOW,
    deps: db.deps,
  });
  assert.equal(result.status, "APPLIED");
  assert.equal(db.counters().creates, 1);
  const row = await db.deps.getComboByName(NAME);
  assert.ok(row);
  const models = row.models as Array<Record<string, unknown>>;
  assert.equal(models[0].model, "openrouter/cohere/north-mini-code:free");
  const state = mapComboToCurrentComboState({
    id: String(row.id),
    name: String(row.name),
    strategy: String(row.strategy),
    models,
    config: row.config as Record<string, unknown>,
    isHidden: row.isHidden === true,
  });
  assert.equal(state.members[0].routeId, MEMBER.routeId);
  assert.equal(state.actualFingerprint, FINGERPRINT);
  assert.equal(state.ownership?.lastAppliedFingerprint, FINGERPRINT);
});

test("R4.6 B: stale or foreign UPDATE is fail-closed before any write", async () => {
  const db = makeFakeDb();
  const foreign = await db.deps.createCombo({
    name: NAME,
    strategy: "priority",
    models: [
      {
        kind: "model",
        model: MEMBER.model,
        providerId: MEMBER.providerId,
        connectionId: MEMBER.connectionId,
        weight: 100,
      },
    ],
    config: {},
  });
  const before = db.counters().updates;
  const result = await applyManagedComboReconciliation({
    desired: DESIRED,
    plan: createPlan({
      action: "UPDATE_SETTINGS",
      comboId: String(foreign.id),
      ownership: "jarvis-owned",
      beforeFingerprint: FINGERPRINT,
    }),
    nowIso: NOW,
    deps: db.deps,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["stale-or-unowned-current-state"]);
  assert.equal(db.counters().updates, before);
});

test("R4.6 C: DELETE_NOT_ALLOWED never invokes a writer", async () => {
  const db = makeFakeDb();
  const result = await applyManagedComboReconciliation({
    desired: DESIRED,
    plan: createPlan({ action: "DELETE_NOT_ALLOWED" }),
    nowIso: NOW,
    deps: db.deps,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["automatic-delete-forbidden"]);
  assert.deepEqual(db.counters(), { creates: 0, updates: 0 });
});

test("R4.6 D: managed combo can be disabled without deletion when no safe route remains", async () => {
  const db = makeFakeDb();
  const created = await applyManagedComboReconciliation({
    desired: DESIRED,
    plan: createPlan(),
    nowIso: NOW,
    deps: db.deps,
  });
  assert.equal(created.status, "APPLIED");
  assert.ok(created.comboId);
  const noSafe: ManagedComboBuildResult = {
    kind: "NO_SAFE_ROUTE",
    logicalId: LOGICAL_ID,
    activationRequiredCount: 0,
    blockedCount: 6,
  };
  const result = await applyManagedComboReconciliation({
    desired: noSafe,
    plan: createPlan({
      action: "DISABLE",
      comboId: created.comboId,
      ownership: "jarvis-owned",
      beforeFingerprint: FINGERPRINT,
      afterFingerprint: FINGERPRINT,
      membershipAdded: [],
      strategyChanged: null,
    }),
    nowIso: NOW,
    deps: db.deps,
  });
  assert.equal(result.status, "APPLIED");
  assert.equal((await db.deps.getComboById(created.comboId!))?.isHidden, true);
});
