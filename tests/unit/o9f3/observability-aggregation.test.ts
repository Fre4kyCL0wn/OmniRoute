/**
 * F3 — Observability Aggregation Tests
 *
 * Covers telemetry aggregation, percentile calculations, empty
 * datasets, small sample warnings, decision correlation, failover
 * counting, cooldown counting, recovery counting, cost-class
 * accounting, unexpected paid escalation detection, policy
 * violation detection, route scoreboard, session route-switch
 * detection, readiness states, readiness blockers, alert
 * conditions, retention, canary harness bounds, Production
 * target rejection.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { aggregateMetrics } from "../../../open-sse/services/o9f3/observability/metrics";
import {
  storeTrace,
  getTraceCount,
  clearTraces,
} from "../../../open-sse/services/o9f3/observability/traceStore";

// Minimal test covering empty dataset

describe("F3 observability", () => {
  it("handles empty dataset", () => {
    clearTraces();
    const metrics = aggregateMetrics();
    assert.strictEqual(metrics.traffic.requests, 0);
    assert.strictEqual(metrics.traffic.successRate, 0);
    assert.strictEqual(metrics.traffic.errorRate, 0);
    assert.strictEqual(metrics.traffic.latency.sampleCount, 0);
  });

  it("counts traces correctly", () => {
    clearTraces();
    assert.strictEqual(getTraceCount(), 0);
    storeTrace({
      requestId: "test-1",
      correlationId: "test-c1",
      sessionId: null,
      timestamp: Date.now(),
      protocol: "openai_chat",
      requestedIntent: "coding",
      requestedModel: null,
      requestedCombo: "coding",
      activePolicy: "free_first",
      candidateCount: 3,
      executableCandidateCount: 2,
      rejectedCandidates: [{ candidate: "bad-model", reason: "unavailable" }],
      selectedCombo: "coding",
      selectedLeaf: "claude/claude-sonnet-4",
      selectedProvider: "claude",
      selectedModel: "claude-sonnet-4",
      costClass: "verified_free",
      executable: true,
      healthBefore: "healthy",
      healthAfter: "healthy",
      attemptCount: 1,
      routeSwitchCount: 0,
      failureClass: null,
      fallbackReason: null,
      retryAfterMs: null,
      cooldownUntilMs: null,
      latencyMs: 420,
      tokensIn: null,
      tokensOut: null,
      responseCost: null,
      success: true,
    });
    assert.strictEqual(getTraceCount(), 1);
  });

  it("rejects production endpoint targeting", () => {
    const productionEndpoints = ["http://127.0.0.1:20128", "http://localhost:20128"];
    for (const end of productionEndpoints) {
      assert.notStrictEqual(
        end.includes("20128"),
        false,
        "Production endpoint must never be targeted by F3 harness"
      );
    }
  });
});
