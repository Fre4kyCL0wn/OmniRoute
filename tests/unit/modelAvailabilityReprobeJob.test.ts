import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelAvailabilityReprobeIntervalMs,
  getModelAvailabilityReprobeMaxPerRun,
} from "../../src/lib/jobs/modelAvailabilityReprobeJobConfig.ts";

test("model availability reprobe defaults to ten minutes and three models", () => {
  assert.equal(getModelAvailabilityReprobeIntervalMs({}), 600_000);
  assert.equal(getModelAvailabilityReprobeMaxPerRun({}), 3);
});

test("model availability reprobe cadence is bounded", () => {
  assert.equal(
    getModelAvailabilityReprobeIntervalMs({
      OMNIROUTE_MODEL_AVAILABILITY_REPROBE_INTERVAL_MS: "1",
    }),
    60_000
  );
  assert.equal(
    getModelAvailabilityReprobeIntervalMs({
      OMNIROUTE_MODEL_AVAILABILITY_REPROBE_INTERVAL_MS: "99999999",
    }),
    3_600_000
  );
});

test("model availability reprobe fan-out is bounded", () => {
  assert.equal(
    getModelAvailabilityReprobeMaxPerRun({ OMNIROUTE_MODEL_AVAILABILITY_REPROBE_MAX_PER_RUN: "0" }),
    1
  );
  assert.equal(
    getModelAvailabilityReprobeMaxPerRun({
      OMNIROUTE_MODEL_AVAILABILITY_REPROBE_MAX_PER_RUN: "99",
    }),
    10
  );
});
