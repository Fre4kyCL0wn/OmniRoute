import { describe, it } from "node:test";
import assert from "node:assert";

import { generateEvidence } from "../../../open-sse/services/o9f3/observability/soakEvidence";
import { evaluateSoakReadiness } from "../../../open-sse/services/o9f3/observability/readiness";
import {
  evaluateStorageGuard,
  defaultSoakWindow,
} from "../../../open-sse/services/o9f3/observability/soakRunner";
import {
  addRequestEntry,
  completeWindow,
  initialSoakState,
  isMeaningfulRealRequest,
  recomputeDerived,
  SoakRequestEntry,
  SoakState,
} from "../../../open-sse/services/o9f3/observability/soakState";

function entry(id: string, overrides: Partial<SoakRequestEntry> = {}): SoakRequestEntry {
  return {
    requestId: id,
    windowId: "w1",
    sessionId: "s1",
    startedAt: `2026-09-08T00:00:${id.padStart(2, "0")}.000Z`,
    completedAt: `2026-09-08T00:00:${id.padStart(2, "0")}.500Z`,
    intent: "coding",
    policy: "free_first",
    selectedCombo: "coding",
    provider: "freemodels",
    model: "free-model",
    costClass: "verified_free",
    reachedRealUpstream: true,
    synthetic: false,
    success: true,
    retryCooldownObserved: false,
    routeSwitches: 0,
    ...overrides,
  };
}

function addMany(state: SoakState, count: number, offset = 0): SoakState {
  let next = state;
  for (let i = 1; i <= count; i++) {
    const n = i + offset;
    next = addRequestEntry(
      next,
      entry(`r${n}`, {
        windowId: `w${Math.floor((n - 1) / 20) + 1}`,
        sessionId: `s${(n % 4) + 1}`,
        intent: ["coding", "chat", "free"][n % 3],
        policy: ["free_only", "free_first", "subscription_first"][n % 3],
      })
    );
  }
  return next;
}

describe("O9-F3.2 soak recovery accounting", () => {
  it("keeps immutable 20/20/0 baseline and first F3.2 request makes cumulative 21", () => {
    const initial = initialSoakState();
    assert.strictEqual(initial.baseline_meaningful_requests, 20);
    assert.strictEqual(initial.baseline_successes, 20);
    assert.strictEqual(initial.baseline_failures, 0);
    assert.strictEqual(initial.new_meaningful_requests, 0);
    assert.strictEqual(initial.cumulative_meaningful_requests, 20);

    const next = addRequestEntry(initial, entry("1"));
    assert.strictEqual(next.new_meaningful_requests, 1);
    assert.strictEqual(next.new_successes, 1);
    assert.strictEqual(next.new_failures, 0);
    assert.strictEqual(next.cumulative_meaningful_requests, 21);
    assert.strictEqual(next.cumulative_successes, 21);
    assert.strictEqual(next.cumulative_failures, 0);
    assert.strictEqual(next.cumulative_success_rate, 1);
  });

  it("uses cumulative success/failure denominator including real upstream failures", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("1", { success: false, failureClass: "upstream_429", retryAfterMs: 3000 })
    );
    state = addRequestEntry(state, entry("2", { success: false, failureClass: "upstream_5xx" }));
    assert.strictEqual(state.new_meaningful_requests, 2);
    assert.strictEqual(state.new_successes, 0);
    assert.strictEqual(state.new_failures, 2);
    assert.strictEqual(state.cumulative_meaningful_requests, 22);
    assert.strictEqual(state.cumulative_successes, 20);
    assert.strictEqual(state.cumulative_failures, 2);
    assert.strictEqual(state.cumulative_success_rate, 20 / 22);
  });

  it("excludes synthetic, local pre-upstream, missing IDs, and classifier-only failures", () => {
    let state = initialSoakState();
    state = addRequestEntry(state, entry("synthetic", { synthetic: true, success: false }));
    state = addRequestEntry(state, entry("pre", { reachedRealUpstream: false, success: false }));
    state = addRequestEntry(state, entry("", { requestId: "" }));
    state = addRequestEntry(
      state,
      entry("classifier", {
        reachedRealUpstream: false,
        success: false,
        failureClass: "claude_code_safety_classifier",
      })
    );
    assert.strictEqual(state.new_meaningful_requests, 0);
    assert.strictEqual(state.cumulative_meaningful_requests, 20);
    assert.strictEqual(state.cumulative_failures, 0);
    assert.strictEqual(
      isMeaningfulRealRequest(entry("pre", { reachedRealUpstream: false })),
      false
    );
  });

  it("dedupes request IDs and recomputes route/cost distributions from durable entries", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("1", { selectedCombo: "coding", costClass: "verified_free" })
    );
    state = addRequestEntry(state, entry("1", { selectedCombo: "chat", costClass: "paid" }));
    state = addRequestEntry(
      state,
      entry("2", {
        selectedCombo: "chat",
        provider: "claude",
        model: "sonnet",
        costClass: "subscription_included",
      })
    );
    assert.strictEqual(state.request_entries.length, 2);
    assert.strictEqual(state.new_meaningful_requests, 2);
    assert.deepStrictEqual(state.cost_class_distribution, {
      verified_free: 1,
      subscription_included: 1,
    });
    assert.strictEqual(state.route_provider_model_distribution["coding/freemodels/free-model"], 1);
    assert.strictEqual(state.route_provider_model_distribution["chat/claude/sonnet"], 1);
  });

  it("derives verified windows from durable request evidence and dedupes windows", () => {
    let state = initialSoakState();
    state = addRequestEntry(state, entry("1", { windowId: "w1", sessionId: "s1" }));
    state = addRequestEntry(state, entry("2", { windowId: "w1", sessionId: "s2", success: false }));
    state = completeWindow(state, "w1", {
      maxMeaningfulRequests: 20,
      concurrency: 1,
      completedAt: "2026-09-08T00:01:00.000Z",
    });
    state = completeWindow(state, "w1", { maxMeaningfulRequests: 20, concurrency: 1 });
    assert.strictEqual(state.completed_real_windows, 1);
    assert.strictEqual(state.windows[0].actualMeaningfulCount, 2);
    assert.strictEqual(state.windows[0].actualSuccessCount, 1);
    assert.strictEqual(state.windows[0].actualFailureCount, 1);
    assert.deepStrictEqual(state.windows[0].sessionIds, ["s1", "s2"]);
    assert.deepStrictEqual(state.windows[0].requestIds, ["1", "2"]);
  });

  it("does not verify a summary-only window without request evidence", () => {
    const state = completeWindow(initialSoakState(), "w-empty", {
      maxMeaningfulRequests: 20,
      concurrency: 1,
    });
    assert.strictEqual(state.completed_real_windows, 0);
    assert.deepStrictEqual(state.windows, []);
  });

  it("generates evidence with separate intent, policy, route, provider, model, and cost distributions", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("1", {
        intent: "coding",
        policy: "free_only",
        selectedCombo: "coding",
        provider: "freemodels",
        model: "m1",
        costClass: "verified_free",
        latencyMs: 10,
      })
    );
    state = addRequestEntry(
      state,
      entry("2", {
        intent: "chat",
        policy: "subscription_first",
        selectedCombo: "chat",
        provider: "claude",
        model: "sonnet",
        costClass: "subscription_included",
        latencyMs: 20,
        routeSwitches: 1,
      })
    );
    const evidence = generateEvidence(state, 74, 75);
    assert.deepStrictEqual(evidence.f3_2_intent_distribution, { coding: 1, chat: 1 });
    assert.deepStrictEqual(evidence.f3_2_policy_distribution, {
      free_only: 1,
      subscription_first: 1,
    });
    assert.deepStrictEqual(evidence.f3_2_route_distribution, { coding: 1, chat: 1 });
    assert.deepStrictEqual(evidence.f3_2_provider_distribution, { freemodels: 1, claude: 1 });
    assert.deepStrictEqual(evidence.f3_2_model_distribution, { m1: 1, sonnet: 1 });
    assert.deepStrictEqual(evidence.f3_2_cost_class_distribution, {
      verified_free: 1,
      subscription_included: 1,
    });
    assert.strictEqual(typeof evidence.storage_before_percent, "number");
    assert.strictEqual(evidence.f3_2_real_failures, 0);
  });

  it("classifies storage guard thresholds exactly", () => {
    assert.strictEqual(evaluateStorageGuard(74).status, "safe");
    assert.strictEqual(evaluateStorageGuard(75).status, "triggered");
    assert.strictEqual(evaluateStorageGuard(79).status, "triggered");
    assert.strictEqual(evaluateStorageGuard(80).status, "critical");
    assert.strictEqual(evaluateStorageGuard(90).status, "critical");
  });

  it("keeps long-soak defaults bounded, serial, and spaced by at least 15 seconds", () => {
    const window = defaultSoakWindow("w1", ["s1", "s2"]);
    assert.strictEqual(window.bounded, true);
    assert.strictEqual(window.concurrency, 1);
    assert.ok(window.minDelayMs >= 15000);
    assert.strictEqual(window.maxMeaningfulRequests, 20);
  });

  it("resumes with exact remainder and no duplicate counting", () => {
    let state = addMany(initialSoakState(), 7);
    state = addRequestEntry(state, entry("r7"));
    const remaining =
      defaultSoakWindow("w1", ["s1"]).maxMeaningfulRequests - state.new_meaningful_requests;
    assert.strictEqual(state.new_meaningful_requests, 7);
    assert.strictEqual(remaining, 13);
    assert.strictEqual(recomputeDerived(state).new_meaningful_requests, 7);
  });

  it("evaluates expanded and cutover-review readiness without auto-approving cutover", () => {
    let expanded = addMany(initialSoakState(), 1);
    expanded.readiness = evaluateSoakReadiness(expanded, {
      representativeCoverage: true,
      failClosedVerified: true,
      stableRouting: true,
    });
    assert.strictEqual(expanded.readiness, "READY_FOR_EXPANDED_CANARY");
    assert.strictEqual(expanded.cutover_approved, false);

    let cutover = addMany(initialSoakState(), 80);
    for (const id of ["w1", "w2", "w3", "w4"]) {
      cutover = completeWindow(cutover, id, { maxMeaningfulRequests: 20, concurrency: 1 });
    }
    cutover.readiness = evaluateSoakReadiness(cutover, {
      representativeCoverage: true,
      failClosedVerified: true,
      stableRouting: true,
      rollbackVerified: true,
      failoverVerified: true,
      cooldownVerified: true,
      reprobeVerified: true,
      noP0P1: true,
      noPersistentRoutingThrash: true,
      safeStorage: true,
    });
    assert.strictEqual(cutover.cumulative_meaningful_requests, 100);
    assert.strictEqual(cutover.completed_real_windows, 4);
    assert.strictEqual(cutover.readiness, "READY_FOR_CUTOVER_REVIEW");
    assert.strictEqual(cutover.cutover_approved, false);
  });

  it("guards readiness on paid escalation, policy, production, Anthropic fallback, thrash, and fail-closed", () => {
    const base = addMany(initialSoakState(), 80);
    const goodInputs = {
      representativeCoverage: true,
      failClosedVerified: true,
      stableRouting: true,
      rollbackVerified: true,
      failoverVerified: true,
      cooldownVerified: true,
      reprobeVerified: true,
      noP0P1: true,
      noPersistentRoutingThrash: true,
      safeStorage: true,
    };

    assert.strictEqual(
      evaluateSoakReadiness({ ...base, unexpected_paid_escalation_count: 1 }, goodInputs),
      "OBSERVING"
    );
    assert.strictEqual(
      evaluateSoakReadiness({ ...base, policy_violation_count: 1 }, goodInputs),
      "OBSERVING"
    );
    assert.strictEqual(
      evaluateSoakReadiness({ ...base, production_contact_count: 1 }, goodInputs),
      "OBSERVING"
    );
    assert.strictEqual(
      evaluateSoakReadiness({ ...base, public_anthropic_fallback_count: 1 }, goodInputs),
      "READY_FOR_EXPANDED_CANARY"
    );
    assert.strictEqual(
      evaluateSoakReadiness(base, { ...goodInputs, noPersistentRoutingThrash: false }),
      "READY_FOR_EXPANDED_CANARY"
    );
    assert.strictEqual(
      evaluateSoakReadiness(base, { ...goodInputs, failClosedVerified: false }),
      "OBSERVING"
    );
  });
});
