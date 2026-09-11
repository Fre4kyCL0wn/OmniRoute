/**
 * O9-F3.3P1-D0 — FCC preferred-candidate ranking signal.
 *
 * Verifies FCC compatibility evidence can only ever ADD a soft signal after
 * hard eligibility already passed — it never bypasses quota/health/eligibility
 * gates (those aren't even inputs to this module).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeFccRankingSignal } from "../../open-sse/services/fccRankingSignal.ts";
import { getFccEvidence } from "../../open-sse/config/providers/fccCatalog.ts";

const KNOWN_COMPATIBLE = getFccEvidence("groq", "openai/gpt-oss-120b");
const UNKNOWN = getFccEvidence("groq", "does-not-exist");

test("FCC evidence can raise ranking once hard eligibility already passed", () => {
  const signal = computeFccRankingSignal(KNOWN_COMPATIBLE, {
    executable: true,
    routeEligible: true,
  });
  assert.equal(signal.fccKnown, true);
  assert.equal(signal.fccClaudeCodeCompatible, true);
  assert.equal(signal.applies, true);
});

test("FCC-known model does NOT bypass a failed executable gate (e.g. quota-driven unavailability)", () => {
  const signal = computeFccRankingSignal(KNOWN_COMPATIBLE, {
    executable: false,
    routeEligible: true,
  });
  assert.equal(signal.fccKnown, true);
  assert.equal(signal.applies, false);
});

test("FCC-known model does NOT bypass an unproven executable gate (unknown health/registry state)", () => {
  const signal = computeFccRankingSignal(KNOWN_COMPATIBLE, {
    executable: null,
    routeEligible: true,
  });
  assert.equal(signal.applies, false);
});

test("FCC-known model does NOT bypass route eligibility (e.g. codingEligible false)", () => {
  const signal = computeFccRankingSignal(KNOWN_COMPATIBLE, {
    executable: true,
    routeEligible: false,
  });
  assert.equal(signal.applies, false);
});

test("a model FCC proves incompatible remains excluded even if hard eligibility passed", () => {
  const incompatible = {
    fccProviderId: "groq",
    fccModelId: "some-non-cc-model",
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
    claudeCode: { compatible: false as boolean | null, evidenceNote: "fixture-illustrative" },
    codex: { compatible: null, evidenceNote: null },
    openCode: { compatible: null, evidenceNote: null },
  };
  const signal = computeFccRankingSignal(incompatible, { executable: true, routeEligible: true });
  assert.equal(signal.fccClaudeCodeCompatible, false);
  // applies=true only means "the signal may be consulted" — a false verdict
  // must not be read as a ranking boost by a caller. This test documents the
  // caller contract: check the specific *Compatible field, not just `applies`.
  assert.equal(signal.applies, true);
});

test("unknown FCC evidence never fabricates a positive signal", () => {
  const signal = computeFccRankingSignal(UNKNOWN, { executable: true, routeEligible: true });
  assert.equal(signal.fccKnown, false);
  assert.equal(signal.fccClaudeCodeCompatible, null);
  assert.equal(signal.applies, false);
});

test("null evidence with failed gate stays inapplicable", () => {
  const signal = computeFccRankingSignal(null, { executable: false, routeEligible: false });
  assert.equal(signal.applies, false);
});
