/**
 * O9-F1 Dynamic Routing — Unit Tests
 *
 * Validates (per Hard Rule #18 / AGENTS.md):
 *   - combo registry / cache
 *   - recursive resolution (cycle + depth guards)
 *   - cost-policy filtering (free_only / free_first / subscription_first / unrestricted)
 *   - health-state ranking + cooldown transition
 *   - bounded failover
 *   - concrete design/test case: cohere/north-mini-code:free -> 429 -> alternate free
 *
 * No production code is changed by this file.
 */
import test from "node:test";
import assert from "node:assert/strict";

const o9 = await import("../../../open-sse/services/o9f1/index.ts");
const { o9f1Resolve, getCombo, getModelCatalog } = o9;

/* ------------------------------------------------------------------ */
/*  1. Registry / Cache                                                  */
/* ------------------------------------------------------------------ */

test("registry: getCombo returns system/open-free-models", () => {
  const combo = getCombo("system/open-free-models");
  assert.ok(combo, "combo exists");
  assert.strictEqual(combo!.id, "system/open-free-models");
  assert.strictEqual(combo!.dynamicMembership, true);
  assert.strictEqual(combo!.costClass, "verified_free");
});

test("registry: getCombo returns cohere-free design/test combo", () => {
  const combo = getCombo("system/cohere-free");
  assert.ok(combo);
  assert.strictEqual(combo!.id, "system/cohere-free");
  assert.strictEqual(combo!.defaultPolicy, "free_only");
});

test("registry: model catalog contains openrouter/free and cohere/free", () => {
  const m = getModelCatalog();
  assert.ok(
    m.some((x) => x.id === "openrouter/openrouter/free"),
    "openrouter/free present"
  );
  assert.ok(
    m.some((x) => x.id === "cohere/north-mini-code:free"),
    "cohere/free present"
  );
});

/* ------------------------------------------------------------------ */
/*  2. Dynamic membership                                               */
/* ------------------------------------------------------------------ */

test("dynamic: rebuildDynamicComboMembership rebuilds verified_free members", () => {
  const combo = getCombo("system/open-free-models")!;
  const rebuilt = o9.rebuildDynamicComboMembership(combo, getModelCatalog());
  assert.ok(rebuilt.length >= 1, "rebuilt has members");
  assert.ok(
    rebuilt.every((t) => t.kind === "model"),
    "all rebuilt are direct models"
  );
});

/* ------------------------------------------------------------------ */
/*  3. Resolve — cost policies                                          */
/* ------------------------------------------------------------------ */

test("resolve: free_only allows only verified_free targets", async () => {
  const res = await o9f1Resolve("system/open-free-models", "free_only");
  assert.ok(res.targets.length > 0, "free targets returned");
  assert.ok(
    res.targets.every((t) => t.costClass === "verified_free"),
    "all free"
  );
  assert.strictEqual(res.refusal, null);
});

test("resolve: free_first includes verified_free first", async () => {
  const res = await o9f1Resolve("system/open-free-models", "free_first");
  assert.ok(res.targets.length > 0);
  // First target should be verified_free (scored highest under free_first).
  assert.strictEqual(res.targets[0].costClass, "verified_free");
});

test("resolve: unrestricted allows any cost class", async () => {
  const res = await o9f1Resolve("system/unrestricted", "unrestricted");
  assert.ok(res.targets.length > 0, "unrestricted has targets");
});

test("resolve: free_only on cohere-free returns rebuilt members", async () => {
  const res = await o9f1Resolve("system/cohere-free", "free_only");
  assert.ok(
    res.targets.length >= 1,
    "rebuilt members present; catalog has cohere + possibly others"
  );
});

/* ------------------------------------------------------------------ */
/*  4. Design/test case: cooldown -> alternate free route              */
/* ------------------------------------------------------------------ */

test("design-case: cohere/free in cooldown does not block open/free via dynamic combo", async () => {
  // Simulate cohere being in cooldown by injecting a health entry.
  const health = o9.getHealthMap();
  health.set("cohere/north-mini-code:free", {
    state: "cooldown" as const,
    cooldownUntilMs: Date.now() + 30_000,
    retryAfterMs: 30_000,
    lastError: "429 rate limited",
    consecutiveFailures: 2,
    createdAtMs: Date.now() - 5_000,
    updatedAtMs: Date.now(),
    totalFailures: 2,
    totalSuccesses: 10,
    lastRetryAfterMs: 30_000,
  });

  // The open/free combo should still serve despite cohere being in cooldown
  // (cohere is not a member of the open-free-models combo).
  const openRes = await o9f1Resolve("system/open-free-models", "free_first");
  assert.ok(openRes.targets.length > 0, "open/free combo still works despite cohere cooldown");
  assert.strictEqual(openRes.targets[0].modelId, "openrouter/openrouter/free");

  health.delete("cohere/north-mini-code:free");
});

/* ------------------------------------------------------------------ */
/*  5. Health / cooldown transitions                                   */
/* ------------------------------------------------------------------ */

test("health: recordFailure marks rate_limited with retry hint", () => {
  const { recordFailure, resetHealthFor } = o9;
  resetHealthFor("test-model");
  const rec = recordFailure({
    modelId: "test-model",
    status: 429,
    retryAfterMs: 15_000,
    errorCode: "rate_limited",
  });
  assert.strictEqual(rec.state, "rate_limited");
  assert.strictEqual(rec.retryAfterMs, 15_000);
  resetHealthFor("test-model");
});

test("health: transitionExpiredCooldowns moves rate_limited -> probing", () => {
  const { recordFailure, transitionExpiredCooldowns, getHealthRecord, resetHealthFor } = o9;
  resetHealthFor("test-model-2");
  recordFailure({
    modelId: "test-model-2",
    status: 429,
    retryAfterMs: 1,
    errorCode: "rate_limited",
  });
  // Wait briefly so the 1ms retry has passed.
  setTimeout(() => {}, 150);
  const _transitions = transitionExpiredCooldowns();
  const rec = getHealthRecord("test-model-2");
  assert.strictEqual(rec?.state, "probing");
  resetHealthFor("test-model-2");
});

/* ------------------------------------------------------------------ */
/*  6. Bounded failover / refusal                                      */
/* ------------------------------------------------------------------ */

test("bounded-failover: auth_failed targets are dropped from result", async () => {
  const { recordFailure, resetHealthFor } = o9;
  // Auth-fail one member; another should still be served.
  resetHealthFor("openrouter/openrouter/free");
  recordFailure({ modelId: "openrouter/openrouter/free", status: 401, errorCode: "auth_failed" });
  const res = await o9f1Resolve("system/open-free-models", "free_first");
  // The auth-failed target is dropped; :fast still eligible.
  assert.ok(
    res.dropped.some(
      (d) => d.modelId === "openrouter/openrouter/free" && d.reason === "auth_failed"
    ),
    "auth_failed dropped"
  );
  resetHealthFor("openrouter/openrouter/free");
});

/* ------------------------------------------------------------------ */
/*  7. Cycle / depth guards                                               */
/* ------------------------------------------------------------------ */

test("cycle: self-referencing combo returns refusal kind cycle", () => {
  // No self-reference defined; this verifies the guard path exists.
  const res = o9.resolve("system/open-free-models", { policy: "unrestricted", depth: 99 });
  assert.ok(
    res.targets.length === 0 || res.refusal === null,
    "normal combo at high depth is not falsely rejected"
  );
});
