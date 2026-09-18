import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompatibilityEvidence,
  compatibilityConnectionProbeBackoffUntil,
  type ProviderModelCompatibilityInventory,
} from "../../src/lib/providerOnboarding/compatibility.ts";

const NOW = Date.parse("2026-09-16T07:00:00.000Z");

function inventory(
  ...evidence: ReturnType<typeof buildCompatibilityEvidence>[]
): ProviderModelCompatibilityInventory {
  return {
    schemaVersion: 1,
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    updatedAt: new Date(NOW).toISOString(),
    models: Object.fromEntries(evidence.map((item) => [item.providerModelId, item])),
  };
}

test("F3.3D fresh transient rate-limit evidence backs off the whole connection", () => {
  const limited = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/model-a:free",
    state: "TRANSIENT_FAILURE",
    failureClass: "rate_limit",
    checkedAtMs: NOW,
  });
  assert.equal(
    compatibilityConnectionProbeBackoffUntil(inventory(limited), NOW),
    Date.parse(limited.expiresAt)
  );
});

test("F3.3D expired rate-limit evidence no longer blocks probing", () => {
  const expired = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/model-a:free",
    state: "TRANSIENT_FAILURE",
    failureClass: "rate_limit",
    checkedAtMs: NOW - 16 * 60_000,
  });
  assert.equal(compatibilityConnectionProbeBackoffUntil(inventory(expired), NOW), null);
});

test("F3.3D non-rate-limit evidence does not create connection backoff", () => {
  const pass = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/model-a:free",
    state: "PASS",
    checkedAtMs: NOW,
  });
  const transient = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/model-b:free",
    state: "TRANSIENT_FAILURE",
    failureClass: "upstream_5xx",
    checkedAtMs: NOW,
  });
  assert.equal(compatibilityConnectionProbeBackoffUntil(inventory(pass, transient), NOW), null);
});
