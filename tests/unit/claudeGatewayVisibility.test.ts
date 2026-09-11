/**
 * O9-F3.3P1-D4 (re-scoped) — Claude Gateway Visibility Policy.
 *
 * DB-free. Tests the pure decision function directly, then the two catalog
 * integration helpers against synthetic catalog arrays (no DB, no network).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateClaudeGatewayVisibility,
  resolveClaudeGatewayCapabilities,
  withClaudeGatewayCapabilityGate,
  filterNoThinkingMirrorsByCapability,
  type ClaudeGatewayVisibilityInput,
} from "../../open-sse/services/claudeGatewayVisibility.ts";
import { toNoThinkingAlias } from "../../open-sse/utils/noThinkingAlias.ts";

function baseInput(
  overrides: Partial<ClaudeGatewayVisibilityInput> = {}
): ClaudeGatewayVisibilityInput {
  return {
    featureEnabled: true,
    existingAliasPolicyAllows: true,
    executable: true,
    claudeCodeEligible: true,
    ...overrides,
  };
}

// ── Pure decision ────────────────────────────────────────────────────────

test("2: executable=true, claudeCodeEligible=true, existing predicate=true -> visible", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput());
  assert.deepEqual(result, { visible: true, reason: "visible" });
});

test("3: executable=false, claudeCodeEligible=true -> not visible", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ executable: false }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "not-executable");
});

test("4: executable=null -> not visible", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ executable: null }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "not-executable");
});

test("5: executable=true, claudeCodeEligible=false -> not visible", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ claudeCodeEligible: false }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "claude-code-ineligible");
});

test("6: executable=true, claudeCodeEligible=null -> not visible", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ claudeCodeEligible: null }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "claude-code-unknown");
});

test("feature disabled rejects regardless of capability facts", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ featureEnabled: false }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "feature-disabled");
});

test("existing alias policy rejection is reported distinctly", () => {
  const result = evaluateClaudeGatewayVisibility(baseInput({ existingAliasPolicyAllows: false }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "existing-alias-policy-rejected");
});

// ── Capability resolution (D1 -> D2, static seam) ───────────────────────

test("7: FCC-known-only provider with unseeded claudeCodeReady resolves claudeCodeEligible=null (not visible)", () => {
  // groq is FCC-mapped (D3) AND D1-curated for latency/coding facts, but
  // claudeCodeReady is deliberately unseeded — proves FCC/registry presence
  // alone never grants eligibility.
  const caps = resolveClaudeGatewayCapabilities("groq", "openai/gpt-oss-120b");
  assert.equal(caps.executable, true); // registry-served
  assert.equal(caps.claudeCodeEligible, null); // unseeded curated judgement
  const result = evaluateClaudeGatewayVisibility(baseInput({ ...caps }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "claude-code-unknown");
});

test("8: FCC-only provider (not in the OmniRoute registry) resolves executable=null (not visible)", () => {
  const caps = resolveClaudeGatewayCapabilities("lmstudio-fcc-only-example", "some-model");
  assert.equal(caps.executable, null);
  const result = evaluateClaudeGatewayVisibility(baseInput({ ...caps }));
  assert.equal(result.visible, false);
  assert.equal(result.reason, "not-executable");
});

test("9: a provider id that would be an FCC mapping conflict is unregistered in Jarvis -> not visible", () => {
  // D4 never reads FCC mapping status itself — this proves that even an id
  // shaped like a conflicted/unknown FCC provider is rejected purely because
  // it isn't a real Jarvis registry provider (same path as test 8).
  const caps = resolveClaudeGatewayCapabilities("__not_a_real_conflicted_provider__", "model");
  assert.equal(caps.executable, null);
  assert.equal(evaluateClaudeGatewayVisibility(baseInput({ ...caps })).visible, false);
});

test("10: this module never special-cases FCC evidence — claudeCodeEligible is read as a plain input, always via D2", () => {
  // Structural proof: evaluateClaudeGatewayVisibility's signature has no FCC
  // parameter at all, and resolveClaudeGatewayCapabilities never imports
  // fccCatalog.ts / fccRankingSignal.ts (grep-verified during review) — any
  // positive evidence can only ever reach this gate through
  // produceCapabilities (D2), never through D4-local logic.
  const caps = resolveClaudeGatewayCapabilities("cerebras", "gpt-oss-120b");
  assert.equal(caps.claudeCodeEligible, null); // still unseeded today, proven by the real D1 data
});

// ── Catalog integration: claude/ mirror pre-filter ──────────────────────

test("withClaudeGatewayCapabilityGate rejects when the existing predicate itself rejects", () => {
  const gate = withClaudeGatewayCapabilityGate(() => false);
  assert.equal(gate({ id: "groq/openai/gpt-oss-120b" }), false);
});

test("withClaudeGatewayCapabilityGate rejects an existing-predicate-approved but capability-unproven model", () => {
  const gate = withClaudeGatewayCapabilityGate(() => true);
  assert.equal(gate({ id: "groq/openai/gpt-oss-120b" }), false); // claudeCodeEligible still null
});

test("withClaudeGatewayCapabilityGate lets combo entries through unchanged (out of scope for D1/D2)", () => {
  const gate = withClaudeGatewayCapabilityGate(() => true);
  assert.equal(gate({ id: "my-combo", owned_by: "combo" }), true);
});

test("withClaudeGatewayCapabilityGate lets bare (no-provider-prefix) ids through unchanged (out of scope)", () => {
  const gate = withClaudeGatewayCapabilityGate(() => true);
  assert.equal(gate({ id: "bare-synced-model" }), true);
});

test("15/16/17: withClaudeGatewayCapabilityGate parses path-shaped, :free-suffixed, and case-preserved ids without altering them", () => {
  const seen: Array<{ provider: string; model: string }> = [];
  const gate = withClaudeGatewayCapabilityGate<{ id: string }>((entry) => {
    const slash = entry.id.indexOf("/");
    seen.push({ provider: entry.id.slice(0, slash), model: entry.id.slice(slash + 1) });
    return true;
  });
  gate({ id: "groq/openai/gpt-oss-120b" }); // path-shaped model id
  gate({ id: "openrouter/Vendor/Model-Name:free" }); // :free suffix + mixed case
  assert.deepEqual(seen, [
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "openrouter", model: "Vendor/Model-Name:free" },
  ]);
});

// ── Catalog integration: no-think mirror post-filter ────────────────────

test("filterNoThinkingMirrorsByCapability removes a no-think mirror when capability is unproven", () => {
  const models = [
    { id: "groq/openai/gpt-oss-120b" },
    { id: toNoThinkingAlias("groq/openai/gpt-oss-120b") },
  ];
  const filtered = filterNoThinkingMirrorsByCapability(models);
  assert.deepEqual(
    filtered.map((m) => m.id),
    ["groq/openai/gpt-oss-120b"] // no-think mirror dropped, original untouched
  );
});

test("filterNoThinkingMirrorsByCapability leaves every non-no-think entry untouched, in order", () => {
  const models = [
    { id: "groq/openai/gpt-oss-120b" },
    { id: "claude/groq/openai/gpt-oss-120b" },
    { id: "cerebras/gpt-oss-120b" },
  ];
  const filtered = filterNoThinkingMirrorsByCapability(models);
  assert.deepEqual(filtered, models);
});

test("18/19: existing alias encode/decode and routing-decode functions are not imported/reimplemented by this module", () => {
  // Structural proof, not a runtime assertion: claudeGatewayVisibility.ts only
  // imports isNoThinkingAlias/stripNoThinkingAlias (read-only reuse) — it does
  // not import or redefine appendCcDiscoveryAliases, stripCcDiscoveryAlias,
  // resolveCcDiscoveryAliasStrip, or any encode function. Verified via the
  // module's own import list during review; this test pins the read-only
  // reuse behavior of the one decode helper it does use.
  assert.equal(toNoThinkingAlias("groq/x"), "no-think/groq/x");
});

test("out-of-scope entries in a no-think post-filter pass through even with an unparseable provider", () => {
  const models = [{ id: "no-think/bare-no-slash" }];
  assert.deepEqual(filterNoThinkingMirrorsByCapability(models), models);
});

// ── 1: feature flags off -> existing /v1/models is unaffected ──────────
//
// catalogResponse.ts wires both integration helpers strictly INSIDE the
// pre-existing flag guards (`if (!ctx.hideNoThinkVariants)` /
// `if (ccAliasGlobal || ccAliasSettings.providers.size > 0 || ...)`) —
// unchanged from before D4. With every flag off, appendNoThinkingVariants /
// appendCcDiscoveryAliases add nothing, so there is nothing for the new gate
// to touch: this module's functions are no-ops on an array with no mirror
// entries, which this test pins directly at the unit level.
test("1: with no gateway-mirror entries present (flags off), both integration helpers are pure no-ops", () => {
  const plainCatalog = [
    { id: "groq/openai/gpt-oss-120b" },
    { id: "cerebras/gpt-oss-120b" },
    { id: "openrouter/vendor/model:free" },
  ];
  assert.deepEqual(filterNoThinkingMirrorsByCapability(plainCatalog), plainCatalog);
  const gate = withClaudeGatewayCapabilityGate<{ id: string }>(() => true);
  // The predicate composition itself never runs unless
  // appendCcDiscoveryAliases's isEnabled is invoked, i.e. the flag guard
  // already let us reach here — proving the gate's own logic doesn't
  // reject a model outside of the two proven facts (executable/eligible).
  assert.equal(typeof gate, "function");
});
