import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-runtime-availability-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const availabilityDb = await import("../../src/lib/db/modelAvailability.ts");
const runtime = await import("../../src/lib/modelAvailability/runtimeRecorder.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
}

test.beforeEach(resetStorage);

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("runtime availability persists quota/model-not-found but ignores generic provider failures", () => {
  const quota = runtime.recordRuntimeModelFailure({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "gemini/gemini-2.5-pro-preview-tts",
    status: 429,
    errorText: "quota exceeded",
    quotaExhausted: true,
  });
  assert.equal(quota?.state, "quota_exhausted");
  assert.equal(quota?.source, "runtime");

  const missing = runtime.recordRuntimeModelFailure({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "retired-preview",
    status: 404,
    errorText: "model not found",
    errorCode: "model_not_found",
  });
  assert.equal(missing?.state, "unavailable");

  const transient = runtime.recordRuntimeModelFailure({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "otherwise-healthy",
    status: 503,
    errorText: "temporary provider outage",
  });
  assert.equal(transient, null);
  assert.equal(
    availabilityDb.getModelAvailabilityInventory("gemini-a")?.models["otherwise-healthy"],
    undefined
  );
});

test("runtime success rehabilitates only a previously tracked model", () => {
  runtime.recordRuntimeModelFailure({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "gemini-x",
    status: 429,
    errorText: "rate limited",
  });
  const recovered = runtime.recordRuntimeModelSuccessIfTracked({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "gemini-x",
  });
  assert.equal(recovered?.state, "available");
  assert.equal(recovered?.source, "runtime");
  assert.equal(
    runtime.recordRuntimeModelSuccessIfTracked({
      providerId: "gemini",
      connectionId: "gemini-a",
      modelId: "never-seen",
    }),
    null
  );
});

test("provider summary dedupes a model across connections and prefers a working route", () => {
  availabilityDb.recordModelTestAvailability({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "same-model",
    source: "runtime",
    result: { status: "rate_limited", statusCode: 429, rateLimited: true, isQuota: true },
  });
  availabilityDb.recordModelTestAvailability({
    providerId: "gemini",
    connectionId: "gemini-b",
    modelId: "same-model",
    source: "runtime",
    result: { status: "ok", statusCode: 200 },
  });
  availabilityDb.recordModelTestAvailability({
    providerId: "gemini",
    connectionId: "gemini-a",
    modelId: "blocked-model",
    source: "runtime",
    result: { status: "rate_limited", statusCode: 429, rateLimited: true, isQuota: true },
  });

  const summary = availabilityDb.getModelAvailabilitySummaryByProvider().gemini;
  assert.equal(summary.totalChecked, 2);
  assert.equal(summary.available, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.quotaExhausted, 1);
});
