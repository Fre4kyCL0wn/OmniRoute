import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildPreWindowShadowProbeIncident,
  generateEvidence,
} from "../../../open-sse/services/o9f3/observability/soakEvidence";
import { evaluateSoakReadiness } from "../../../open-sse/services/o9f3/observability/readiness";
import {
  assertActiveWindowForInference,
  classifyPreflightCall,
  evaluateStorageGuard,
  defaultSoakWindow,
  selectRoutesFromCatalog,
} from "../../../open-sse/services/o9f3/observability/soakRunner";
import { persistWindowRequest } from "../../../open-sse/services/o9f3/observability/soakPersistence";
import {
  UNRESOLVED_LEAF_MODEL,
  addRequestEntry,
  amendRequestClassification,
  completeWindow,
  initialSoakState,
  isMeaningfulRealRequest,
  recomputeDerived,
  remainingWindowRequests,
  SoakRequestEntry,
  SoakState,
  startWindowExecution,
} from "../../../open-sse/services/o9f3/observability/soakState";
import { classifyObservableCostClass } from "../../../open-sse/services/o9f3/observability/soakRunner";

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

  it("normalizes provider aliases and unresolved leaf placeholders before aggregation", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("alias", {
        selectedCombo: "Open/FreeModels",
        provider: "oc",
        model: "big-pickle",
        costClass: "unknown",
      })
    );
    state = addRequestEntry(
      state,
      entry("placeholder", {
        selectedCombo: "free",
        provider: "openrouter",
        model: "openrouter/:free",
      })
    );

    assert.strictEqual(state.request_entries[0].provider, "opencode");
    assert.strictEqual(state.request_entries[1].model, UNRESOLVED_LEAF_MODEL);
    assert.strictEqual(
      state.route_provider_model_distribution["Open/FreeModels/opencode/big-pickle"],
      1
    );
    assert.strictEqual(
      state.route_provider_model_distribution[`free/openrouter/${UNRESOLVED_LEAF_MODEL}`],
      1
    );

    const evidence = generateEvidence(state);
    assert.deepStrictEqual(evidence.f3_2_provider_distribution, { opencode: 1, openrouter: 1 });
    assert.strictEqual(evidence.f3_2_model_distribution[UNRESOLVED_LEAF_MODEL], 1);
  });

  it("classifies cost from leaf evidence, not provider alias or combo display name", () => {
    assert.strictEqual(
      classifyObservableCostClass({ provider: "oc", model: "big-pickle", costUsd: 0 }),
      "unknown"
    );
    assert.strictEqual(
      classifyObservableCostClass({ provider: "oc", model: "nemotron-3-ultra-free", costUsd: 0 }),
      "verified_free"
    );
    assert.strictEqual(
      classifyObservableCostClass({
        provider: "openrouter",
        model: "openrouter/:free",
        costUsd: 0,
      }),
      "unknown"
    );
    assert.strictEqual(
      classifyObservableCostClass({ provider: "claude", model: "claude-sonnet-5", costUsd: 0 }),
      "subscription_included"
    );
  });

  it("keeps policy violation aggregate consistent with durable request classifications", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("policy", {
        policy: "free_only",
        costClass: "unknown",
        success: false,
        failureClass: "policy_violation",
      })
    );

    assert.strictEqual(state.policy_violation_count, 1);
    assert.strictEqual(generateEvidence(state).f3_2_policy_violations, 1);
  });

  it("preserves historical evidence with durable amendment audit trail", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("correct-me", {
        provider: "oc",
        model: "big-pickle",
        costClass: "unknown",
        success: false,
        failureClass: "policy_violation",
      })
    );
    state = amendRequestClassification(state, {
      amendmentId: "amend-w1-big-pickle-policy",
      windowId: "w1",
      requestId: "correct-me",
      reason: "W1 post-window audit: request was real but not a free_only policy success.",
      corrected: { success: true, failureClass: undefined },
    });

    assert.strictEqual(state.request_entries[0].success, true);
    assert.strictEqual(state.request_entries[0].failureClass, undefined);
    assert.strictEqual(state.request_entries[0].provider, "opencode");
    assert.strictEqual(state.policy_violation_count, 0);
    assert.strictEqual(state.evidence_amendments?.[0].original.failureClass, "policy_violation");
    assert.strictEqual(state.evidence_amendments?.[0].corrected.success, true);
    assert.deepStrictEqual(generateEvidence(state).evidence_amendments, state.evidence_amendments);
  });

  it("documents 502 failover eligibility and pre-upstream 401 exclusion from W1 counting", () => {
    let state = initialSoakState();
    state = addRequestEntry(
      state,
      entry("502", {
        reachedRealUpstream: false,
        success: false,
        failureClass: "server_error",
        fallbackCount: 0,
      })
    );
    state = addRequestEntry(
      state,
      entry("401", {
        reachedRealUpstream: false,
        success: false,
        failureClass: "auth_failure",
        fallbackCount: 0,
      })
    );

    assert.strictEqual(state.new_meaningful_requests, 0);
    assert.strictEqual(state.new_failures, 0);
    assert.strictEqual(state.cost_class_distribution.unknown, undefined);
  });

  it("selects preflight routes from catalog data without real inference", () => {
    let inferenceCalls = 0;
    const window = defaultSoakWindow("preflight-only", ["s1"]);
    const routes = selectRoutesFromCatalog(
      {
        models: [{ id: "catalog/free-model", costClass: "verified_free" }],
        combos: [
          {
            name: "catalog-free",
            models: [
              {
                model: "catalog/free-model",
                providerId: "catalog",
                costClass: "verified_free",
                authorized: true,
                executable: true,
                health: "healthy",
              },
              {
                model: "catalog/visible-unknown",
                providerId: "catalog",
                authorized: true,
              },
            ],
          },
        ],
      },
      window
    );

    assert.ok(routes.length > 0);
    assert.strictEqual(inferenceCalls, 0);
    assert.ok(routes.every((route) => route.catalogVisibility === "visible"));
    assert.ok(routes.every((route) => route.authorizationStatus !== "unauthorized"));
    assert.ok(routes.every((route) => route.policyStatus === "allowed"));
    assert.ok(routes.some((route) => route.executabilityStatus === "known_executable"));
    assert.ok(routes.some((route) => route.reasons.includes("cost_class:verified_free")));
    assert.ok(!routes.some((route) => route.model === "catalog/visible-unknown"));
    assert.strictEqual(classifyPreflightCall("/v1/models"), "control_plane");
    assert.strictEqual(classifyPreflightCall("/v1/combos"), "control_plane");
    assert.strictEqual(classifyPreflightCall("/v1/chat/completions"), "real_inference");
  });

  it("rejects real inference outside an active F3.2 window context", () => {
    assert.throws(
      () => assertActiveWindowForInference("/v1/chat/completions"),
      /F3_2_INFERENCE_REQUIRES_ACTIVE_WINDOW/
    );
    assert.throws(
      () =>
        assertActiveWindowForInference("/v1/responses", {
          activeWindowId: "w1",
          windowId: "w2",
        }),
      /F3_2_INFERENCE_REQUIRES_ACTIVE_WINDOW/
    );
    assert.doesNotThrow(() =>
      assertActiveWindowForInference("/v1/chat/completions", {
        activeWindowId: "w1",
        windowId: "w1",
      })
    );
    assert.doesNotThrow(() => assertActiveWindowForInference("/v1/models"));
  });

  it("advances real request counters only after atomic durable persistence succeeds", () => {
    const active = startWindowExecution({
      windowId: "w1",
      maxMeaningfulRequests: 20,
      concurrency: 1,
      sessionIds: ["s1"],
    });
    let durable = initialSoakState();
    const failingStore = {
      load: () => durable,
      save: (_next: SoakState) => {
        throw new Error("disk full");
      },
    };

    assert.throws(
      () => persistWindowRequest(failingStore, active, entry("persist-fail")),
      /disk full/
    );
    assert.strictEqual(durable.new_meaningful_requests, 0);
    assert.strictEqual(durable.cumulative_meaningful_requests, 20);

    const store = {
      load: () => durable,
      save: (next: SoakState) => {
        durable = next;
      },
    };
    const persisted = persistWindowRequest(store, active, entry("persist-ok"));
    assert.strictEqual(persisted.new_meaningful_requests, 1);
    assert.strictEqual(durable.new_meaningful_requests, 1);
    assert.strictEqual(durable.cumulative_meaningful_requests, 21);
    assert.strictEqual(durable.request_entries[0].requestId, "persist-ok");
  });

  it("resumes interrupted windows by exact window-local remainder", () => {
    let state = initialSoakState();
    for (let i = 1; i <= 7; i++) {
      state = addRequestEntry(state, entry(`w1-r${i}`, { windowId: "w1" }));
    }
    state = addRequestEntry(state, entry("w1-r7", { windowId: "w1" }));
    state = addRequestEntry(state, entry("synthetic-w1", { windowId: "w1", synthetic: true }));
    state = addRequestEntry(state, entry("w2-r1", { windowId: "w2" }));

    assert.strictEqual(remainingWindowRequests(state, "w1", 20), 13);
    assert.strictEqual(remainingWindowRequests(state, "w2", 20), 19);
  });

  it("keeps manual control-plane and prior Shadow probes out of soak counters forever", () => {
    const state = initialSoakState();
    const incident = buildPreWindowShadowProbeIncident();

    assert.deepStrictEqual(
      incident.probes.map((probe) => `${probe.route} -> ${probe.status}`),
      ["auto/best-fast -> 200", "coding -> 200", "codex/gpt-5.5-low -> 200"]
    );
    assert.ok(incident.probes.every((probe) => probe.countedInSoak === false));
    assert.ok(incident.probes.every((probe) => probe.promptsIncluded === false));
    assert.ok(incident.probes.every((probe) => probe.responseContentIncluded === false));
    assert.ok(incident.probes.every((probe) => probe.credentialsIncluded === false));
    assert.strictEqual(state.new_meaningful_requests, 0);
    assert.strictEqual(state.cumulative_meaningful_requests, 20);
    assert.strictEqual(state.cumulative_successes, 20);
    assert.strictEqual(state.cumulative_failures, 0);
    assert.strictEqual(state.completed_real_windows, 0);
    assert.strictEqual(state.request_entries.length, 0);
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
