/**
 * O9-F3.3P1-D0 — Evidence source priority resolver.
 *
 * Pure, no IO. Verifies FCC evidence can win for coding-compat but is
 * structurally unable to win for cost/free (Schritt 4 hard invariant).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CODING_COMPAT_SOURCE_PRIORITY,
  COST_FREE_SOURCE_PRIORITY,
  isSourceEligibleFor,
  resolveBySourcePriority,
  type SourcedValue,
} from "../../open-sse/services/evidenceSource.ts";

test("higher-priority source wins even when a lower-priority source also has a value", () => {
  const candidates: SourcedValue<boolean>[] = [
    { source: "omniroute_registry", value: false },
    { source: "fcc_catalog", value: true },
    { source: "shadow_validation", value: true },
  ];
  const resolved = resolveBySourcePriority(candidates, CODING_COMPAT_SOURCE_PRIORITY);
  assert.equal(resolved?.source, "shadow_validation");
  assert.equal(resolved?.value, true);
});

test("FCC evidence can win coding-compat when nothing higher-priority is proven", () => {
  const candidates: SourcedValue<boolean>[] = [
    { source: "fcc_catalog", value: true },
    { source: "models_dev", value: null },
  ];
  const resolved = resolveBySourcePriority(candidates, CODING_COMPAT_SOURCE_PRIORITY);
  assert.equal(resolved?.source, "fcc_catalog");
  assert.equal(resolved?.value, true);
});

test("unproven (null/undefined) candidates never win, even from the top-priority source", () => {
  const candidates: SourcedValue<boolean>[] = [
    { source: "shadow_validation", value: null },
    { source: "fcc_catalog", value: undefined },
    { source: "omniroute_registry", value: true },
  ];
  const resolved = resolveBySourcePriority(candidates, CODING_COMPAT_SOURCE_PRIORITY);
  assert.equal(resolved?.source, "omniroute_registry");
});

test("no proven candidate anywhere resolves to null (unknown stays unknown)", () => {
  const candidates: SourcedValue<boolean>[] = [{ source: "fcc_catalog", value: null }];
  assert.equal(resolveBySourcePriority(candidates, CODING_COMPAT_SOURCE_PRIORITY), null);
});

test("FCC evidence CANNOT win cost/free — it is not in COST_FREE_SOURCE_PRIORITY at all", () => {
  assert.equal(isSourceEligibleFor("fcc_catalog", COST_FREE_SOURCE_PRIORITY), false);

  // Even a maximally confident FCC claim (e.g. "this is recurring-free") is
  // ignored for the cost dimension; only the verified sources resolve.
  const candidates: SourcedValue<string>[] = [
    { source: "fcc_catalog", value: "recurring-free" },
    { source: "omniroute_registry", value: "paid" },
  ];
  const resolved = resolveBySourcePriority(candidates, COST_FREE_SOURCE_PRIORITY);
  assert.equal(resolved?.source, "omniroute_registry");
  assert.equal(resolved?.value, "paid");
});

test("cost/free resolves to unknown, never to FCC's claim, when no verified source is proven", () => {
  const candidates: SourcedValue<string>[] = [{ source: "fcc_catalog", value: "recurring-free" }];
  assert.equal(resolveBySourcePriority(candidates, COST_FREE_SOURCE_PRIORITY), null);
});

test("manual_verified outranks shadow_validation for cost/free", () => {
  const candidates: SourcedValue<string>[] = [
    { source: "shadow_validation", value: "free_tier" },
    { source: "manual_verified", value: "paid" },
  ];
  const resolved = resolveBySourcePriority(candidates, COST_FREE_SOURCE_PRIORITY);
  assert.equal(resolved?.source, "manual_verified");
  assert.equal(resolved?.value, "paid");
});
