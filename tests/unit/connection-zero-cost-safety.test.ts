/**
 * O9-F3.4 P4-B — connection billing safety + zero-cost route composition.
 *
 * Three separate layers: MODEL (`resolveVerifiedFree`), CONNECTION
 * (`resolveConnectionZeroCostSafety`), ROUTE (`evaluateZeroCostRoute`). The
 * connection tests use a synthetic catalog so they keep passing when curated
 * entries change; the "real provider" cases use the live catalog on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ConnectionBillingEntry } from "../../open-sse/config/connectionBillingCatalog.ts";
import { resolveVerifiedFree } from "../../open-sse/config/providers/directCapabilities.ts";
import {
  parseConnectionBillingEvidence,
  resolveConnectionZeroCostSafety,
} from "../../open-sse/services/autoCombo/connectionBilling.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import {
  evaluateZeroCostRoute,
  type ZeroCostRouteFacts,
} from "../../open-sse/services/autoCombo/zeroCostRouteEligibility.ts";

const CATALOG: readonly ConnectionBillingEntry[] = [
  {
    provider: "plan-hard-stop",
    authType: "oauth",
    billing: "subscription",
    overage: "hard-stop",
    reason: "fixture",
  },
  {
    provider: "plan-meters",
    authType: "oauth",
    billing: "subscription",
    overage: "meters-to-paid",
    reason: "fixture",
  },
];

function declared(billingLinked: boolean | null) {
  return {
    billingEvidence: {
      billingLinked,
      origin: "operator-declared",
      observedAt: "2026-09-11T00:00:00.000Z",
    },
  };
}

function observed(billingLinked: boolean | null) {
  return {
    billingEvidence: {
      billingLinked,
      origin: "provider-observed",
      observedAt: "2026-09-11T00:00:00.000Z",
    },
  };
}

// ── CONNECTION layer ───────────────────────────────────────────────────────

test("no catalog entry and no evidence resolves null (fail closed)", () => {
  const safety = resolveConnectionZeroCostSafety(
    { provider: "uncurated", authType: "apikey", connectionId: "c1", providerSpecificData: {} },
    CATALOG
  );
  assert.deepEqual(safety, { safe: null, basis: "insufficient-evidence", origin: null });
});

test("A: operator-declared billingLinked=false never proves safe — stays null, origin kept", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "c1",
      providerSpecificData: declared(false),
    },
    CATALOG
  );
  assert.deepEqual(safety, {
    safe: null,
    basis: "unverified-not-linked",
    origin: "operator-declared",
  });
});

test("B: safe-looking operator evidence is only safe where stronger trusted evidence exists", () => {
  const onlyOperator = resolveConnectionZeroCostSafety(
    { provider: "uncurated", connectionId: "c1", providerSpecificData: declared(false) },
    CATALOG
  );
  assert.equal(onlyOperator.safe, null);

  const withContract = resolveConnectionZeroCostSafety(
    {
      provider: "plan-hard-stop",
      authType: "oauth",
      connectionId: "c1",
      providerSpecificData: declared(false),
    },
    CATALOG
  );
  assert.deepEqual(withContract, { safe: true, basis: "contract-hard-stop", origin: "static" });
});

test("D: provider-observed billingLinked=false proves safe", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "c1",
      providerSpecificData: observed(false),
    },
    CATALOG
  );
  assert.deepEqual(safety, {
    safe: true,
    basis: "billing-not-linked",
    origin: "provider-observed",
  });
});

test("E: provider-observed billing / paid-tier / auto-charge evidence proves unsafe", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "c1",
      providerSpecificData: observed(true),
    },
    CATALOG
  );
  assert.deepEqual(safety, { safe: false, basis: "billing-linked", origin: "provider-observed" });
});

test("C: operator-declared billingLinked=true may conservatively prove unsafe", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "c1",
      providerSpecificData: declared(true),
    },
    CATALOG
  );
  assert.equal(safety.safe, false);
  assert.equal(safety.basis, "billing-linked");
});

test("billingLinked null is not evidence either way", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "c1",
      providerSpecificData: declared(null),
    },
    CATALOG
  );
  assert.equal(safety.safe, null);
});

test("catalog meters-to-paid wins over an unlinked-billing declaration", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "plan-meters",
      authType: "oauth",
      connectionId: "c1",
      providerSpecificData: declared(false),
    },
    CATALOG
  );
  assert.deepEqual(safety, { safe: false, basis: "contract-meters-to-paid", origin: "static" });
});

test("catalog hard-stop stays safe even with billing linked", () => {
  const safety = resolveConnectionZeroCostSafety(
    {
      provider: "plan-hard-stop",
      authType: "oauth",
      connectionId: "c1",
      providerSpecificData: declared(true),
    },
    CATALOG
  );
  assert.deepEqual(safety, { safe: true, basis: "contract-hard-stop", origin: "static" });
});

test("synthetic no-auth sentinel resolves safe as keyless", () => {
  const safety = resolveConnectionZeroCostSafety(
    { provider: "anything", connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID },
    CATALOG
  );
  assert.deepEqual(safety, { safe: true, basis: "keyless", origin: "static" });
});

test("5: evidence never leaks between two connections of the same provider", () => {
  const a = resolveConnectionZeroCostSafety(
    {
      provider: "uncurated",
      authType: "apikey",
      connectionId: "A",
      providerSpecificData: observed(false),
    },
    CATALOG
  );
  const b = resolveConnectionZeroCostSafety(
    { provider: "uncurated", authType: "apikey", connectionId: "B", providerSpecificData: {} },
    CATALOG
  );
  assert.equal(a.safe, true);
  assert.equal(b.safe, null);
});

test("malformed evidence is treated as no evidence", () => {
  const bad = [
    { billingEvidence: "yes" },
    { billingEvidence: { billingLinked: "false", origin: "operator-declared" } },
    { billingEvidence: { billingLinked: false, origin: "trust-me" } },
    { billingEvidence: { billingLinked: false } },
    { billingEvidence: [] },
    null,
  ];
  for (const providerSpecificData of bad) {
    assert.equal(parseConnectionBillingEvidence(providerSpecificData), null);
  }
});

test("a provider-observed origin is carried through, never rewritten", () => {
  const evidence = parseConnectionBillingEvidence({
    billingEvidence: { billingLinked: false, origin: "provider-observed", observedAt: null },
  });
  assert.deepEqual(evidence, {
    billingLinked: false,
    origin: "provider-observed",
    observedAt: null,
  });
});

// ── ROUTE layer ────────────────────────────────────────────────────────────

const PROVEN: ZeroCostRouteFacts = {
  executable: true,
  compatibleForRequestedHarness: true,
  connectionAvailable: true,
  unhealthy: false,
  quotaExhausted: false,
  localZeroCost: false,
  verifiedFree: true,
  hardStopGuaranteed: true,
  connectionSafeForZeroCost: true,
};

test("every fact proven → eligible", () => {
  assert.deepEqual(evaluateZeroCostRoute(PROVEN), {
    eligible: true,
    reason: "eligible-verified-free",
  });
});

test("1: verifiedFree true with connection safety null → rejected", () => {
  const verdict = evaluateZeroCostRoute({ ...PROVEN, connectionSafeForZeroCost: null });
  assert.deepEqual(verdict, { eligible: false, reason: "connection-safety-unknown" });
});

test("2: verifiedFree true with an unsafe connection → rejected", () => {
  const verdict = evaluateZeroCostRoute({ ...PROVEN, connectionSafeForZeroCost: false });
  assert.deepEqual(verdict, { eligible: false, reason: "connection-unsafe" });
});

test("3: safe connection but hard-stop evidence missing → rejected", () => {
  for (const hardStopGuaranteed of [null, false]) {
    const verdict = evaluateZeroCostRoute({ ...PROVEN, hardStopGuaranteed });
    assert.deepEqual(verdict, { eligible: false, reason: "no-hard-stop" });
  }
});

test("4: one-time-initial trial credit is rejected regardless of connection safety", () => {
  for (const [provider, model] of [
    ["cerebras", "gpt-oss-120b"],
    ["nvidia", "google/gemma-4-31b-it"],
  ]) {
    const verifiedFree = resolveVerifiedFree(provider, model);
    assert.equal(verifiedFree, false);
    const verdict = evaluateZeroCostRoute({ ...PROVEN, verifiedFree });
    assert.deepEqual(verdict, { eligible: false, reason: "model-not-recurring-free" });
  }
});

test("6: a local route ignores external billing facts but not capability gates", () => {
  const local: ZeroCostRouteFacts = {
    ...PROVEN,
    localZeroCost: true,
    verifiedFree: null,
    hardStopGuaranteed: null,
    connectionSafeForZeroCost: null,
  };
  assert.deepEqual(evaluateZeroCostRoute(local), { eligible: true, reason: "eligible-local" });
  assert.equal(evaluateZeroCostRoute({ ...local, executable: null }).reason, "not-executable");
  assert.equal(
    evaluateZeroCostRoute({ ...local, compatibleForRequestedHarness: false }).reason,
    "harness-incompatible"
  );
});

test("7: every unknown cost fact on its own fails closed", () => {
  assert.equal(
    evaluateZeroCostRoute({ ...PROVEN, verifiedFree: null }).reason,
    "model-free-unknown"
  );
  assert.equal(
    evaluateZeroCostRoute({ ...PROVEN, connectionSafeForZeroCost: null }).reason,
    "connection-safety-unknown"
  );
  assert.equal(
    evaluateZeroCostRoute({ ...PROVEN, hardStopGuaranteed: null }).reason,
    "no-hard-stop"
  );
  assert.equal(evaluateZeroCostRoute({ ...PROVEN, localZeroCost: null }).eligible, true); // not local → external rule
});

test("unobserved runtime facts do not reject; observed failures do", () => {
  assert.equal(
    evaluateZeroCostRoute({ ...PROVEN, unhealthy: null, quotaExhausted: null }).eligible,
    true
  );
  assert.equal(evaluateZeroCostRoute({ ...PROVEN, unhealthy: true }).reason, "unhealthy");
  assert.equal(
    evaluateZeroCostRoute({ ...PROVEN, quotaExhausted: true }).reason,
    "quota-exhausted"
  );
});

// ── Real providers against the live catalog ────────────────────────────────

test("gemini key with no stored evidence (today's Shadow state) is not zero-cost eligible", () => {
  const connection = resolveConnectionZeroCostSafety({
    provider: "gemini",
    authType: "apikey",
    connectionId: "shadow-gemini",
    providerSpecificData: {},
  });
  assert.equal(connection.safe, null);
  const verdict = evaluateZeroCostRoute({
    ...PROVEN,
    verifiedFree: resolveVerifiedFree("gemini", "gemini-3.1-flash-lite"),
    hardStopGuaranteed: null,
    connectionSafeForZeroCost: connection.safe,
  });
  assert.equal(verdict.eligible, false);
});

test("groq: model hardStopGuaranteed does not stand in for connection evidence", () => {
  const connection = resolveConnectionZeroCostSafety({
    provider: "groq",
    authType: "apikey",
    connectionId: "groq-1",
    providerSpecificData: {},
  });
  assert.equal(connection.safe, null);
  const verdict = evaluateZeroCostRoute({
    ...PROVEN,
    verifiedFree: resolveVerifiedFree("groq", "openai/gpt-oss-120b"),
    hardStopGuaranteed: true,
    connectionSafeForZeroCost: connection.safe,
  });
  assert.deepEqual(verdict, { eligible: false, reason: "connection-safety-unknown" });
});

test("openrouter: free model evidence does not establish account safety", () => {
  const connection = resolveConnectionZeroCostSafety({
    provider: "openrouter",
    authType: "apikey",
    connectionId: "or-1",
    providerSpecificData: { apiKeyHealth: {} },
  });
  assert.equal(resolveVerifiedFree("openrouter", "cohere/north-mini-code:free"), true);
  assert.equal(connection.safe, null);
});
