/**
 * Availability summary arithmetic and the payload contract the provider cards
 * read it through.
 *
 * The two halves belong in one file because the bug they guard against spans
 * both: the server counts models in one keyspace (provider-stripped ids,
 * deduped across a provider's connections) and the card renders counters from
 * whatever JSON it happens to receive — including responses produced before
 * the catalog join existed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildProviderAvailabilitySummary } from "../../src/lib/modelAvailability/summary.ts";
import { normalizeModelAvailabilitySummary } from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";
import type { ModelAvailabilityProviderSummary } from "../../src/lib/db/modelAvailability.ts";

function counters(
  providerId: string,
  overrides: Partial<ModelAvailabilityProviderSummary> = {}
): ModelAvailabilityProviderSummary {
  return {
    providerId,
    totalChecked: 0,
    available: 0,
    rateLimited: 0,
    quotaExhausted: 0,
    unavailable: 0,
    degraded: 0,
    incompatible: 0,
    blocked: 0,
    ...overrides,
  };
}

test("summary: untested is a set difference, so stale evidence cannot hide work", () => {
  const summary = buildProviderAvailabilitySummary({
    // `retired` was probed months ago and has since left the catalog. Counting
    // `discovered - totalChecked` would report 1 untested instead of 2.
    counters: { openrouter: counters("openrouter", { totalChecked: 2, available: 2 }) },
    syncedModels: { openrouter: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
    checkedModelIds: new Map([["openrouter", new Set(["alpha", "retired"])]]),
    hiddenModelIds: new Map(),
  });

  assert.equal(summary.openrouter.discovered, 3);
  assert.equal(summary.openrouter.untested, 2);
  assert.equal(summary.openrouter.totalChecked, 2);
});

test("summary: the same model across several connections is one catalog entry", () => {
  // Three connections all serving the same 2 models. `getModelAvailabilitySummaryByProvider`
  // already dedupes by model id, so `totalChecked` is 2 — NOT 6 — and the
  // catalog-relative counts must agree with that keyspace.
  const summary = buildProviderAvailabilitySummary({
    counters: { gemini: counters("gemini", { totalChecked: 2, available: 2 }) },
    syncedModels: { gemini: [{ id: "flash" }, { id: "pro" }, { id: "ultra" }] },
    checkedModelIds: new Map([["gemini", new Set(["flash", "pro"])]]),
    hiddenModelIds: new Map(),
  });

  assert.equal(summary.gemini.discovered, 3);
  assert.equal(summary.gemini.untested, 1);
  assert.ok(
    summary.gemini.untested <= summary.gemini.discovered,
    "untested is bounded by discovered by construction"
  );
});

test("summary: hidden models are not work the sweep owes", () => {
  const summary = buildProviderAvailabilitySummary({
    counters: { openrouter: counters("openrouter") },
    syncedModels: {
      openrouter: [{ id: "visible" }, { id: "hidden-plain" }, { id: "openrouter/hidden-prefixed" }],
    },
    checkedModelIds: new Map(),
    // Hidden lists are written from catalog ids, in either spelling.
    hiddenModelIds: new Map([
      ["openrouter", new Set(["hidden-plain", "openrouter/hidden-prefixed"])],
    ]),
  });

  assert.equal(summary.openrouter.discovered, 1);
  assert.equal(summary.openrouter.untested, 1);
});

test("summary: catalog ids are normalized before being compared to evidence", () => {
  const summary = buildProviderAvailabilitySummary({
    counters: { openrouter: counters("openrouter", { totalChecked: 1, available: 1 }) },
    // The catalog carries the prefixed spelling, the inventory the stripped one.
    syncedModels: { openrouter: [{ id: "openrouter/alpha:free" }, { id: "beta:free" }] },
    checkedModelIds: new Map([["openrouter", new Set(["alpha:free"])]]),
    hiddenModelIds: new Map(),
  });

  assert.equal(summary.openrouter.discovered, 2);
  assert.equal(summary.openrouter.untested, 1);
});

test("summary: duplicate and blank catalog rows do not inflate the count", () => {
  const summary = buildProviderAvailabilitySummary({
    counters: {},
    syncedModels: {
      groq: [{ id: "alpha" }, { id: "alpha" }, { id: "  " }, { id: "groq/alpha" }, { id: "beta" }],
    },
    checkedModelIds: new Map(),
    hiddenModelIds: new Map(),
  });

  assert.equal(summary.groq.discovered, 2);
  assert.equal(summary.groq.untested, 2);
  // A provider with catalog entries but no counters row still reports zeroes
  // rather than being missing from the response.
  assert.equal(summary.groq.totalChecked, 0);
});

test("summary: a provider with evidence but no synced catalog is still reported", () => {
  const summary = buildProviderAvailabilitySummary({
    counters: { retired: counters("retired", { totalChecked: 4, unavailable: 4 }) },
    syncedModels: {},
    checkedModelIds: new Map([["retired", new Set(["a", "b", "c", "d"])]]),
    hiddenModelIds: new Map(),
  });

  assert.equal(summary.retired.discovered, 0);
  assert.equal(summary.retired.untested, 0);
  assert.equal(summary.retired.unavailable, 4);
});

test("card payload: a legacy response without the catalog join keeps its badges", () => {
  // Pre-R59 `/api/models/availability` had no `discovered`/`untested`.
  const normalized = normalizeModelAvailabilitySummary({
    openrouter: {
      providerId: "openrouter",
      totalChecked: 12,
      available: 9,
      rateLimited: 1,
      quotaExhausted: 2,
      unavailable: 0,
      degraded: 0,
      incompatible: 0,
      blocked: 0,
    },
  });

  const entry = normalized.openrouter as Record<string, unknown>;
  assert.equal(entry.quotaExhausted, 2);
  assert.equal(entry.rateLimited, 1);
  // Absent must stay absent: `0` would claim "the catalog is fully probed",
  // which is a different statement from "this response cannot say".
  assert.equal(Object.hasOwn(entry, "discovered"), false);
  assert.equal(Object.hasOwn(entry, "untested"), false);
});

test("card payload: malformed counters degrade to 0 instead of NaN", () => {
  const normalized = normalizeModelAvailabilitySummary({
    openrouter: {
      totalChecked: "7",
      available: null,
      rateLimited: "not-a-number",
      quotaExhausted: -3,
      unavailable: 2.9,
    },
    broken: "nope",
    alsoBroken: [1, 2, 3],
  });

  const entry = normalized.openrouter as Record<string, unknown>;
  assert.equal(entry.providerId, "openrouter");
  assert.equal(entry.totalChecked, 7);
  assert.equal(entry.available, 0);
  assert.equal(entry.rateLimited, 0);
  assert.equal(entry.quotaExhausted, 0);
  assert.equal(entry.unavailable, 2);
  // `quotaExhausted + rateLimited` is computed in the card; every operand must
  // be a real number.
  assert.equal(Number.isFinite(Number(entry.quotaExhausted) + Number(entry.rateLimited)), true);
  assert.equal(Object.hasOwn(normalized, "broken"), false);
  assert.equal(Object.hasOwn(normalized, "alsoBroken"), false);
});

test("card payload: a missing or non-object summary is an empty map", () => {
  assert.deepEqual(normalizeModelAvailabilitySummary(undefined), {});
  assert.deepEqual(normalizeModelAvailabilitySummary(null), {});
  assert.deepEqual(normalizeModelAvailabilitySummary("nope"), {});
  assert.deepEqual(normalizeModelAvailabilitySummary([{ providerId: "x" }]), {});
});
