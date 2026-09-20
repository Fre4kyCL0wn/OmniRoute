/**
 * O9-F3.3P1-D0 — FCC dynamic sync design (fixture-only in this phase).
 *
 * Verifies staleness fail-closes and the snapshot diff is purely additive
 * reporting — it never mutates or deletes anything itself.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  diffFccSnapshots,
  isSnapshotStale,
  type FccSnapshotMeta,
} from "../../open-sse/services/fccSync.ts";
import type { FccModelEvidence } from "../../open-sse/config/providers/fccCatalog.ts";
import { FCC_PROVIDER_ID_MAP } from "../../open-sse/config/providers/fccCatalog.data.ts";

const NO_EVIDENCE = { compatible: null, evidenceNote: null } as const;

function entry(overrides: Partial<FccModelEvidence>): FccModelEvidence {
  return {
    fccProviderId: "groq",
    fccModelId: "model-a",
    displayName: "Model A",
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    toolSupport: null,
    reasoningSupport: null,
    structuredOutput: null,
    aliases: null,
    supportedCodingClients: null,
    claudeCode: NO_EVIDENCE,
    codex: NO_EVIDENCE,
    openCode: NO_EVIDENCE,
    ...overrides,
  };
}

// ── Staleness ────────────────────────────────────────────────────────────

test("a fresh snapshot is not stale", () => {
  const meta: FccSnapshotMeta = {
    sourceRevision: "abc123",
    fetchedAt: "2026-09-01T00:00:00Z",
    staleAfterMs: 86_400_000,
  };
  const now = Date.parse("2026-09-01T12:00:00Z");
  assert.equal(isSnapshotStale(meta, now), false);
});

test("a snapshot older than staleAfterMs is stale", () => {
  const meta: FccSnapshotMeta = {
    sourceRevision: "abc123",
    fetchedAt: "2026-09-01T00:00:00Z",
    staleAfterMs: 86_400_000,
  };
  const now = Date.parse("2026-09-05T00:00:00Z");
  assert.equal(isSnapshotStale(meta, now), true);
});

test("an unparseable fetchedAt fails closed as stale", () => {
  const meta: FccSnapshotMeta = {
    sourceRevision: "abc123",
    fetchedAt: "not-a-date",
    staleAfterMs: 86_400_000,
  };
  assert.equal(isSnapshotStale(meta, Date.now()), true);
});

// ── Diff ─────────────────────────────────────────────────────────────────

test("diff reports additions and removals without mutating either snapshot", () => {
  const previous = [
    entry({ fccModelId: "model-a", displayName: "Model A" }),
    entry({ fccModelId: "model-b", displayName: "Model B" }),
  ];
  const next = [
    entry({ fccModelId: "model-a", displayName: "Model A" }),
    entry({ fccModelId: "model-c", displayName: "Model C" }),
  ];
  const previousSnapshot = JSON.stringify(previous);
  const nextSnapshot = JSON.stringify(next);

  const diff = diffFccSnapshots(previous, next);

  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].fccModelId, "model-c");
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].fccModelId, "model-b");
  // no destructive automatic deletes: inputs are untouched
  assert.equal(JSON.stringify(previous), previousSnapshot);
  assert.equal(JSON.stringify(next), nextSnapshot);
});

test("a same-provider, same-displayName, different-id pair is reported as a rename", () => {
  const previous = [entry({ fccModelId: "old-id", displayName: "Same Name" })];
  const next = [entry({ fccModelId: "new-id", displayName: "Same Name" })];
  const diff = diffFccSnapshots(previous, next);
  assert.equal(diff.renamed.length, 1);
  assert.equal(diff.renamed[0].from.fccModelId, "old-id");
  assert.equal(diff.renamed[0].to.fccModelId, "new-id");
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
});

test("a valid provider alias in the next snapshot is NOT reported as a mismatch", () => {
  const next = [entry({ fccProviderId: "cloudflare" })];
  const diff = diffFccSnapshots([], next);
  // cloudflare -> cloudflare-ai is a valid alias in the current registry, so
  // this should NOT be reported as a mismatch.
  assert.equal(diff.providerMismatch.length, 0);
});

test("a genuinely broken provider alias in the next snapshot IS reported as a mismatch, not silently dropped", () => {
  // Same minimal seam as fccCatalog.test.ts's conflict test: FCC_PROVIDER_ID_MAP
  // is a plain, non-frozen exported object — temporarily add a target that does
  // not exist in the registry, exercise the real diffFccSnapshots -> mapFccProvider
  // path, then remove it. No DI refactor, no artificial conflict semantics
  // introduced into diffFccSnapshots itself — this is its real `conflict` branch.
  const fixtureKey = "__d0_review_sync_conflict_fixture__";
  const brokenTarget = "__d0_review_sync_nonexistent_provider__";
  assert.ok(!(fixtureKey in FCC_PROVIDER_ID_MAP), "fixture key must not already exist");
  FCC_PROVIDER_ID_MAP[fixtureKey] = brokenTarget;
  try {
    const next = [entry({ fccProviderId: fixtureKey, fccModelId: "any-model" })];
    const diff = diffFccSnapshots([], next);
    assert.equal(diff.providerMismatch.length, 1);
    assert.equal(diff.providerMismatch[0].fccProviderId, fixtureKey);
    assert.ok(diff.providerMismatch[0].reason.includes(brokenTarget));
  } finally {
    delete FCC_PROVIDER_ID_MAP[fixtureKey];
  }
});

test("identical snapshots produce an empty diff", () => {
  const snapshot = [entry({})];
  const diff = diffFccSnapshots(snapshot, snapshot);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.renamed, []);
  assert.deepEqual(diff.providerMismatch, []);
});
