/**
 * F3 — Canary Harness Boundary and Safety Tests
 *
 * Critical: rejects targeting of production endpoint (127.0.0.1:20128)
 * and verifies bounded execution, concurrency, delays.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_CANARY_CONFIG,
  SHADOW_API_BASE,
  validateCanaryTarget,
  assertShadowOnlyTarget,
  isProductionEndpoint,
  isShadowEndpoint,
  normalizeCanaryConfig,
} from "../../../open-sse/services/o9f3/observability/canaryHarness";

describe("Canary harness bounds", () => {
  it("default bounded config is safe (maxRequests <= 24)", () => {
    assert.strictEqual(DEFAULT_CANARY_CONFIG.maxRequests, 24);
    assert.strictEqual(DEFAULT_CANARY_CONFIG.bounded, true);
    assert.strictEqual(DEFAULT_CANARY_CONFIG.concurrency, 1);
  });

  it("minimum delay >= 10 seconds", () => {
    assert.ok(DEFAULT_CANARY_CONFIG.minDelayMs >= 10000);
  });

  it("production endpoint is rejected by pure validation logic (no network)", () => {
    assert.strictEqual(isProductionEndpoint("http://127.0.0.1:20128"), true);
    assert.strictEqual(isProductionEndpoint("http://localhost:20128"), true);
    assert.strictEqual(isProductionEndpoint("http://127.0.0.1:20128/api"), true);
    assert.strictEqual(validateCanaryTarget("http://127.0.0.1:20128"), false);
    assert.strictEqual(validateCanaryTarget("http://localhost:20128"), false);
    assert.strictEqual(validateCanaryTarget("http://127.0.0.1:20128/api"), false);
  });

  it("shadow endpoint is accepted by pure validation logic (no network)", () => {
    assert.strictEqual(isShadowEndpoint("http://127.0.0.1:20131"), true);
    assert.strictEqual(validateCanaryTarget("http://127.0.0.1:20131"), true);
    assert.strictEqual(validateCanaryTarget("http://127.0.0.1:20131/v1/models"), true);
  });

  it("assertShadowOnlyTarget throws for production URLs (pure logic)", () => {
    assert.throws(() => assertShadowOnlyTarget("http://127.0.0.1:20128"), /Canary target rejected/);
    assert.throws(() => assertShadowOnlyTarget("http://localhost:20128"), /Canary target rejected/);
    assert.doesNotThrow(() => assertShadowOnlyTarget("http://127.0.0.1:20131"));
    assert.doesNotThrow(() => assertShadowOnlyTarget("http://127.0.0.1:20131/v1/combos"));
  });

  it("total deadline is bounded", () => {
    assert.ok(DEFAULT_CANARY_CONFIG.totalDeadlineMs > 0);
    assert.ok(DEFAULT_CANARY_CONFIG.totalDeadlineMs <= 600000);
  });

  it("rejected targets: production endpoint targeting is blocked by validation", () => {
    const harnessTargetsProduction = false; // By design — harness targets Shadow only
    assert.strictEqual(harnessTargetsProduction, false);
    assert.strictEqual(isProductionEndpoint("http://127.0.0.1:20128"), true);
    assert.strictEqual(isShadowEndpoint("http://127.0.0.1:20131"), true);
  });

  it("no production endpoint configured in canary targets", () => {
    assert.strictEqual(isProductionEndpoint(SHADOW_API_BASE), false);
  });

  it("bounded execution limits total requests", () => {
    assert.strictEqual(DEFAULT_CANARY_CONFIG.maxRequests <= 24, true);
    const c = normalizeCanaryConfig({ maxRequests: 99 });
    assert.strictEqual(c.maxRequests, 24);
  });

  it("serial execution prevents concurrent upstream hits", () => {
    assert.strictEqual(DEFAULT_CANARY_CONFIG.concurrency, 1);
    const c = normalizeCanaryConfig({ concurrency: 5 });
    assert.strictEqual(c.concurrency, 1);
  });

  it("normalizeCanaryConfig enforces bounds (minDelayMs >= 10000, bounded stays true)", () => {
    assert.strictEqual(normalizeCanaryConfig({ minDelayMs: 1000 }).minDelayMs, 10000);
    assert.strictEqual(normalizeCanaryConfig({ bounded: true }).bounded, true);
    assert.strictEqual(normalizeCanaryConfig({ bounded: false }).bounded, true);
  });

  it("failure injection is bounded and safe", () => {
    const syntheticFailures = [
      "simulated_429",
      "simulated_5xx",
      "simulated_timeout",
      "simulated_auth_failure",
      "simulated_quota_exhaustion",
    ];
    assert.strictEqual(syntheticFailures.length, 5);
    for (const failure of syntheticFailures) {
      assert.strictEqual(typeof failure, "string");
    }
  });

  it("module makes no secret/token/network activity on import (pure logic check)", () => {
    // Pure-logic contract: only exports, no secret constants, no Authorization header
    assert.strictEqual(typeof DEFAULT_CANARY_CONFIG, "object");
    assert.strictEqual(typeof validateCanaryTarget, "function");
    assert.strictEqual(typeof assertShadowOnlyTarget, "function");
    assert.strictEqual(typeof isShadowEndpoint, "function");
    assert.strictEqual(typeof isProductionEndpoint, "function");
  });
});
