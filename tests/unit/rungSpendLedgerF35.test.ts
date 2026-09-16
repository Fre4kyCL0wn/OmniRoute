import test from "node:test";
import assert from "node:assert/strict";

import {
  priceUsageRowsByRung,
  type UsageSpendRow,
} from "../../open-sse/services/autoCombo/rungSpendLedger.ts";

function row(overrides: Partial<UsageSpendRow>): UsageSpendRow {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    connectionId: "c1",
    serviceTier: "standard",
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheCreation: 0,
    reasoning: 0,
    ...overrides,
  };
}
test("F3.5 A: paid cheap usage is accumulated into the cheap rung", async () => {
  const result = await priceUsageRowsByRung(
    [row({})],
    () => "apikey",
    async () => ({ input: 0.15, output: 0.6 })
  );
  assert.equal(result.accountingComplete, true);
  assert.equal(result.unpricedRows, 0);
  assert.ok((result.spendUsd.cheap ?? 0) > 0.7);
  assert.equal(result.spendUsd.premium, 0);
});

test("F3.5 B: subscription usage never consumes paid-rung budget", async () => {
  const result = await priceUsageRowsByRung(
    [row({ provider: "codex", model: "gpt-5.5-low", connectionId: "codex-oauth" })],
    () => "oauth",
    async () => ({ input: 10, output: 30 })
  );
  assert.equal(result.accountingComplete, true);
  assert.equal(result.spendUsd.cheap, 0);
  assert.equal(result.spendUsd.premium, 0);
});
test("F3.5 C: premium usage is accumulated separately", async () => {
  const result = await priceUsageRowsByRung(
    [row({ model: "gpt-4o" })],
    () => "apikey",
    async () => ({ input: 2.5, output: 10 })
  );
  assert.equal(result.accountingComplete, true);
  assert.ok((result.spendUsd.premium ?? 0) >= 12.5);
  assert.equal(result.spendUsd.cheap, 0);
});

test("F3.5 D: missing pricing marks paid accounting incomplete instead of counting zero", async () => {
  const result = await priceUsageRowsByRung(
    [row({})],
    () => "apikey",
    async () => null
  );
  assert.equal(result.accountingComplete, false);
  assert.equal(result.unpricedRows, 1);
  assert.equal(result.spendUsd.cheap, 0);
});
