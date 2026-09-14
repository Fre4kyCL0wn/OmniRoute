import test from "node:test";
import assert from "node:assert/strict";

import {
  getJarvisFreeCodingMaxActivations,
  getJarvisFreeCodingReconcileIntervalMs,
  isJarvisFreeCodingAutonomyEnabled,
  isJarvisAutoSupervisorEnabled,
  getJarvisAutoFallbackModel,
} from "../../src/lib/jobs/jarvisManagedFreeCodingReconcileJobConfig.ts";

test("R4.7 job is opt-in and therefore Production-safe by default", () => {
  assert.equal(isJarvisFreeCodingAutonomyEnabled({}), false);
  assert.equal(
    isJarvisFreeCodingAutonomyEnabled({ OMNIROUTE_JARVIS_AUTONOMOUS_RECONCILIATION: "true" }),
    true
  );
});

test("R4.7 interval is bounded between one minute and one hour", () => {
  assert.equal(getJarvisFreeCodingReconcileIntervalMs({}), 600_000);
  assert.equal(
    getJarvisFreeCodingReconcileIntervalMs({
      OMNIROUTE_JARVIS_AUTONOMOUS_RECONCILIATION_INTERVAL_MS: "1",
    }),
    60_000
  );
  assert.equal(
    getJarvisFreeCodingReconcileIntervalMs({
      OMNIROUTE_JARVIS_AUTONOMOUS_RECONCILIATION_INTERVAL_MS: "99999999",
    }),
    3_600_000
  );
});

test("R4.7 activation fan-out setting is bounded", () => {
  assert.equal(getJarvisFreeCodingMaxActivations({}), 3);
  assert.equal(
    getJarvisFreeCodingMaxActivations({
      OMNIROUTE_JARVIS_AUTONOMOUS_MAX_ACTIVATIONS_PER_RUN: "20",
    }),
    10
  );
});

test("R4.8 supervisor config is separately opt-in and fallback is generic", () => {
  assert.equal(isJarvisAutoSupervisorEnabled({}), false);
  assert.equal(isJarvisAutoSupervisorEnabled({ OMNIROUTE_JARVIS_AUTO_SUPERVISOR: "true" }), true);
  assert.equal(
    getJarvisAutoFallbackModel({ OMNIROUTE_JARVIS_AUTO_FALLBACK_MODEL: "future-provider/code" }),
    "future-provider/code"
  );
});
