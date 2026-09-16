import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJarvisAutoDesiredState,
  fingerprintJarvisAutoCurrent,
  JARVIS_AUTO_COMBO_NAME,
  JARVIS_AUTO_STRICT_CHILD,
  parseJarvisAutoFallbackRoute,
} from "../../src/lib/failover/jarvisAutoSupervisorCore.ts";
import {
  reconcileJarvisAutoSupervisor,
  type JarvisAutoSupervisorDeps,
} from "../../src/lib/failover/jarvisAutoSupervisor.ts";

function fakeDb(initial: Record<string, unknown>[] = [], settings: Record<string, unknown> = {}) {
  const rows = new Map(initial.map((row) => [String(row.id), { ...row }]));
  let creates = 0;
  let updates = 0;
  const deps: JarvisAutoSupervisorDeps = {
    getComboByName: async (name) => [...rows.values()].find((row) => row.name === name) ?? null,
    getComboById: async (id) => rows.get(id) ?? null,
    createCombo: async (data) => {
      creates++;
      const row = { ...data, id: `auto-${creates}` };
      rows.set(String(row.id), row);
      return row;
    },
    updateCombo: async (id, data) => {
      updates++;
      const before = rows.get(id);
      if (!before) return null;
      const row = { ...before, ...data, id };
      rows.set(id, row);
      return row;
    },
    getSettings: async () => ({ ...settings }),
  };
  return { rows, deps, counts: () => ({ creates, updates }) };
}

const CHILD = { id: "managed-1", name: JARVIS_AUTO_STRICT_CHILD, isHidden: false };

test("R4.8 A: fallback route parsing is provider-agnostic", () => {
  assert.deepEqual(parseJarvisAutoFallbackRoute("brand-new-provider/code/model"), {
    routeId: "brand-new-provider/code/model",
    providerId: "brand-new-provider",
  });
  assert.equal(parseJarvisAutoFallbackRoute("invalid"), null);
});

test("R4.8 B: desired supervisor nests dynamic managed pool before generic fallback", () => {
  const fallback = parseJarvisAutoFallbackRoute("future-provider/future-code");
  const desired = buildJarvisAutoDesiredState({
    strictChildEnabled: true,
    subscriptionEnabled: true,
    thriftyEnabled: false,
    fallback,
  });
  assert.ok(desired);
  assert.equal(desired?.name, JARVIS_AUTO_COMBO_NAME);
  assert.equal(desired?.strategy, "priority");
  assert.equal(desired?.config.nestedComboMode, "execute");
  assert.deepEqual(
    desired?.models.map((m) => m.kind),
    ["combo-ref", "model", "model"]
  );
  assert.equal(desired?.models[0]?.comboName, JARVIS_AUTO_STRICT_CHILD);
  assert.equal(desired?.models[1]?.providerId, "future-provider");
  assert.equal(desired?.models[2]?.model, "auto/subscription");
});

test("R4.8 C: CREATE is verified and repeated reconciliation is idempotent", async () => {
  const db = fakeDb([CHILD]);
  const first = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", nowIso: "2026-09-14T13:00:00Z" },
    db.deps
  );
  assert.equal(first.status, "APPLIED");
  assert.equal(first.action, "CREATE");
  const row = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  assert.ok(row);
  assert.equal(fingerprintJarvisAutoCurrent(row!), first.fingerprint);

  const second = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", nowIso: "2026-09-14T13:10:00Z" },
    db.deps
  );
  assert.equal(second.status, "NO_CHANGE");
  assert.deepEqual(db.counts(), { creates: 1, updates: 0 });
});

test("R4.8 D: foreign jarvis-auto collision is fail-closed", async () => {
  const db = fakeDb([
    CHILD,
    { id: "foreign", name: JARVIS_AUTO_COMBO_NAME, strategy: "priority", models: [], config: {} },
  ]);
  const result = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code" },
    db.deps
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["foreign-combo-name-collision"]);
  assert.deepEqual(db.counts(), { creates: 0, updates: 0 });
});

test("R4.8 E: hidden strict child yields fallback-only supervisor and updates on recovery", async () => {
  const hiddenChild = { ...CHILD, isHidden: true };
  const db = fakeDb([hiddenChild]);
  const first = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", nowIso: "2026-09-14T13:00:00Z" },
    db.deps
  );
  assert.equal(first.status, "APPLIED");
  const row1 = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  assert.equal((row1?.models as Array<Record<string, unknown>>).length, 2);

  db.rows.set("managed-1", { ...CHILD });
  const second = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", nowIso: "2026-09-14T13:10:00Z" },
    db.deps
  );
  assert.equal(second.status, "APPLIED");
  assert.equal(second.action, "UPDATE");
  const row2 = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  assert.deepEqual(
    (row2?.models as Array<Record<string, unknown>>).map((m) => m.kind),
    ["combo-ref", "model", "model"]
  );
});

test("R4.8 F: paid escalation stays disabled without an explicit positive budget", async () => {
  const db = fakeDb([CHILD], { subscriptionLadder: { rungBudgetUsd: { cheap: 0, premium: 0 } } });
  const result = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", paidRoutingEnabled: true },
    db.deps
  );
  assert.equal(result.status, "APPLIED");
  const row = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  const models = row?.models as Array<Record<string, unknown>>;
  assert.equal(
    models.some((m) => m.id === "jarvis-auto-budgeted-paid"),
    false
  );
});

test("R4.8 F2: a missing sibling paid budget keeps escalation disabled", async () => {
  const db = fakeDb([CHILD], { subscriptionLadder: { rungBudgetUsd: { cheap: 5 } } });
  const result = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", paidRoutingEnabled: true },
    db.deps
  );
  assert.equal(result.status, "APPLIED");
  const row = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  const models = row?.models as Array<Record<string, unknown>>;
  assert.equal(
    models.some((m) => m.id === "jarvis-auto-budgeted-paid"),
    false
  );
});

test("R4.8 G: paid escalation requires opt-in and a positive cheap/premium budget", async () => {
  const db = fakeDb([CHILD], { subscriptionLadder: { rungBudgetUsd: { cheap: 5, premium: 0 } } });
  const result = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "future-provider/future-code", paidRoutingEnabled: true },
    db.deps
  );
  assert.equal(result.status, "APPLIED");
  const row = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  const models = row?.models as Array<Record<string, unknown>>;
  const paid = models.find((m) => m.id === "jarvis-auto-budgeted-paid");
  assert.equal(paid?.model, "auto/thrifty");
  const config = row?.config as Record<string, unknown> | undefined;
  const owner = config?.jarvisAuto as Record<string, unknown> | undefined;
  assert.equal(owner?.costPolicy, "strict-free>verified-zero>subscription>budgeted-paid");
});

test("R4.8 H: schema-v1 production supervisor migrates without false operator drift", async () => {
  const old = {
    id: "old-auto",
    name: JARVIS_AUTO_COMBO_NAME,
    strategy: "priority",
    models: [
      {
        id: "jarvis-auto-strict-free",
        kind: "combo-ref",
        comboName: JARVIS_AUTO_STRICT_CHILD,
        weight: 100,
      },
      {
        id: "jarvis-auto-verified-fallback",
        kind: "model",
        model: "gemini/gemini-3.1-flash-lite",
        providerId: "gemini",
        weight: 0,
      },
    ],
    config: {
      nestedComboMode: "execute",
      jarvisAuto: {
        schemaVersion: 1,
        logicalId: JARVIS_AUTO_COMBO_NAME,
        lastAppliedFingerprint: "182e2a20",
        lastAppliedAt: "2026-09-15T22:57:12.593Z",
      },
    },
    isHidden: false,
  };
  assert.equal(fingerprintJarvisAutoCurrent(old), "182e2a20");
  const db = fakeDb([CHILD, old]);
  const result = await reconcileJarvisAutoSupervisor(
    { fallbackRoute: "gemini/gemini-3.1-flash-lite", subscriptionEnabled: true },
    db.deps
  );
  assert.equal(result.status, "APPLIED");
  assert.equal(result.action, "UPDATE");
  const row = await db.deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  const config = row?.config as Record<string, unknown> | undefined;
  const owner = config?.jarvisAuto as Record<string, unknown> | undefined;
  assert.equal(owner?.schemaVersion, 2);
});
