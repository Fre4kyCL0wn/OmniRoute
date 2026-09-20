/**
 * O9-F3.5 A3 — Routing Activation Gate.
 *
 * Builds on A2's real NVIDIA/OpenRouter fixtures
 * (`tests/unit/providerOnboardingNvidiaA2.test.ts`) to prove the policy layer
 * on top of `resolveProviderObservations`: a general activation candidate
 * requires READY *and* an active connection; a proven KNOWN_INCOMPATIBLE
 * model stays blocked under every policy mode and even a forced approval;
 * approval can only narrow a candidate (revoke), never widen a non-candidate
 * into one; and `strict_zero_cost` mode requires A2's own zero-cost route
 * contract, not just READY.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_ACTIVATION_POLICY_MODE,
  evaluateActivationDecision,
  isGeneralActivationCandidate,
  resolveActivationGate,
  type ActivationApprovalRecord,
} from "../../src/lib/providerOnboarding/activationPolicy.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import {
  resolveProviderObservations,
  type ResolvedObservation,
} from "../../src/lib/providerOnboarding/onboarding.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const NVIDIA = fixture("nvidia-models-live-a2.json");
const OPENROUTER = fixture("openrouter-models-live-a2.json");
const T1 = "2026-09-12T00:00:00.000Z";

const NV_TRUE = [
  "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-ai/deepseek-v4-pro-0813",
  "moonshotai/kimi-k3",
];
const NV_KNOWN_FALSE = "openai/gpt-oss-120b";

function resolveConnection(providerId: string, connectionId: string, items: readonly unknown[]) {
  const outcome: ObservationCatalogOutcome = { ok: true, items };
  const inventory = applyObservationRefresh(null, {
    providerId,
    connectionId,
    source: `${providerId}:models-endpoint`,
    observedAt: T1,
    outcome,
  });
  return resolveProviderObservations({
    inventory,
    connection: {
      provider: providerId,
      authType: "apikey",
      connectionId,
      providerSpecificData: {},
      isActive: true,
    },
  }).models;
}

function byModelId(models: ResolvedObservation[], providerModelId: string): ResolvedObservation {
  const found = models.find((m) => m.record.providerModelId === providerModelId);
  if (!found) throw new Error(`fixture missing model ${providerModelId}`);
  return found;
}

function approval(overrides: Partial<ActivationApprovalRecord>): ActivationApprovalRecord {
  return {
    canonicalModelId: "unused",
    approved: true,
    approvedBy: "diegosouzapw",
    approvedAt: T1,
    note: null,
    ...overrides,
  };
}

const NV_MODELS = resolveConnection("nvidia", "conn-nv", NVIDIA.data);
const OR_MODELS = resolveConnection("openrouter", "conn-or", OPENROUTER.data);
// The live 82-id NVIDIA catalog fixture doesn't happen to include the
// curated known-FALSE model (`openai/gpt-oss-120b`) — observe it directly,
// same as the live catalog would, to test the fail-closed block.
const NV_KNOWN_FALSE_MODEL = resolveConnection("nvidia", "conn-nv-kf", [{ id: NV_KNOWN_FALSE }])[0];

test("default policy mode is manual", () => {
  assert.equal(DEFAULT_ACTIVATION_POLICY_MODE, "manual");
});

test("NVIDIA: exactly the 3 known-true models are general activation candidates", () => {
  const candidates = NV_MODELS.filter((m) => isGeneralActivationCandidate(m, true)).map(
    (m) => m.record.providerModelId
  );
  assert.deepEqual(candidates.sort(), [...NV_TRUE].sort());
});

test("NVIDIA: unresolved models stay validation-required, never candidates", () => {
  for (const m of NV_MODELS) {
    if (NV_TRUE.includes(m.record.providerModelId)) continue;
    const decision = evaluateActivationDecision({
      resolved: m,
      connectionActive: true,
      policyMode: "manual",
    });
    assert.equal(decision.generalActivationCandidate, false, m.record.providerModelId);
    assert.equal(decision.reason, "validation-required", m.record.providerModelId);
    assert.equal(decision.activate, false, m.record.providerModelId);
  }
});

test("NVIDIA: known FALSE model is blocked under every policy mode, even with a forced approval", () => {
  const knownFalse = NV_KNOWN_FALSE_MODEL;
  assert.equal(knownFalse.evidence.claudeCodeEligible, false);
  const forcedApproval = approval({
    canonicalModelId: knownFalse.record.canonicalModelId,
    approved: true,
  });
  for (const policyMode of ["manual", "approved_ready", "strict_zero_cost"] as const) {
    const decision = evaluateActivationDecision({
      resolved: knownFalse,
      connectionActive: true,
      policyMode,
      approval: forcedApproval,
    });
    assert.equal(decision.generalActivationCandidate, false, policyMode);
    assert.equal(decision.reason, "known-incompatible", policyMode);
    assert.equal(decision.activate, false, policyMode);
  }
});

test("A general candidate on an inactive connection is blocked, even though A2's READY does not check connection state", () => {
  const kimi = byModelId(NV_MODELS, "moonshotai/kimi-k3");
  assert.equal(kimi.status, "READY");
  const decision = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: false,
    policyMode: "approved_ready",
  });
  assert.equal(decision.generalActivationCandidate, false);
  assert.equal(decision.reason, "connection-inactive");
  assert.equal(decision.activate, false);
});

test("OpenRouter cohere/north-mini-code:free is a general activation candidate but not strict-zero-cost", () => {
  const north = byModelId(OR_MODELS, "cohere/north-mini-code:free");
  assert.equal(north.status, "READY");
  assert.equal(north.zeroCostEligible, false);
  const decision = evaluateActivationDecision({
    resolved: north,
    connectionActive: true,
    policyMode: "manual",
  });
  assert.equal(decision.generalActivationCandidate, true);
  assert.equal(decision.strictZeroCostCandidate, false);
});

test("manual mode: a general candidate never activates without an explicit approval record", () => {
  const kimi = byModelId(NV_MODELS, "moonshotai/kimi-k3");
  const noApproval = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: true,
    policyMode: "manual",
  });
  assert.equal(noApproval.activate, false);
  assert.equal(noApproval.reason, "policy-manual-unapproved");

  const approved = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: true,
    policyMode: "manual",
    approval: approval({ canonicalModelId: kimi.record.canonicalModelId, approved: true }),
  });
  assert.equal(approved.activate, true);
  assert.equal(approved.reason, "policy-manual-approved");
});

test("manual mode: an explicit revocation always blocks, overriding a prior approval", () => {
  const kimi = byModelId(NV_MODELS, "moonshotai/kimi-k3");
  const revoked = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: true,
    policyMode: "manual",
    approval: approval({ canonicalModelId: kimi.record.canonicalModelId, approved: false }),
  });
  assert.equal(revoked.activate, false);
  assert.equal(revoked.reason, "approval-revoked");
});

test("approved_ready mode: every general candidate activates without a stored approval record", () => {
  for (const providerModelId of NV_TRUE) {
    const decision = evaluateActivationDecision({
      resolved: byModelId(NV_MODELS, providerModelId),
      connectionActive: true,
      policyMode: "approved_ready",
    });
    assert.equal(decision.activate, true, providerModelId);
    assert.equal(decision.reason, "policy-approved-ready", providerModelId);
  }
});

test("approved_ready mode: revocation still overrides", () => {
  const kimi = byModelId(NV_MODELS, "moonshotai/kimi-k3");
  const decision = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: true,
    policyMode: "approved_ready",
    approval: approval({ canonicalModelId: kimi.record.canonicalModelId, approved: false }),
  });
  assert.equal(decision.activate, false);
  assert.equal(decision.reason, "approval-revoked");
});

test("strict_zero_cost mode: READY alone is not enough — needs the proven zero-cost route", () => {
  const kimi = byModelId(NV_MODELS, "moonshotai/kimi-k3");
  assert.equal(kimi.zeroCostEligible, false);
  const decision = evaluateActivationDecision({
    resolved: kimi,
    connectionActive: true,
    policyMode: "strict_zero_cost",
  });
  assert.equal(decision.generalActivationCandidate, true);
  assert.equal(decision.activate, false);
  assert.equal(decision.reason, "policy-strict-zero-cost-ineligible");
});

test("strict_zero_cost mode: OpenRouter's verified-free model still fails closed (connection safety unproven)", () => {
  const north = byModelId(OR_MODELS, "cohere/north-mini-code:free");
  const decision = evaluateActivationDecision({
    resolved: north,
    connectionActive: true,
    policyMode: "strict_zero_cost",
  });
  assert.equal(decision.activate, false);
  assert.equal(decision.reason, "policy-strict-zero-cost-ineligible");
});

test("resolveActivationGate: batch summary matches per-model decisions for NVIDIA under approved_ready", () => {
  const gate = resolveActivationGate({
    provider: "nvidia",
    connectionId: "conn-nv",
    resolved: NV_MODELS,
    connectionActive: true,
    policyMode: "approved_ready",
  });
  assert.equal(gate.summary.generalActivationCandidates, NV_TRUE.length);
  assert.equal(gate.summary.activating, NV_TRUE.length);
  assert.deepEqual(
    gate.decisions
      .filter((d) => d.activate)
      .map((d) => d.canonicalModelId)
      .sort(),
    NV_TRUE.map((id) => `nvidia/${id}`).sort()
  );
});

test("resolveActivationGate: manual mode with an injected approval map only activates the approved model", () => {
  const approvals = new Map<string, ActivationApprovalRecord>([
    [
      `nvidia/${NV_TRUE[0]}`,
      approval({ canonicalModelId: `nvidia/${NV_TRUE[0]}`, approved: true }),
    ],
  ]);
  const gate = resolveActivationGate({
    provider: "nvidia",
    connectionId: "conn-nv",
    resolved: NV_MODELS,
    connectionActive: true,
    policyMode: "manual",
    resolveApproval: (canonicalModelId) => approvals.get(canonicalModelId) ?? null,
  });
  assert.equal(gate.summary.generalActivationCandidates, NV_TRUE.length);
  assert.equal(gate.summary.activating, 1);
  assert.deepEqual(
    gate.decisions.filter((d) => d.activate).map((d) => d.canonicalModelId),
    [`nvidia/${NV_TRUE[0]}`]
  );
});

test("observation alone still has zero routing effect through the activation gate: no candidate list mutates the resolved input", () => {
  const before = JSON.stringify(NV_MODELS);
  resolveActivationGate({
    provider: "nvidia",
    connectionId: "conn-nv",
    resolved: NV_MODELS,
    connectionActive: true,
    policyMode: "approved_ready",
  });
  assert.equal(JSON.stringify(NV_MODELS), before);
});
