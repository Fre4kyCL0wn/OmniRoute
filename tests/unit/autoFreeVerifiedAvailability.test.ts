/**
 * Fail-closed free-tier admission (`OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY`).
 *
 * The filter is exercised against the REAL persistence path — probes are
 * written with `recordModelTestAvailability` and read back through the
 * production `getModelAvailabilityInventory` — because the defect this guard
 * protects against is not "does the predicate work" but "does the id the
 * router asks for match the id the recorder wrote". A hand-built inventory
 * fixture cannot fail that way, and would have hidden the `provider/model`
 * normalization mismatch entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-free-verified-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_FLAG = process.env.OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const availabilityDb = await import("../../src/lib/db/modelAvailability.ts");
const virtualFactory = await import("../../open-sse/services/autoCombo/virtualFactory.ts");
const resilience = await import("../../open-sse/services/autoCombo/resilienceCandidateFilter.ts");

const NOAUTH = resilience.SYNTHETIC_NOAUTH_CONNECTION_ID;

type Candidate = Parameters<
  typeof virtualFactory.filterVerifiedFreeAvailabilityCandidates
>[0][number];

function candidate(
  overrides: Partial<Candidate> & Pick<Candidate, "provider" | "model">
): Candidate {
  return {
    connectionId: null,
    modelStr: `${overrides.provider}/${overrides.model}`,
    costPer1MTokens: 0,
    ...overrides,
  } as Candidate;
}

function probeOk(providerId: string, connectionId: string, modelId: string) {
  return availabilityDb.recordModelTestAvailability({
    providerId,
    connectionId,
    modelId,
    result: { status: "ok", httpStatus: 200 },
    source: "batch_test",
  });
}

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_FLAG === undefined)
    delete process.env.OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY;
  else process.env.OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY = ORIGINAL_FLAG;
});

test("verified-free flag is off by default and reads only explicit truthy values", () => {
  assert.equal(virtualFactory.isVerifiedFreeAvailabilityRequired({}), false);
  for (const value of ["1", "true", "TRUE", "  True  ", "yes", "on", "ON"]) {
    assert.equal(
      virtualFactory.isVerifiedFreeAvailabilityRequired({
        OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY: value,
      }),
      true,
      `${JSON.stringify(value)} should enable the gate`
    );
  }
  for (const value of ["", " ", "0", "false", "off", "no", "maybe", "enabled-later"]) {
    assert.equal(
      virtualFactory.isVerifiedFreeAvailabilityRequired({
        OMNIROUTE_AUTO_FREE_REQUIRE_VERIFIED_AVAILABILITY: value,
      }),
      false,
      `${JSON.stringify(value)} must NOT enable the gate`
    );
  }
});

test("every id that promises free-only routing resolves to the same free intent", () => {
  assert.equal(virtualFactory.isFreeTierIntent({ tier: "free" }), true);
  assert.equal(virtualFactory.isFreeTierIntent({ category: "coding", tier: "free" }), true);
  assert.equal(virtualFactory.isFreeTierIntent({ tier: "subscription" }), false);
  assert.equal(virtualFactory.isFreeTierIntent({ tier: "thrifty" }), false);
  assert.equal(virtualFactory.isFreeTierIntent({ category: "coding" }), false);
  assert.equal(virtualFactory.isFreeTierIntent(undefined), false);
});

test("auto/best-free carries the same free intent as auto/<category>:free", async () => {
  const builtin = await import("../../open-sse/services/autoCombo/builtinCatalog.ts");
  // Parity is structural, not incidental: the flat overlay id and the suffix
  // form must produce the same `tier` on the spec, otherwise the guard above
  // would silently not apply to `auto/best-free`.
  assert.equal(builtin.FLAT_TIER_OVERLAY_IDS["auto/best-free"], "free");
  assert.equal(
    virtualFactory.isFreeTierIntent({ tier: builtin.FLAT_TIER_OVERLAY_IDS["auto/best-free"] }),
    true
  );
});

test("a free candidate survives only when the persisted probe round-trips", () => {
  probeOk("openrouter", "conn-ok", "alpha:free");

  const filtered = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({ provider: "openrouter", model: "alpha:free", allowedConnectionIds: ["conn-ok"] }),
    candidate({ provider: "openrouter", model: "beta:free", allowedConnectionIds: ["conn-ok"] }),
  ]);

  assert.deepEqual(
    filtered.map((entry) => entry.model),
    ["alpha:free"]
  );
});

test("a provider-prefixed probe is found by the un-prefixed router candidate and vice versa", () => {
  // The recorder normalizes on write…
  const record = probeOk("openrouter", "conn-ok", "openrouter/alpha:free");
  assert.equal(record.modelId, "alpha:free");
  assert.ok(
    Object.hasOwn(
      availabilityDb.getModelAvailabilityInventory("conn-ok")?.models ?? {},
      "alpha:free"
    )
  );

  // …so both spellings of the same model must be admitted by the filter.
  const filtered = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({ provider: "openrouter", model: "alpha:free", allowedConnectionIds: ["conn-ok"] }),
    candidate({
      provider: "openrouter",
      model: "openrouter/alpha:free",
      allowedConnectionIds: ["conn-ok"],
    }),
  ]);
  assert.equal(filtered.length, 2);
});

test("non-available persisted evidence fails closed", () => {
  availabilityDb.recordModelTestAvailability({
    providerId: "openrouter",
    connectionId: "conn-quota",
    modelId: "alpha:free",
    result: { status: "rate_limited", httpStatus: 429, rateLimited: true, isQuota: true },
    source: "batch_test",
  });

  const filtered = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({
      provider: "openrouter",
      model: "alpha:free",
      allowedConnectionIds: ["conn-quota"],
    }),
  ]);
  // Evidence exists, but it is evidence of NOT working.
  assert.deepEqual(filtered, []);
});

test("evidence recorded under a different provider never admits a model", () => {
  probeOk("groq", "conn-shared", "alpha:free");

  const filtered = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({
      provider: "openrouter",
      model: "alpha:free",
      allowedConnectionIds: ["conn-shared"],
    }),
  ]);
  assert.deepEqual(filtered, []);
});

test("the no-auth sentinel is a real evidence key, not a skipped one", () => {
  probeOk("pollinations", NOAUTH, "openai-fast");

  const kept = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({ provider: "pollinations", model: "openai-fast", connectionId: NOAUTH }),
  ]);
  assert.equal(kept.length, 1);
  // Identity must survive verbatim: rewriting it to null would send a keyless
  // provider down the credentialed auth path.
  assert.equal(kept[0].connectionId, NOAUTH);

  const dropped = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({ provider: "pollinations", model: "never-probed", connectionId: NOAUTH }),
  ]);
  assert.deepEqual(dropped, []);
});

test("a pinned candidate is verified against its own account and never re-pointed", () => {
  probeOk("openrouter", "conn-b", "alpha:free");

  const filtered = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({ provider: "openrouter", model: "alpha:free", connectionId: "conn-a" }),
    candidate({ provider: "openrouter", model: "alpha:free", connectionId: "conn-b" }),
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].connectionId, "conn-b");
});

test("a logical candidate keeps connectionId null and narrows its allowlist", () => {
  probeOk("openrouter", "conn-ok", "alpha:free");

  const [filtered] = virtualFactory.filterVerifiedFreeAvailabilityCandidates([
    candidate({
      provider: "openrouter",
      model: "alpha:free",
      allowedConnectionIds: ["conn-ok", "conn-unknown"],
    }),
  ]);

  assert.equal(filtered.connectionId, null);
  assert.deepEqual(filtered.allowedConnectionIds, ["conn-ok"]);
});

test("the filter returns the input untouched when it changes nothing", () => {
  probeOk("openrouter", "conn-ok", "alpha:free");
  const pool = [
    candidate({ provider: "openrouter", model: "alpha:free", allowedConnectionIds: ["conn-ok"] }),
  ];
  assert.equal(virtualFactory.filterVerifiedFreeAvailabilityCandidates(pool), pool);
});

test("an empty pool is reported once but keeps counting occurrences", () => {
  virtualFactory.resetEmptyAutoPoolWarnStateForTests();
  assert.equal(
    virtualFactory.warnEmptyAutoPoolOnce("auto/best-free", "no verified free models"),
    true
  );
  assert.equal(
    virtualFactory.warnEmptyAutoPoolOnce("auto/best-free", "no verified free models"),
    false,
    "a steady empty pool must not be a metronome in the log"
  );

  const [signal] = virtualFactory.getEmptyAutoPoolSignals();
  assert.equal(signal.label, "auto/best-free");
  assert.equal(signal.occurrences, 2);
  // Still observable after the log went quiet — that is the whole point.
  assert.ok(Date.parse(signal.lastSeenAt) >= Date.parse(signal.firstSeenAt));
  virtualFactory.resetEmptyAutoPoolWarnStateForTests();
  assert.deepEqual(virtualFactory.getEmptyAutoPoolSignals(), []);
});
