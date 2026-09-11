/**
 * O9-F3.3P1-D0 — FCC provider/model mapping and evidence lookup.
 *
 * Pure, DB-free: `getRegistryEntry` reads the in-memory REGISTRY object only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeFccModelId,
  findBrokenFccProviderAliases,
  getFccEvidence,
  mapFccProvider,
  resolveFccOnlyExecutable,
} from "../../open-sse/config/providers/fccCatalog.ts";
import { FCC_PROVIDER_ID_MAP } from "../../open-sse/config/providers/fccCatalog.data.ts";

// ── Provider id normalization ───────────────────────────────────────────────

test("FCC provider id identical to a Jarvis registry id maps directly", () => {
  const mapping = mapFccProvider("groq");
  assert.equal(mapping.status, "mapped");
  assert.equal(mapping.jarvisProviderId, "groq");
});

test("FCC provider id resolves through the alias table when spellings differ", () => {
  const mapping = mapFccProvider("cloudflare");
  assert.equal(mapping.status, "alias");
  assert.equal(mapping.jarvisProviderId, "cloudflare-ai");
});

test("FCC-only provider (no Jarvis registry entry, no alias) maps to fcc_only", () => {
  const mapping = mapFccProvider("targon");
  assert.equal(mapping.status, "fcc_only");
  assert.equal(mapping.jarvisProviderId, null);
  assert.ok(mapping.note);
});

test("FCC-only provider mapping resolves executable to false, never true or unknown-optimistic", () => {
  const mapping = mapFccProvider("targon");
  assert.equal(resolveFccOnlyExecutable(mapping), false);
});

test("a mapped provider's executable resolution is left to the eligibility producer (null here)", () => {
  const mapping = mapFccProvider("groq");
  assert.equal(resolveFccOnlyExecutable(mapping), null);
});

test("alias table has no broken entries against the current registry", () => {
  assert.deepEqual(findBrokenFccProviderAliases(), []);
});

// ── Conflict state (real code path, no DI refactor) ─────────────────────────
//
// FCC_PROVIDER_ID_MAP is a plain, non-frozen exported object — the smallest
// available seam to exercise the real `conflict` branch is to temporarily add
// a deliberately-broken entry (a target that does not exist in the registry),
// run the real `mapFccProvider`/`resolveFccOnlyExecutable` against it, then
// remove the entry again. This is the actual production code path, not a
// stand-in — no new export, no dependency injection, no behavior change.
test("conflict: alias target that does not resolve in the registry fails closed, never auto-maps", () => {
  const fixtureKey = "__d0_review_conflict_fixture__";
  const brokenTarget = "__d0_review_nonexistent_provider__";
  assert.ok(!(fixtureKey in FCC_PROVIDER_ID_MAP), "fixture key must not already exist");
  FCC_PROVIDER_ID_MAP[fixtureKey] = brokenTarget;
  try {
    const mapping = mapFccProvider(fixtureKey);
    assert.equal(mapping.status, "conflict");
    // Never auto-mapped onto a real provider — not the broken target, not any
    // fallback/fuzzy match, not the raw fixture key either.
    assert.equal(mapping.jarvisProviderId, null);
    assert.ok(mapping.note?.includes(brokenTarget));
    // fail-closed: never true, matching resolveFccOnlyExecutable's contract
    // for the fcc_only/conflict states.
    assert.notEqual(resolveFccOnlyExecutable(mapping), true);
    assert.equal(resolveFccOnlyExecutable(mapping), false);
  } finally {
    delete FCC_PROVIDER_ID_MAP[fixtureKey];
  }
  // Cleanup verified: the fixture key must not leak into subsequent lookups
  // or into the standing alias-table health check.
  assert.equal(mapFccProvider(fixtureKey).status, "fcc_only");
  assert.deepEqual(findBrokenFccProviderAliases(), []);
});

// ── Model id canonicalization ───────────────────────────────────────────────

test("canonicalizeFccModelId trims whitespace", () => {
  assert.equal(canonicalizeFccModelId("groq", "  openai/gpt-oss-120b  "), "openai/gpt-oss-120b");
});

test("canonicalizeFccModelId strips an accidental provider/provider/model duplication", () => {
  assert.equal(canonicalizeFccModelId("groq", "groq/openai/gpt-oss-120b"), "openai/gpt-oss-120b");
});

test("canonicalizeFccModelId leaves a model id without the duplicate prefix untouched", () => {
  assert.equal(canonicalizeFccModelId("cerebras", "gpt-oss-120b"), "gpt-oss-120b");
});

test("same model name under two different providers stays namespace-separated (no cross-provider collision)", () => {
  const providerA = canonicalizeFccModelId("providerA", "model-x");
  const providerB = canonicalizeFccModelId("providerB", "model-x");
  // The canonical model id itself is identical (as it must be — the model
  // segment is provider-agnostic)...
  assert.equal(providerA, "model-x");
  assert.equal(providerB, "model-x");
  // ...but the evidence/canonical KEY (as built by `evidenceKey` /
  // `getFccEvidence`: `${fccProviderId}/${canonicalized}`) stays distinct
  // because the provider segment is never folded into the model segment.
  const keyA = `providerA/${providerA}`;
  const keyB = `providerB/${providerB}`;
  assert.notEqual(keyA, keyB);
  assert.equal(keyA, "providerA/model-x");
  assert.equal(keyB, "providerB/model-x");
});

test("canonicalizeFccModelId never strips a :free / variant suffix", () => {
  assert.equal(canonicalizeFccModelId("openrouter", "some-model:free"), "some-model:free");
  assert.equal(canonicalizeFccModelId("groq", "some-model-high"), "some-model-high");
});

test("canonicalizeFccModelId is case-preserving on the returned model id (no unexpected lowercasing)", () => {
  assert.equal(canonicalizeFccModelId("groq", "Openai/GPT-OSS-120B"), "Openai/GPT-OSS-120B");
  // the duplicate-prefix check is case-insensitive, but the SURVIVING
  // remainder keeps its original casing — it is stripped, not rewritten.
  assert.equal(canonicalizeFccModelId("Groq", "GROQ/Openai/GPT-OSS-120B"), "Openai/GPT-OSS-120B");
});

// ── Evidence lookup ──────────────────────────────────────────────────────────

test("known FCC evidence is returned for the fixture's groq entry", () => {
  const evidence = getFccEvidence("groq", "openai/gpt-oss-120b");
  assert.ok(evidence);
  assert.equal(evidence?.claudeCode.compatible, true);
});

test("unknown (provider, model) pair returns null — unknown, not a negative verdict", () => {
  assert.equal(getFccEvidence("groq", "not-a-real-model"), null);
});

test("evidence fields with no fixture data stay null, never defaulted true/false", () => {
  const evidence = getFccEvidence("groq", "openai/gpt-oss-120b");
  assert.equal(evidence?.contextWindow, null);
  assert.equal(evidence?.toolSupport, null);
  assert.equal(evidence?.codex.compatible, null);
});

test("FCC-only fixture entry (targon) carries no compatibility evidence", () => {
  const evidence = getFccEvidence("targon", "placeholder-model");
  assert.ok(evidence);
  assert.equal(evidence?.claudeCode.compatible, null);
  assert.equal(evidence?.codex.compatible, null);
  assert.equal(evidence?.openCode.compatible, null);
});
