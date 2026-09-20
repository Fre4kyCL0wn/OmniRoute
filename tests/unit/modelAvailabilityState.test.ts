import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyModelAvailability,
  isPersistedModelAvailabilityRoutable,
  modelAvailabilityUiStatus,
} from "../../src/lib/modelAvailability/state.ts";
import { overlayModelAvailabilityRuntimeState } from "../../src/lib/modelAvailability/runtimeOverlay.ts";
import type { ProviderRuntimeState } from "../../open-sse/services/providerRuntimeState.ts";

const NOW = Date.parse("2026-09-19T20:00:00.000Z");

function baseRuntime(): ProviderRuntimeState {
  return {
    providerHealth: "healthy",
    accountState: "available",
    quotaState: "available",
    cooldownUntil: null,
    quotaResetAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    latencyMs: null,
    errorRate: null,
    costClass: "unknown",
    capabilities: {
      toolCalling: null,
      reasoning: null,
      vision: null,
      streaming: null,
      contextWindow: null,
      maxOutputTokens: null,
      genericToolEligible: null,
      claudeCodeEligible: null,
      supervisorEligible: null,
    },
  };
}

test("model availability: missing evidence is visibly untested", () => {
  assert.equal(modelAvailabilityUiStatus(null), "unknown");
  assert.equal(modelAvailabilityUiStatus(undefined), "unknown");
});

test("model availability: successful probe is routable and resets failures", () => {
  const record = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini/gemini-3-flash-preview",
    result: { status: "ok", httpStatus: 200 },
    source: "manual_test",
    nowMs: NOW,
  });
  assert.equal(record.modelId, "gemini-3-flash-preview");
  assert.equal(record.state, "available");
  assert.equal(record.consecutiveFailures, 0);
  assert.equal(record.retryAfterAt, null);
  assert.equal(isPersistedModelAvailabilityRoutable(record), true);
  assert.equal(modelAvailabilityUiStatus(record), "ok");
});

test("model availability: quota 429 becomes fail-closed quota state with retry", () => {
  const record = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini-2.5-pro-preview-tts",
    result: {
      status: "rate_limited",
      httpStatus: 429,
      rateLimited: true,
      isQuota: true,
      isTransient: true,
    },
    source: "manual_test",
    nowMs: NOW,
  });
  assert.equal(record.state, "quota_exhausted");
  assert.equal(record.reason, "quota_exhausted");
  assert.equal(record.consecutiveFailures, 1);
  assert.ok(Date.parse(record.retryAfterAt ?? "") > NOW);
  assert.equal(isPersistedModelAvailabilityRoutable(record), false);
  assert.equal(modelAvailabilityUiStatus(record), "quota");
});

test("model availability: ordinary rate limit respects Retry-After", () => {
  const record = classifyModelAvailability({
    providerId: "openrouter",
    connectionId: "conn-or",
    modelId: "cohere/north-mini-code:free",
    result: { status: "rate_limited", httpStatus: 429, rateLimited: true, retryAfter: 90 },
    source: "batch_test",
    nowMs: NOW,
  });
  assert.equal(record.state, "rate_limited");
  assert.equal(Date.parse(record.retryAfterAt ?? ""), NOW + 90_000);
});

test("model availability: 404 becomes unavailable and timeout becomes degraded", () => {
  const unavailable = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "retired-model",
    result: { status: "error", httpStatus: 404 },
    source: "batch_test",
    nowMs: NOW,
  });
  const degraded = classifyModelAvailability({
    providerId: "nvidia",
    connectionId: "conn-nv",
    modelId: "slow-model",
    result: { status: "slow", httpStatus: 504, isTimeout: true },
    source: "batch_test",
    nowMs: NOW,
  });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(degraded.state, "degraded");
  assert.equal(modelAvailabilityUiStatus(unavailable), "error");
});

test("model availability: repeated failures back off but success rehabilitates", () => {
  const first = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini-x",
    result: { status: "rate_limited", httpStatus: 429, rateLimited: true },
    source: "reprobe",
    nowMs: NOW,
  });
  const second = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini-x",
    result: { status: "rate_limited", httpStatus: 429, rateLimited: true },
    source: "reprobe",
    previous: first,
    nowMs: NOW + 600_000,
  });
  assert.equal(second.consecutiveFailures, 2);
  assert.ok(Date.parse(second.retryAfterAt ?? "") - (NOW + 600_000) >= 20 * 60_000);
  const recovered = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini-x",
    result: { status: "ok", httpStatus: 200 },
    source: "reprobe",
    previous: second,
    nowMs: NOW + 3_600_000,
  });
  assert.equal(recovered.state, "available");
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.retryAfterAt, null);
});

test("model availability runtime overlay is exact-route fail-closed", () => {
  const quota = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gemini-x",
    result: { status: "rate_limited", httpStatus: 429, rateLimited: true, isQuota: true },
    source: "manual_test",
    nowMs: NOW,
  });
  const state = overlayModelAvailabilityRuntimeState(baseRuntime(), quota);
  assert.equal(state.accountState, "quota_exhausted");
  assert.equal(state.quotaState, "quota_exhausted");
  assert.ok((state.cooldownUntil ?? 0) > NOW);
  assert.equal(state.providerHealth, "healthy");
});

test("model availability runtime overlay marks unavailable model without killing sibling account state", () => {
  const unavailable = classifyModelAvailability({
    providerId: "gemini",
    connectionId: "conn-1",
    modelId: "gone",
    result: { status: "error", httpStatus: 404 },
    source: "manual_test",
    nowMs: NOW,
  });
  const state = overlayModelAvailabilityRuntimeState(baseRuntime(), unavailable);
  assert.equal(state.providerHealth, "unavailable");
  assert.equal(state.accountState, "available");
  assert.equal(state.quotaState, "available");
});
