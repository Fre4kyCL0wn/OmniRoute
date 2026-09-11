/**
 * O9-F3.3P1-D0 — FCC integration with the real D1/D2 eligibility pipeline.
 *
 * These tests exercise `fccCatalog.ts` / `fccRankingSignal.ts` together with
 * the ACTUAL `extractProviderModelInfo` (D1) / `produceCapabilities` (D2)
 * functions already wired into `providerRuntimeState.ts` — not stand-ins —
 * so a future change to either side that breaks the "FCC never overrides
 * hard eligibility" contract fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractProviderModelInfo } from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import {
  getFccEvidence,
  mapFccProvider,
  resolveFccOnlyExecutable,
} from "../../open-sse/config/providers/fccCatalog.ts";
import { computeFccRankingSignal } from "../../open-sse/services/fccRankingSignal.ts";

test("FCC-only provider (targon) resolves executable=null via the real D1/D2 pipeline, matching resolveFccOnlyExecutable's fail-closed false", () => {
  const mapping = mapFccProvider("targon");
  assert.equal(mapping.status, "fcc_only");
  assert.equal(resolveFccOnlyExecutable(mapping), false);

  // The real pipeline: unregistered provider -> executable is unknown (null),
  // never an optimistic true. Both resolveFccOnlyExecutable (false) and the
  // real producer (null) agree on the outcome that matters: NOT executable.
  const info = extractProviderModelInfo("targon", "placeholder-model");
  const caps = produceCapabilities(info);
  assert.equal(caps.executable, null);
});

test("FCC-known + verified model does NOT bypass a real quota/health-driven executable=false", () => {
  // groq/openai/gpt-oss-120b IS served by groq (registry-proven), so in
  // isolation executable would be true. Simulate the runtime-state pipeline
  // having already proven it currently unavailable (quota/health) by passing
  // that real gate value straight through — FCC evidence must not override it.
  const evidence = getFccEvidence("groq", "openai/gpt-oss-120b");
  assert.ok(evidence);

  const signalWhenUnavailable = computeFccRankingSignal(evidence, {
    executable: false,
    routeEligible: true,
  });
  assert.equal(signalWhenUnavailable.applies, false);

  const info = extractProviderModelInfo("groq", "openai/gpt-oss-120b");
  const caps = produceCapabilities(info);
  // The real pipeline proves this model executable (groq registry-served) —
  // ranking may apply only against THIS real value, never FCC's own opinion.
  assert.equal(caps.executable, true);
  const signalWhenReallyEligible = computeFccRankingSignal(evidence, {
    executable: caps.executable,
    routeEligible: caps.claudeCodeEligible ?? false,
  });
  // claudeCodeEligible is still null in the real pipeline (D1 curated seed
  // has no claudeCodeReady fact for groq yet) — so the route gate is false
  // and the signal correctly does not apply, even though FCC says compatible.
  assert.equal(caps.claudeCodeEligible, null);
  assert.equal(signalWhenReallyEligible.applies, false);
});

test("FCC evidence never changes the real producer's verdict for a model it has no opinion on", () => {
  const noEvidence = getFccEvidence("cerebras", "zai-glm-4.7");
  assert.equal(noEvidence, null);
  const info = extractProviderModelInfo("cerebras", "zai-glm-4.7");
  const caps = produceCapabilities(info);
  // Unchanged from the pre-FCC D2 behavior for this model.
  assert.equal(caps.codingEligible, null);
});
