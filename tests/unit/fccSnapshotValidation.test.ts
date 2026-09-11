/**
 * O9-F3.3P1-D3 — FCC snapshot last-known-good validation gate.
 *
 * A candidate snapshot must pass every check before it is adopted. No check
 * here ever "repairs" bad input — it only accepts or rejects.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateFccSnapshotShape,
  validateFccSnapshotForAdoption,
  type FccSnapshotCandidate,
} from "../../open-sse/config/providers/fccSnapshotValidation.ts";
import { FCC_PROVIDER_ID_MAP } from "../../open-sse/config/providers/fccCatalog.data.ts";
import { FCC_PROVIDER_SNAPSHOT } from "../../open-sse/config/providers/fccProviderSnapshot.data.ts";

const VALID_SHA = "81fa340ecac5ce1ae8ba4ea60e7a5517224bfaee";

function validCandidate(overrides: Partial<FccSnapshotCandidate> = {}): FccSnapshotCandidate {
  return {
    schemaVersion: "1.0.0",
    sourceRepo: "Alishahryar1/free-claude-code",
    sourceRevision: VALID_SHA,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        fccProviderId: "groq",
        displayName: "Groq",
        authKind: "configuration",
        local: false,
        defaultBaseUrl: "https://api.groq.com/openai/v1",
        credentialEnv: "GROQ_API_KEY",
        credentialUrl: "https://console.groq.com/keys",
      },
    ],
    ...overrides,
  };
}

test("a well-formed candidate passes shape validation", () => {
  assert.deepEqual(validateFccSnapshotShape(validCandidate()), { ok: true });
});

test("missing schemaVersion fails closed", () => {
  const candidate = validCandidate({ schemaVersion: "" });
  const result = validateFccSnapshotShape(candidate);
  assert.equal(result.ok, false);
});

test("wrong sourceRepo fails closed", () => {
  const result = validateFccSnapshotShape(validCandidate({ sourceRepo: "someone/else" }));
  assert.equal(result.ok, false);
});

test("missing / malformed sourceRevision fails closed", () => {
  assert.equal(validateFccSnapshotShape(validCandidate({ sourceRevision: "" })).ok, false);
  assert.equal(validateFccSnapshotShape(validCandidate({ sourceRevision: "not-a-sha" })).ok, false);
  assert.equal(validateFccSnapshotShape(validCandidate({ sourceRevision: "abc123" })).ok, false);
});

test("invalid generatedAt timestamp fails closed", () => {
  const result = validateFccSnapshotShape(validCandidate({ generatedAt: "not-a-date" }));
  assert.equal(result.ok, false);
});

test("a generatedAt far in the future fails closed", () => {
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const result = validateFccSnapshotShape(validCandidate({ generatedAt: future }));
  assert.equal(result.ok, false);
});

test("an empty providers array fails closed — no empty catalog counted as success", () => {
  const result = validateFccSnapshotShape(validCandidate({ providers: [] }));
  assert.equal(result.ok, false);
});

test("a malformed provider entry fails closed", () => {
  const candidate = validCandidate({
    providers: [{ fccProviderId: "x" } as never],
  });
  const result = validateFccSnapshotShape(candidate);
  assert.equal(result.ok, false);
});

test("duplicate fccProviderId values fail closed", () => {
  const one = validCandidate().providers[0];
  const result = validateFccSnapshotShape(validCandidate({ providers: [one, { ...one }] }));
  assert.equal(result.ok, false);
});

test("a non-object candidate fails closed rather than throwing", () => {
  assert.equal(validateFccSnapshotShape(null).ok, false);
  assert.equal(validateFccSnapshotShape("not an object").ok, false);
  assert.equal(validateFccSnapshotShape(42).ok, false);
});

// ── Adoption gate: mapping-conflict awareness ───────────────────────────────

test("validateFccSnapshotForAdoption accepts a candidate with no mapping conflicts", () => {
  const result = validateFccSnapshotForAdoption(validCandidate());
  assert.deepEqual(result, { ok: true });
});

test("validateFccSnapshotForAdoption fails closed when a provider maps to conflict", () => {
  const fixtureKey = "__d3_review_validation_conflict_fixture__";
  const brokenTarget = "__d3_review_validation_nonexistent_provider__";
  FCC_PROVIDER_ID_MAP[fixtureKey] = brokenTarget;
  try {
    const candidate = validCandidate({
      providers: [
        {
          fccProviderId: fixtureKey,
          displayName: "Conflict Fixture",
          authKind: "configuration",
          local: false,
          defaultBaseUrl: null,
          credentialEnv: null,
          credentialUrl: null,
        },
      ],
    });
    const result = validateFccSnapshotForAdoption(candidate);
    assert.equal(result.ok, false);
  } finally {
    delete FCC_PROVIDER_ID_MAP[fixtureKey];
  }
});

// ── Real snapshot passes its own gate ───────────────────────────────────────

test("the real committed snapshot passes both the shape and adoption gate", () => {
  const candidate: FccSnapshotCandidate = {
    schemaVersion: "1.0.0",
    sourceRepo: "Alishahryar1/free-claude-code",
    sourceRevision: VALID_SHA,
    generatedAt: new Date().toISOString(),
    providers: FCC_PROVIDER_SNAPSHOT,
  };
  assert.deepEqual(validateFccSnapshotShape(candidate), { ok: true });
  assert.deepEqual(validateFccSnapshotForAdoption(candidate), { ok: true });
});
