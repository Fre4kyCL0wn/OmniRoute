/**
 * O9-F3.4 P4-B — API validation for `providerSpecificData.billingEvidence`.
 *
 * The connection API only accepts operator declarations, so an operator's
 * assertion can never be stored as `provider-observed` truth, and the block
 * cannot carry arbitrary extra fields.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";

import { validateProviderSpecificData } from "../../src/shared/validation/providerSpecificData.ts";
import { normalizeProviderSpecificData } from "../../src/lib/providers/requestDefaults.ts";

function issuesFor(data: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const ctx = {
    addIssue: (issue: { message: string }) => issues.push(issue.message),
  } as unknown as z.RefinementCtx;
  validateProviderSpecificData(data, ctx);
  return issues;
}

const VALID = {
  billingLinked: false,
  origin: "operator-declared",
  observedAt: "2026-09-11T00:00:00.000Z",
};

test("accepts an operator declaration, with or without observedAt", () => {
  assert.deepEqual(issuesFor({ billingEvidence: VALID }), []);
  assert.deepEqual(
    issuesFor({ billingEvidence: { billingLinked: null, origin: "operator-declared" } }),
    []
  );
});

test("accepts an absent or null block", () => {
  assert.deepEqual(issuesFor({}), []);
  assert.deepEqual(issuesFor({ billingEvidence: null }), []);
});

test("rejects provider-observed through the API", () => {
  const issues = issuesFor({ billingEvidence: { ...VALID, origin: "provider-observed" } });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /origin must be "operator-declared"/);
});

test("rejects unsupported fields so the block cannot carry anything else", () => {
  const issues = issuesFor({ billingEvidence: { ...VALID, apiKey: "x" } });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /billingEvidence\.apiKey is not a supported field/);
});

test("rejects wrong value types", () => {
  assert.equal(issuesFor({ billingEvidence: "linked" }).length, 1);
  assert.equal(issuesFor({ billingEvidence: { ...VALID, billingLinked: "no" } }).length, 1);
  assert.equal(issuesFor({ billingEvidence: { ...VALID, observedAt: "yesterday" } }).length, 1);
});

test("normalization keeps the block so it persists per connection", () => {
  const normalized = normalizeProviderSpecificData("gemini", { billingEvidence: VALID });
  assert.deepEqual(normalized?.billingEvidence, VALID);
});
