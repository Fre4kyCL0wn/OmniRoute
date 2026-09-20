/**
 * Startup ordering: catalog-dependent jobs wait for the initial model sync,
 * but a sync that hangs or fails must not disable them for the lifetime of the
 * process.
 *
 * `awaitInitialModelSync` is the whole contract in one function — it never
 * rejects, never hangs, and reports WHY it settled so the caller can log the
 * catalog as stale instead of treating it as authoritative.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_MODEL_SYNC_TIMEOUT_MS,
  awaitInitialModelSync,
} from "../../src/lib/initCloudSync.ts";

test("a completed sync reports a fresh catalog", async () => {
  assert.equal(await awaitInitialModelSync(Promise.resolve("ok"), 1_000), "synced");
});

test("a rejected sync resolves as failed rather than propagating", async () => {
  // A throw here would escape into `void …then(…)` as an unhandled rejection
  // and the catalog-dependent jobs would never start at all.
  const outcome = await awaitInitialModelSync(
    Promise.reject(new Error("upstream catalog 503")),
    1_000
  );
  assert.equal(outcome, "failed");
});

test("a hung sync times out instead of blocking availability forever", async () => {
  const never = new Promise(() => {});
  const startedAt = Date.now();
  assert.equal(await awaitInitialModelSync(never, 50), "timeout");
  assert.ok(Date.now() - startedAt < 5_000, "must not wait for the hung promise");
});

test("the timeout outcome is distinguishable from a successful one", async () => {
  // The caller branches on exactly this to decide `deferDiscovery`, so
  // collapsing timeout/failed into "synced" would silently let one tick of
  // discovery run against an empty or stale catalog.
  const outcomes = await Promise.all([
    awaitInitialModelSync(Promise.resolve(), 1_000),
    awaitInitialModelSync(Promise.reject(new Error("x")), 1_000),
    awaitInitialModelSync(new Promise(() => {}), 10),
  ]);
  assert.deepEqual(outcomes, ["synced", "failed", "timeout"]);
  assert.equal(new Set(outcomes).size, 3);
});

test("a sync that finishes after the timeout does not throw or change the outcome", async () => {
  let reject: (error: Error) => void = () => {};
  const late = new Promise((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  const outcome = await awaitInitialModelSync(late, 10);
  assert.equal(outcome, "timeout");
  // The job registration has already happened by now; a late failure must not
  // surface as an unhandled rejection.
  reject(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("the default timeout is bounded and generous enough for a real sync", () => {
  assert.equal(INITIAL_MODEL_SYNC_TIMEOUT_MS, 60_000);
  assert.ok(INITIAL_MODEL_SYNC_TIMEOUT_MS > 0 && INITIAL_MODEL_SYNC_TIMEOUT_MS <= 300_000);
});

test("a zero or negative timeout still settles rather than hanging", async () => {
  assert.equal(await awaitInitialModelSync(new Promise(() => {}), 0), "timeout");
  assert.equal(await awaitInitialModelSync(new Promise(() => {}), -5), "timeout");
});
