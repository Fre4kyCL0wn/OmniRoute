import test from "node:test";
import assert from "node:assert/strict";

import {
  selectAvailabilitySweepTargets,
  type AvailabilitySweepCandidate,
} from "../../src/lib/modelAvailability/sweepBudget.ts";

function candidates(
  connectionId: string,
  providerId: string,
  count: number,
  prefix = "m"
): AvailabilitySweepCandidate[] {
  return Array.from({ length: count }, (_unused, index) => ({
    providerId,
    connectionId,
    modelId: `${prefix}${index + 1}`,
  }));
}

test("sweep budget: one cap covers both probe kinds", () => {
  const selected = selectAvailabilitySweepTargets({
    maxPerRun: 3,
    due: candidates("c1", "openrouter", 5, "due"),
    discovery: candidates("c1", "openrouter", 5, "new"),
  });
  // The operator was promised 3 upstream requests per tick, not 3 + 3.
  assert.equal(selected.length, 3);
});

test("sweep budget: neither kind can starve the other", () => {
  const selected = selectAvailabilitySweepTargets({
    maxPerRun: 4,
    due: candidates("c1", "openrouter", 20, "due"),
    discovery: candidates("c1", "openrouter", 20, "new"),
  });
  const bySource = selected.reduce<Record<string, number>>((acc, target) => {
    acc[target.source] = (acc[target.source] ?? 0) + 1;
    return acc;
  }, {});
  // Without the reserved half, 20 due models would consume every slot and the
  // provider page would show UNTESTED forever.
  assert.deepEqual(bySource, { reprobe: 2, batch_test: 2 });
});

test("sweep budget: unused capacity flows to the side that can use it", () => {
  const onlyDue = selectAvailabilitySweepTargets({
    maxPerRun: 4,
    due: candidates("c1", "openrouter", 10, "due"),
    discovery: [],
  });
  assert.equal(onlyDue.length, 4);
  assert.ok(onlyDue.every((target) => target.source === "reprobe"));

  const onlyDiscovery = selectAvailabilitySweepTargets({
    maxPerRun: 4,
    due: [],
    discovery: candidates("c1", "openrouter", 10, "new"),
  });
  assert.equal(onlyDiscovery.length, 4);
  assert.ok(onlyDiscovery.every((target) => target.source === "batch_test"));

  // Partial: 1 due, budget 4 → the other 3 slots go to discovery.
  const mixed = selectAvailabilitySweepTargets({
    maxPerRun: 4,
    due: candidates("c1", "openrouter", 1, "due"),
    discovery: candidates("c1", "openrouter", 10, "new"),
  });
  assert.equal(mixed.length, 4);
  assert.equal(mixed.filter((target) => target.source === "reprobe").length, 1);
});

test("sweep budget: an odd cap rounds the reserved half towards re-probing", () => {
  const selected = selectAvailabilitySweepTargets({
    maxPerRun: 5,
    due: candidates("c1", "openrouter", 10, "due"),
    discovery: candidates("c1", "openrouter", 10, "new"),
  });
  assert.equal(selected.filter((target) => target.source === "reprobe").length, 3);
  assert.equal(selected.filter((target) => target.source === "batch_test").length, 2);
});

test("sweep budget: the same model is never probed twice in one tick, and due wins", () => {
  const shared = { providerId: "openrouter", connectionId: "c1", modelId: "alpha:free" };
  const selected = selectAvailabilitySweepTargets({
    maxPerRun: 4,
    due: [shared, shared],
    discovery: [shared, { ...shared, modelId: "beta:free" }],
  });
  const alpha = selected.filter((target) => target.modelId === "alpha:free");
  assert.equal(alpha.length, 1);
  // A model that has persisted evidence is by definition not a discovery
  // target — the reprobe classification is the correct one.
  assert.equal(alpha[0].source, "reprobe");
  assert.equal(selected.length, 2);
});

test("sweep budget: execution order round-robins across connections", () => {
  const selected = selectAvailabilitySweepTargets({
    maxPerRun: 6,
    due: [...candidates("c1", "openrouter", 3, "due"), ...candidates("c2", "gemini", 3, "due")],
    discovery: [],
  });
  // A connection that answers 429 on its first probe and gets short-circuited
  // for the rest of the run must not have eaten the other connection's slots.
  assert.deepEqual(
    selected.map((target) => target.connectionId),
    ["c1", "c2", "c1", "c2", "c1", "c2"]
  );
});

test("sweep budget: a zero or negative cap produces no upstream traffic", () => {
  const due = candidates("c1", "openrouter", 5, "due");
  assert.deepEqual(selectAvailabilitySweepTargets({ maxPerRun: 0, due, discovery: [] }), []);
  assert.deepEqual(selectAvailabilitySweepTargets({ maxPerRun: -3, due, discovery: [] }), []);
  assert.deepEqual(selectAvailabilitySweepTargets({ maxPerRun: 0.9, due, discovery: [] }), []);
});
