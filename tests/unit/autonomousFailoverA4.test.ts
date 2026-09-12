/**
 * O9-F3.5 A4 — Autonomous Failover Decision Engine.
 *
 * Pure decision tests: no DB, no network, no provider request, no live
 * switch. Scenarios A-L are the ones named in the A4 spec; M/N cover
 * WAIT_COOLDOWN and the explicit current-route-bias-under-temptation case the
 * spec's §6 describes but doesn't letter. The last block proves genuine A2/A3
 * reuse against A3's own real OpenRouter fixture evidence, not a synthetic
 * stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { ActivationApprovalRecord } from "../../src/lib/providerOnboarding/activationPolicy.ts";
import { evaluateActivationDecision } from "../../src/lib/providerOnboarding/activationPolicy.ts";
import { resolveProviderObservations } from "../../src/lib/providerOnboarding/onboarding.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import { candidateFromResolvedObservation } from "../../src/lib/failover/failoverA3Adapter.ts";
import {
  buildFailoverCandidate,
  dryRunFailoverDecision,
  evaluateFailoverDecision,
  type FailoverCandidate,
  type FailoverDecisionInput,
  type RouteHardFacts,
} from "../../src/lib/failover/failoverDecision.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000; // fixed instant for deterministic cooldown math

function mkState(
  overrides: Partial<
    import("../../src/lib/failover/failoverDecision.ts").FailoverCandidate["runtimeState"]
  > = {}
) {
  return {
    providerId: "test-provider",
    connectionId: "conn-test",
    providerHealth: "healthy" as const,
    accountState: "available" as const,
    quotaState: "available" as const,
    quotaScope: "unknown" as const,
    cooldownUntil: null,
    quotaResetAt: null,
    costClass: "unknown" as const,
    capabilities: {
      executable: true,
      fastEligible: null,
      codingEligible: null,
      genericToolEligible: null,
      claudeCodeEligible: true,
      supervisorEligible: null,
    },
    lastSuccessAt: null,
    lastFailureAt: null,
    failureReason: null,
    latency: { medianMs: null, p95Ms: null },
    computedAtMs: NOW,
    ...overrides,
  };
}

const PERFECT_FACTS: RouteHardFacts = {
  connectionActive: true,
  evidenceCurrent: true,
  executable: true,
  claudeCodeEligible: true,
  knownProtocolConflict: false,
  activationPermitted: true,
  administrativelyDisabled: false,
};

function mkCandidate(
  routeId: string,
  providerId: string,
  overrides: {
    hardFacts?: Partial<RouteHardFacts>;
    state?: Partial<ReturnType<typeof mkState>>;
    activationState?: FailoverCandidate["activationState"];
    strictZeroCostSafe?: boolean;
    zeroCostUnsafeReason?: FailoverCandidate["zeroCostUnsafeReason"];
    requirementsMatch?: FailoverCandidate["requirementsMatch"];
    externalScore?: number;
  } = {}
): FailoverCandidate {
  return buildFailoverCandidate(
    { routeId, providerId, connectionId: `conn-${providerId}` },
    {
      hardFacts: { ...PERFECT_FACTS, ...overrides.hardFacts },
      runtimeState: mkState({ providerId, connectionId: `conn-${providerId}`, ...overrides.state }),
      activationState: overrides.activationState ?? "ALREADY_ROUTABLE",
      strictZeroCostSafe: overrides.strictZeroCostSafe ?? false,
      zeroCostUnsafeReason: overrides.zeroCostUnsafeReason,
      requirementsMatch: overrides.requirementsMatch,
      externalScore: overrides.externalScore,
    }
  );
}

function baseInput(overrides: Partial<FailoverDecisionInput> = {}): FailoverDecisionInput {
  return {
    currentRoute: {
      routeId: "gemini/gemini-2.5-flash",
      providerId: "gemini",
      connectionId: "conn-gemini",
    },
    currentRouteState: mkState({ providerId: "gemini", connectionId: "conn-gemini" }),
    currentRouteFailure: "none",
    candidates: [],
    attemptedRouteIds: new Set<string>(),
    policyMode: "manual",
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Gemini healthy => KEEP_CURRENT
// ---------------------------------------------------------------------------

test("A: healthy current route => KEEP_CURRENT, no candidates even evaluated", () => {
  const result = evaluateFailoverDecision(
    baseInput({ candidates: [mkCandidate("groq/openai/gpt-oss-120b", "groq")] })
  );
  assert.equal(result.decision, "KEEP_CURRENT");
  assert.equal(result.reason, "CURRENT_HEALTHY");
  assert.deepEqual(result.candidatesConsidered, []);
});

// ---------------------------------------------------------------------------
// B. Gemini quota exhausted; only candidate is zero-cost-unsafe under strict policy => NO_SAFE_ROUTE
// ---------------------------------------------------------------------------

test("B: strict_zero_cost policy rejects a READY-but-account-safety-unknown candidate => NO_SAFE_ROUTE", () => {
  const groq = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "quota_exhausted",
      currentRouteState: mkState({
        providerId: "gemini",
        connectionId: "conn-gemini",
        accountState: "quota_exhausted",
      }),
      candidates: [groq],
      policyMode: "strict_zero_cost",
    })
  );
  assert.equal(result.decision, "NO_SAFE_ROUTE");
  assert.equal(result.candidatesConsidered.length, 1);
  assert.equal(result.candidatesConsidered[0].reason, "ACCOUNT_SAFETY_UNKNOWN");
});

// ---------------------------------------------------------------------------
// C. One fully strict-zero-cost-safe, already-routable candidate => SWITCH_TO
// ---------------------------------------------------------------------------

test("C: one fully safe already-routable candidate => SWITCH_TO(candidate)", () => {
  const local = mkCandidate("local/mlx-qwen", "local-mlx", {
    strictZeroCostSafe: true,
    activationState: "ALREADY_ROUTABLE",
  });
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "quota_exhausted",
      currentRouteState: mkState({
        providerId: "gemini",
        connectionId: "conn-gemini",
        accountState: "quota_exhausted",
      }),
      candidates: [local],
      policyMode: "strict_zero_cost",
    })
  );
  assert.equal(result.decision, "SWITCH_TO");
  assert.deepEqual(result.target, {
    routeId: "local/mlx-qwen",
    providerId: "local-mlx",
    connectionId: "conn-local-mlx",
  });
});

// ---------------------------------------------------------------------------
// D. Candidate cooldown active => skip
// ---------------------------------------------------------------------------

test("D: a candidate whose own connection is cooling down is skipped", () => {
  const cooling = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    state: { cooldownUntil: NOW + 60_000 },
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [cooling] })
  );
  assert.equal(result.candidatesConsidered[0].reason, "COOLDOWN_ACTIVE");
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// E / F. claudeCodeEligible null vs false
// ---------------------------------------------------------------------------

test("E: claudeCodeEligible=null => VALIDATION_REQUIRED, skipped", () => {
  const unknown = mkCandidate("nvidia/some-unproven-model", "nvidia", {
    hardFacts: { claudeCodeEligible: null },
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [unknown] })
  );
  assert.equal(result.candidatesConsidered[0].reason, "VALIDATION_REQUIRED");
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});

test("F: claudeCodeEligible=false => CLAUDE_INCOMPATIBLE, skipped", () => {
  const known = mkCandidate("nvidia/openai/gpt-oss-120b", "nvidia", {
    hardFacts: { claudeCodeEligible: false },
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [known] })
  );
  assert.equal(result.candidatesConsidered[0].reason, "CLAUDE_INCOMPATIBLE");
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// G. all alternatives unsafe => NO_SAFE_ROUTE
// ---------------------------------------------------------------------------

test("G: every candidate rejected for a different reason => NO_SAFE_ROUTE, all reasons reported", () => {
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      policyMode: "strict_zero_cost",
      candidates: [
        mkCandidate("a/x", "a", { hardFacts: { claudeCodeEligible: false } }),
        mkCandidate("b/y", "b", { hardFacts: { claudeCodeEligible: null } }),
        mkCandidate("c/z", "c", { strictZeroCostSafe: false, zeroCostUnsafeReason: "other" }),
      ],
    })
  );
  assert.equal(result.decision, "NO_SAFE_ROUTE");
  assert.deepEqual(
    result.candidatesConsidered.map((c) => c.reason),
    ["CLAUDE_INCOMPATIBLE", "VALIDATION_REQUIRED", "COST_UNSAFE"]
  );
});

// ---------------------------------------------------------------------------
// H. already-attempted candidate => skip / loop prevented (A -> B -> A blocked)
// ---------------------------------------------------------------------------

test("H: an already-attempted candidate is skipped, preventing an A -> B -> A loop", () => {
  const b = mkCandidate("provider-b/model", "provider-b", { strictZeroCostSafe: true });
  // First hop: A (current) failed, only B available -> switch to B.
  const first = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [b] })
  );
  assert.equal(first.decision, "SWITCH_TO");
  assert.equal(first.target?.routeId, "provider-b/model");

  // Second hop: B (now current) also failed. A is offered again, but A is
  // already in the attempted set from the first hop -> must not bounce back.
  const a = mkCandidate("gemini/gemini-2.5-flash", "gemini", { strictZeroCostSafe: true });
  const second = evaluateFailoverDecision(
    baseInput({
      currentRoute: {
        routeId: "provider-b/model",
        providerId: "provider-b",
        connectionId: "conn-provider-b",
      },
      currentRouteFailure: "connection_unavailable",
      candidates: [a],
      attemptedRouteIds: new Set(["gemini/gemini-2.5-flash", "provider-b/model"]),
    })
  );
  assert.equal(second.candidatesConsidered[0].reason, "ATTEMPTED_ALREADY");
  assert.equal(second.decision, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// I. provider recovered on a later, independent request => eligible again
// ---------------------------------------------------------------------------

test("I: a candidate rejected for cooldown becomes eligible again on a later, independent evaluation", () => {
  const stillCooling = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    strictZeroCostSafe: true,
    state: { cooldownUntil: NOW + 60_000 },
  });
  const first = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [stillCooling] })
  );
  assert.equal(first.candidatesConsidered[0].reason, "COOLDOWN_ACTIVE");
  assert.equal(first.decision, "NO_SAFE_ROUTE");

  // Independent later call: fresh attempted set, cooldown now in the past.
  const recovered = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    strictZeroCostSafe: true,
    state: { cooldownUntil: NOW - 1000 },
  });
  const second = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      candidates: [recovered],
      attemptedRouteIds: new Set(),
    })
  );
  assert.equal(second.decision, "SWITCH_TO");
  assert.equal(second.target?.routeId, "groq/openai/gpt-oss-120b");
});

// ---------------------------------------------------------------------------
// J. fully proven local_zero_cost candidate => may become SWITCH_TO
// ---------------------------------------------------------------------------

test("J: a fully proven local zero-cost candidate is a legitimate SWITCH_TO target", () => {
  const local = mkCandidate("local-mlx/mlx-qwen", "local-mlx", {
    strictZeroCostSafe: true,
    activationState: "ALREADY_ROUTABLE",
  });
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      candidates: [local],
      policyMode: "strict_zero_cost",
    })
  );
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.target?.routeId, "local-mlx/mlx-qwen");
});

test("J2: local_zero_cost alone is not enough — unproven capability still blocks it", () => {
  const localUnproven = mkCandidate("local-mlx/mlx-qwen", "local-mlx", {
    strictZeroCostSafe: true,
    hardFacts: { claudeCodeEligible: null },
  });
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      candidates: [localUnproven],
      policyMode: "strict_zero_cost",
    })
  );
  assert.equal(result.candidatesConsidered[0].reason, "VALIDATION_REQUIRED");
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// K. READY but not activated => ACTIVATION_REQUIRED, not SWITCH_TO
// ---------------------------------------------------------------------------

test("K: a READY-but-not-activated candidate returns ACTIVATION_REQUIRED, never SWITCH_TO", () => {
  const readyNotActivated = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [readyNotActivated] })
  );
  assert.equal(result.decision, "ACTIVATION_REQUIRED");
  assert.equal(result.reason, "NOT_ACTIVATED");
  assert.equal(result.target?.routeId, "nvidia/moonshotai/kimi-k3");
});

test("K2: an ALREADY_ROUTABLE candidate is preferred over a READY_BUT_NOT_ACTIVATED one", () => {
  const notActivated = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const routable = mkCandidate("openrouter/cohere/north-mini-code:free", "openrouter", {
    activationState: "ALREADY_ROUTABLE",
  });
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      candidates: [notActivated, routable],
    })
  );
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.target?.routeId, "openrouter/cohere/north-mini-code:free");
});

// ---------------------------------------------------------------------------
// L. invalid client request => do not fail over across providers
// ---------------------------------------------------------------------------

test("L: caller_error never triggers failover, even with eligible candidates present", () => {
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "caller_error",
      candidates: [mkCandidate("groq/openai/gpt-oss-120b", "groq", { strictZeroCostSafe: true })],
    })
  );
  assert.equal(result.decision, "KEEP_CURRENT");
  assert.equal(result.reason, "CALLER_ERROR");
  assert.deepEqual(result.candidatesConsidered, []);
});

// ---------------------------------------------------------------------------
// M. WAIT_COOLDOWN — transient current-route failure with a known resume time
// ---------------------------------------------------------------------------

test("M: rate-limited current route with no eligible candidate and a known reset => WAIT_COOLDOWN", () => {
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "rate_limited",
      currentRouteState: mkState({
        providerId: "gemini",
        connectionId: "conn-gemini",
        cooldownUntil: NOW + 5000,
      }),
      candidates: [],
    })
  );
  assert.equal(result.decision, "WAIT_COOLDOWN");
  assert.equal(result.reason, "RATE_LIMITED");
  assert.equal(result.resumeAtMs, NOW + 5000);
});

test("M2: a hard (non-transient) current-route failure never produces WAIT_COOLDOWN, even with a stray cooldown timestamp", () => {
  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "auth_failed",
      currentRouteState: mkState({
        providerId: "gemini",
        connectionId: "conn-gemini",
        cooldownUntil: NOW + 5000,
      }),
      candidates: [],
    })
  );
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// N. Current-route bias under temptation — never switch just for a better score
// ---------------------------------------------------------------------------

test("N: a healthy current route is kept even against a tempting high-scoring candidate", () => {
  const tempting = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    externalScore: 1,
    strictZeroCostSafe: true,
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "none", candidates: [tempting] })
  );
  assert.equal(result.decision, "KEEP_CURRENT");
  assert.equal(result.candidatesConsidered.length, 0);
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

test("dry-run: reshapes the decision into rejected vs eligible without any live effect", () => {
  const safe = mkCandidate("local-mlx/mlx-qwen", "local-mlx", { strictZeroCostSafe: true });
  const unsafe = mkCandidate("groq/openai/gpt-oss-120b", "groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const report = dryRunFailoverDecision(
    baseInput({
      currentRouteFailure: "quota_exhausted",
      candidates: [safe, unsafe],
      policyMode: "strict_zero_cost",
    })
  );
  assert.equal(report.decision, "SWITCH_TO");
  assert.deepEqual(
    report.candidatesEligible.map((c) => c.routeId),
    ["local-mlx/mlx-qwen"]
  );
  assert.deepEqual(report.candidatesRejected, [
    { routeId: "groq/openai/gpt-oss-120b", reason: "ACCOUNT_SAFETY_UNKNOWN" },
  ]);
});

// ---------------------------------------------------------------------------
// Genuine A2/A3 reuse — real OpenRouter fixture, not a synthetic stand-in
// ---------------------------------------------------------------------------

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const OPENROUTER = fixture("openrouter-models-live-a2.json");

function resolveOpenRouter() {
  const outcome: ObservationCatalogOutcome = { ok: true, items: OPENROUTER.data };
  const inventory = applyObservationRefresh(null, {
    providerId: "openrouter",
    connectionId: "conn-or",
    source: "openrouter:models-endpoint",
    observedAt: "2026-09-12T00:00:00.000Z",
    outcome,
  });
  return resolveProviderObservations({
    inventory,
    connection: {
      provider: "openrouter",
      authType: "apikey",
      connectionId: "conn-or",
      providerSpecificData: {},
      isActive: true,
    },
  }).models;
}

test("A2/A3 reuse: real cohere/north-mini-code:free evidence flows end-to-end into a failover candidate", () => {
  const resolved = resolveOpenRouter().find(
    (m) => m.record.providerModelId === "cohere/north-mini-code:free"
  )!;
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: true,
    policyMode: "strict_zero_cost",
  });
  assert.equal(activation.strictZeroCostCandidate, false);

  const candidate = candidateFromResolvedObservation({
    providerId: "openrouter",
    connectionId: "conn-or",
    resolved,
    runtimeState: mkState({ providerId: "openrouter", connectionId: "conn-or" }),
    activation,
    connectionActive: true,
    alreadyRoutable: false,
  });
  assert.equal(candidate.activationState, "READY_BUT_NOT_ACTIVATED");
  assert.equal(candidate.zeroCostUnsafeReason, "connection-safety-unknown");

  const result = evaluateFailoverDecision(
    baseInput({
      currentRouteFailure: "connection_unavailable",
      candidates: [candidate],
      policyMode: "strict_zero_cost",
    })
  );
  // Blocked before even reaching the cost gate: it is not yet activated, and
  // A4 never bypasses A3 to switch to a non-activated model.
  assert.equal(result.decision, "NO_SAFE_ROUTE");
  assert.equal(result.candidatesConsidered[0].reason, "ACCOUNT_SAFETY_UNKNOWN");
});

test("A2/A3 reuse: a forced ActivationApprovalRecord never lets a KNOWN_INCOMPATIBLE model become a failover candidate", () => {
  const inventory = applyObservationRefresh(null, {
    providerId: "nvidia",
    connectionId: "conn-nv",
    source: "nvidia:models-endpoint",
    observedAt: "2026-09-12T00:00:00.000Z",
    outcome: { ok: true, items: [{ id: "openai/gpt-oss-120b" }] },
  });
  const resolved = resolveProviderObservations({
    inventory,
    connection: {
      provider: "nvidia",
      authType: "apikey",
      connectionId: "conn-nv",
      providerSpecificData: {},
      isActive: true,
    },
  }).models[0];
  assert.equal(resolved.evidence.claudeCodeEligible, false);

  const forcedApproval: ActivationApprovalRecord = {
    canonicalModelId: resolved.record.canonicalModelId,
    approved: true,
    approvedBy: "diegosouzapw",
    approvedAt: "2026-09-12T00:00:00.000Z",
    note: null,
  };
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: true,
    policyMode: "manual",
    approval: forcedApproval,
  });
  const candidate = candidateFromResolvedObservation({
    providerId: "nvidia",
    connectionId: "conn-nv",
    resolved,
    runtimeState: mkState({ providerId: "nvidia", connectionId: "conn-nv" }),
    activation,
    connectionActive: true,
    alreadyRoutable: false,
  });
  const result = evaluateFailoverDecision(
    baseInput({ currentRouteFailure: "connection_unavailable", candidates: [candidate] })
  );
  assert.equal(result.candidatesConsidered[0].reason, "CLAUDE_INCOMPATIBLE");
  assert.equal(result.decision, "NO_SAFE_ROUTE");
});
