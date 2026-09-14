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

function fakeDb(initial: Record<string, unknown>[] = []) {
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
  const desired = buildJarvisAutoDesiredState({ strictChildEnabled: true, fallback });
  assert.ok(desired);
  assert.equal(desired?.name, JARVIS_AUTO_COMBO_NAME);
  assert.equal(desired?.strategy, "priority");
  assert.equal(desired?.config.nestedComboMode, "execute");
  assert.deepEqual(
    desired?.models.map((m) => m.kind),
    ["combo-ref", "model"]
  );
  assert.equal(desired?.models[0]?.comboName, JARVIS_AUTO_STRICT_CHILD);
  assert.equal(desired?.models[1]?.providerId, "future-provider");
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
  assert.equal((row1?.models as Array<Record<string, unknown>>).length, 1);

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
    ["combo-ref", "model"]
  );
});
