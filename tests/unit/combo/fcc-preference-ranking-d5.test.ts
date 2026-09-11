// tests/unit/combo/fcc-preference-ranking-d5.test.ts
//
// O9-F3.3P1-D5 — FCC preferred-candidate ranking wiring.
//
// D5 adds exactly one thing to live scoring: a SOFT `fccPreference` factor,
// hard-gated on the SAME `executable`/`claudeCodeEligible` facts D4's own
// visibility gate requires, route-scoped to coding requests, and shipped at
// DEFAULT weight 0 so routing is byte-identical to pre-D5 until an operator
// (D6) explicitly raises it. These tests prove all of that with REAL D1/D2/D3
// data wherever real data already answers the question (no synthetic
// stand-ins for facts the repo already has), and fall back to the existing,
// unmodified `computeFccRankingSignal` (D0) only to pin the two abstract gate
// properties no real (provider, model) combination can isolate on its own.
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeFccRankingSignal,
  resolveFccPreferenceSignal,
} from "../../../open-sse/services/fccRankingSignal.ts";
import { getFccEvidence } from "../../../open-sse/config/providers/fccCatalog.ts";
import {
  calculateFactors,
  calculateScore,
  DEFAULT_WEIGHTS,
  scorePool,
  type ProviderCandidate,
  type ScoringWeights,
} from "../../../open-sse/services/autoCombo/scoring.ts";
import { scoreAutoTargets } from "../../../open-sse/services/combo/autoStrategy.ts";
import type {
  AutoProviderCandidate,
  ResolvedComboTarget,
} from "../../../open-sse/services/combo/types.ts";

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    provider: "p",
    model: "p/m",
    quotaRemaining: 80,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 500,
    latencyStdDev: 50,
    errorRate: 0,
    ...overrides,
  } as ProviderCandidate;
}

// ── 1. weight=0 -> ranking is byte-identical to pre-D5 ─────────────────────

test("1: DEFAULT_WEIGHTS.fccPreference is 0 — the mechanism ships silent", () => {
  assert.ok("fccPreference" in DEFAULT_WEIGHTS, "must be declared to be settable (D6 activation)");
  assert.equal(DEFAULT_WEIGHTS.fccPreference, 0, "must ship silent");
});

test("1b: weight=0 -> two otherwise-identical candidates score identically regardless of fccPreference", () => {
  const pool = [
    candidate({ provider: "a", model: "a/m", fccPreference: 1 }),
    candidate({ provider: "b", model: "b/m", fccPreference: 0 }),
  ];
  const scores = scorePool(pool, "coding", DEFAULT_WEIGHTS).map((r) => r.score);
  assert.equal(scores[0], scores[1], "weight 0 must leave the ranking exactly as it was");
});

// ── 2. weight>0 -> an FCC-preferred candidate outranks an identical neutral one ──

test("2: weight>0 on a coding route -> the fccPreference candidate outranks an identical neutral one", () => {
  const weights: ScoringWeights = {
    ...DEFAULT_WEIGHTS,
    fccPreference: 0.2,
    health: DEFAULT_WEIGHTS.health - 0.2, // taken from an existing weight, not added (no renormalization test)
  };
  const ranked = scorePool(
    [
      candidate({ provider: "preferred", model: "preferred/m", fccPreference: 1 }),
      candidate({ provider: "neutral", model: "neutral/m", fccPreference: 0 }),
    ],
    "coding",
    weights
  );
  assert.equal(ranked[0].provider, "preferred");
  assert.ok(ranked[0].score > ranked[1].score);
});

// ── 16/17. route scope: coding vs non-coding ────────────────────────────────

test("16: a generic non-coding route gets a neutral (0) FCC factor regardless of the raw signal", () => {
  const c = candidate({ fccPreference: 1 });
  const factors = calculateFactors(c, [c], "default", () => 0.5);
  assert.equal(factors.fccPreference, 0, "non-coding taskType must zero the factor");
});

test("16b: an analysis route also gets a neutral FCC factor (only 'coding' opts in)", () => {
  const c = candidate({ fccPreference: 1 });
  const factors = calculateFactors(c, [c], "analysis", () => 0.5);
  assert.equal(factors.fccPreference, 0);
});

test("17: a coding route lets the raw FCC signal apply", () => {
  const c = candidate({ fccPreference: 1 });
  const factors = calculateFactors(c, [c], "coding", () => 0.5);
  assert.equal(factors.fccPreference, 1);
});

test("17b: calculateScore actually reflects the route-scoped factor end-to-end", () => {
  const c = candidate({ fccPreference: 1 });
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, fccPreference: 0.1 };
  const codingScore = calculateScore(
    calculateFactors(c, [c], "coding", () => 0.5),
    weights
  );
  const defaultScore = calculateScore(
    calculateFactors(c, [c], "default", () => 0.5),
    weights
  );
  assert.ok(
    codingScore > defaultScore,
    "the identical candidate must score higher on the coding route than on the default route, purely from the FCC factor"
  );
});

// ── 5/6. abstract hard-gate contract (pinned on the unmodified D0 function) ─
// These two isolate "executable" and "routeEligible" independently, which no
// single real (provider, model) pair below can do on its own (a real model is
// never simultaneously eligible=true AND executable=false in this registry).
// computeFccRankingSignal itself is untouched since D0 — reusing it here, not
// reimplementing it.

// Real fixture entry (groq/openai/gpt-oss-120b, claudeCode.compatible: true) —
// not a synthetic stand-in, same evidence resolveFccPreferenceSignal itself
// would look up for this pair.
const REAL_POSITIVE_EVIDENCE = getFccEvidence("groq", "openai/gpt-oss-120b");

test("5: executable=false blocks the signal even with routeEligible=true", () => {
  const signal = computeFccRankingSignal(REAL_POSITIVE_EVIDENCE, {
    executable: false,
    routeEligible: true,
  });
  assert.equal(signal.applies, false);
});

test("6: executable=null (unknown) blocks the signal even with routeEligible=true", () => {
  const signal = computeFccRankingSignal(REAL_POSITIVE_EVIDENCE, {
    executable: null,
    routeEligible: true,
  });
  assert.equal(signal.applies, false);
});

test("3/4: routeEligible=false or null blocks the signal even with executable=true", () => {
  for (const routeEligible of [false, null] as const) {
    const signal = computeFccRankingSignal(REAL_POSITIVE_EVIDENCE, {
      executable: true,
      routeEligible,
    });
    assert.equal(signal.applies, false, `routeEligible=${routeEligible} must block`);
  }
});

test("7: FCC-known alone is not enough — an unknown (null) claudeCode verdict yields no boost even though applies=true", () => {
  // applies=true only means "the signal may be consulted" (see the D0 test
  // file's own documentation of this contract) — resolveFccPreferenceSignal
  // must additionally require fccClaudeCodeCompatible === true, not just
  // fccKnown/applies.
  const evidence = {
    fccProviderId: "x",
    fccModelId: "y",
    displayName: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    toolSupport: null,
    reasoningSupport: null,
    structuredOutput: null,
    aliases: null,
    supportedCodingClients: null,
    claudeCode: { compatible: null as boolean | null, evidenceNote: null },
    codex: { compatible: null, evidenceNote: null },
    openCode: { compatible: null, evidenceNote: null },
  };
  const signal = computeFccRankingSignal(evidence, { executable: true, routeEligible: true });
  assert.equal(signal.fccKnown, true, "FCC does know this model");
  assert.equal(signal.applies, true, "the gate passed, so the signal may be consulted");
  assert.equal(
    signal.fccClaudeCodeCompatible,
    null,
    "but FCC itself has no positive Claude Code verdict"
  );
  // The caller contract (resolveFccPreferenceSignal) must not read applies alone as a boost.
});

// ── 8/9. FCC-only / unregistered provider -> no boost (real fixture data) ──

test("8/9: targon (FCC-only, no OmniRoute registry entry) never gets a boost — executable resolves null/false", () => {
  // Real D3/D0 fixture entry: targon/placeholder-model IS known to FCC
  // (claudeCode evidence is null in the fixture itself, but even if it were
  // positive, targon has no Jarvis registry entry at all, so `executable`
  // can never be proven true here).
  const boost = resolveFccPreferenceSignal("targon", "placeholder-model");
  assert.equal(boost, 0);
});

// ── 10. Groq: real registry + real FCC fixture -> still no boost ───────────

test("10: Groq openai/gpt-oss-120b — FCC fixture says claudeCode.compatible=true, but D1/D2 claudeCodeEligible is unseeded (null) for every real Groq model, so the hard gate blocks it", () => {
  const boost = resolveFccPreferenceSignal("groq", "openai/gpt-oss-120b");
  assert.equal(
    boost,
    0,
    "FCC's positive claim must NOT leak through D4.1/D4.2's proven-absent Groq tool-calling evidence"
  );
});

test("10b: every real Groq registry model stays at 0 — matches D4.1/D4.2's 0 true / 0 false / 10 unknown finding exactly", () => {
  const groqModels = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
    "groq/compound",
    "allam-2-7b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3-32b",
    "qwen/qwen3.6-27b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-safeguard-20b",
  ];
  for (const model of groqModels) {
    assert.equal(resolveFccPreferenceSignal("groq", model), 0, `groq/${model} must stay at 0`);
  }
});

// ── 11. Cerebras: real registry + real FCC fixture -> still no boost ───────

test("11: Cerebras gpt-oss-120b — FCC fixture says claudeCode.compatible=true, but Cerebras has zero seeded claudeCodeReady facts (D4.1), so no boost — and this does not touch cost/free classification at all (Cerebras C1 untouched by this module)", () => {
  const boost = resolveFccPreferenceSignal("cerebras", "gpt-oss-120b");
  assert.equal(boost, 0);
});

// ── 12. OpenRouter: no per-model evidence -> no boost, no global whitelist ─

test("12: OpenRouter's static 'auto' entry has no seeded claudeCodeReady fact — no boost, and nothing here grants OpenRouter a blanket unlock", () => {
  const boost = resolveFccPreferenceSignal("openrouter", "auto");
  assert.equal(boost, 0);
});

// ── 3. NVIDIA: a PROVEN false claudeCodeEligible -> no boost (real data) ──

test("3: NVIDIA openai/gpt-oss-120b (registry toolCalling:false, claudeCodeReady:false) never gets a boost", () => {
  const boost = resolveFccPreferenceSignal("nvidia", "openai/gpt-oss-120b");
  assert.equal(boost, 0);
});

// ── positive control: a real, D4.1-seeded true model DOES get a raw signal
// available — but only once FCC also has matching positive evidence, which
// today's illustrative fixture does not carry for Gemini/NVIDIA. This proves
// the mechanism is not permanently inert by construction, only by current
// (documented, D0/D3) data reality — see Schritt 14.

test("positive control: a D4.1-seeded true model with NO FCC evidence also stays at 0 (fccKnown=false, not a mechanism bug)", () => {
  const boost = resolveFccPreferenceSignal("gemini", "gemini-2.5-pro");
  assert.equal(
    boost,
    0,
    "claudeCodeEligible=true alone is not enough — FCC must ALSO have matching positive evidence, and today's fixture has none for gemini"
  );
});

// ── 13/14. quota / status soft penalties remain authority over FCC preference ──

function target(provider: string, model: string, connectionId: string): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `${provider}-${model}-${connectionId}`,
    executionKey: `${provider}/${model}@${connectionId}`,
    modelStr: `${provider}/${model}`,
    provider,
    providerId: null,
    connectionId,
  } as ResolvedComboTarget;
}

function autoCandidate(
  provider: string,
  model: string,
  connectionId: string,
  overrides: Partial<AutoProviderCandidate> = {}
): AutoProviderCandidate {
  return {
    provider,
    model,
    stepId: `${provider}-${model}-${connectionId}`,
    executionKey: `${provider}/${model}@${connectionId}`,
    modelStr: `${provider}/${model}`,
    connectionId,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 1000,
    latencyStdDev: 10,
    errorRate: 0,
    resetWindowAffinity: 0.5,
    connectionPoolSize: 1,
    ...overrides,
  } as AutoProviderCandidate;
}

// A modest, D6-realistic activation weight — on the same order as `quality`
// (0.03) / `specificityMatch` (0.0476), taken from `health` rather than added
// (no renormalization side effects). Deliberately NOT the inflated 0.3 an
// earlier draft of this test used, which manufactured a false failure by
// letting an unrealistically large FCC weight outweigh the EXISTING
// QUOTA_SOFT_DEPRIORITIZE_FACTOR/STATUS_SOFT_DEPRIORITIZE_FACTOR multipliers
// — Schritt 11 explicitly forbids inventing new constants to force this
// property; the fix is a realistic weight, not a magic constant.
const codingWeightsWithFcc: ScoringWeights = {
  ...DEFAULT_WEIGHTS,
  fccPreference: 0.05,
  health: DEFAULT_WEIGHTS.health - 0.05,
};

test("13: an FCC-preferred candidate under the EXISTING B17 quota-soft-penalty flag does NOT outrank a healthy non-preferred one — quota policy remains authority", () => {
  const targets = [
    target("preferred-quota-soft", "m", "conn-a"),
    target("neutral-healthy", "m", "conn-b"),
  ];
  const ranked = scoreAutoTargets(
    targets,
    [
      // quotaSoftPenalty is the actual B17 mechanism (QUOTA_SOFT_DEPRIORITIZE_FACTOR,
      // applied as a post-hoc multiplier in scoreAutoTargets) — not merely a low
      // quotaRemaining percentage, which is a separate, normally-weighted factor.
      autoCandidate("preferred-quota-soft", "m", "conn-a", {
        fccPreference: 1,
        quotaSoftPenalty: true,
      }),
      autoCandidate("neutral-healthy", "m", "conn-b", {
        fccPreference: 0,
      }),
    ],
    "coding",
    codingWeightsWithFcc
  );
  assert.equal(
    ranked[0]?.target.provider,
    "neutral-healthy",
    "existing quota-soft-penalty policy must not be overridden by the new soft FCC preference"
  );
});

test("14: an FCC-preferred but status-penalized (exhausted) candidate does NOT outrank a healthy non-preferred one — status policy remains authority", () => {
  const targets = [
    target("preferred-dead", "m", "dead-conn"),
    target("neutral-healthy", "m", "healthy-conn"),
  ];
  const ranked = scoreAutoTargets(
    targets,
    [
      autoCandidate("preferred-dead", "m", "dead-conn", {
        fccPreference: 1,
        statusPenalty: true,
      }),
      autoCandidate("neutral-healthy", "m", "healthy-conn", {
        fccPreference: 0,
      }),
    ],
    "coding",
    codingWeightsWithFcc
  );
  assert.equal(ranked.length, 2, "soft status penalty must not hard-block the exhausted candidate");
  assert.equal(
    ranked[0]?.target.provider,
    "neutral-healthy",
    "existing status policy must not be overridden by the new soft FCC preference"
  );
});
