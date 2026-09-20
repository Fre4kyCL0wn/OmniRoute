/**
 * O9-F3.3P1-D3 — FCC provider coverage report (mapping + discovery join).
 *
 * All assertions here are grounded in the REAL pinned-revision snapshot
 * joined against the REAL current OmniRoute registry — not synthetic data —
 * so this test suite is itself a regression guard on the coverage numbers
 * reported to the operator.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFccProviderCoverageReport,
  buildFccProviderCoverageRow,
} from "../../open-sse/config/providers/fccProviderCoverage.ts";
import { FCC_PROVIDER_SNAPSHOT } from "../../open-sse/config/providers/fccProviderSnapshot.data.ts";

function rowFor(fccProviderId: string) {
  const entry = FCC_PROVIDER_SNAPSHOT.find((p) => p.fccProviderId === fccProviderId);
  assert.ok(entry, `fixture entry for ${fccProviderId} must exist in the real snapshot`);
  return buildFccProviderCoverageRow(entry!);
}

// ── Direct mapping ──────────────────────────────────────────────────────────

test("Groq mapping: direct match, dynamic discovery, executable", () => {
  const row = rowFor("groq");
  assert.equal(row.mappingVerdict, "mapped");
  assert.equal(row.jarvisProviderId, "groq");
  assert.equal(row.modelDiscoveryKind, "DYNAMIC_MODEL_DISCOVERY");
  assert.equal(row.executionSupported, true);
});

test("Cerebras mapping: direct match, dynamic discovery, executable", () => {
  const row = rowFor("cerebras");
  assert.equal(row.mappingVerdict, "mapped");
  assert.equal(row.jarvisProviderId, "cerebras");
  assert.equal(row.modelDiscoveryKind, "DYNAMIC_MODEL_DISCOVERY");
  assert.equal(row.executionSupported, true);
});

// ── Alias mapping ────────────────────────────────────────────────────────────

test("NVIDIA NIM: FCC id 'nvidia_nim' aliases to Jarvis registry id 'nvidia'", () => {
  const row = rowFor("nvidia_nim");
  assert.equal(row.mappingVerdict, "alias");
  assert.equal(row.jarvisProviderId, "nvidia");
  assert.equal(row.modelDiscoveryKind, "DYNAMIC_MODEL_DISCOVERY");
  assert.equal(row.executionSupported, true);
});

test("OpenRouter: FCC id 'open_router' aliases to Jarvis registry id 'openrouter'", () => {
  const row = rowFor("open_router");
  assert.equal(row.mappingVerdict, "alias");
  assert.equal(row.jarvisProviderId, "openrouter");
  assert.equal(row.modelDiscoveryKind, "DYNAMIC_MODEL_DISCOVERY");
  assert.equal(row.executionSupported, true);
});

test("GitHub Copilot: FCC id 'github_copilot' aliases to Jarvis registry id 'github'", () => {
  const row = rowFor("github_copilot");
  assert.equal(row.mappingVerdict, "alias");
  assert.equal(row.jarvisProviderId, "github");
});

// ── FCC-only ─────────────────────────────────────────────────────────────────

test("a genuinely FCC-only provider (no OmniRoute registry entry) resolves fcc_only / not executable", () => {
  const row = rowFor("lmstudio");
  assert.equal(row.mappingVerdict, "fcc_only");
  assert.equal(row.jarvisProviderId, null);
  assert.equal(row.executionSupported, false);
});

// ── Discovery classification ────────────────────────────────────────────────

test("static vs dynamic vs hybrid vs none discovery classification is evidence-based, not guessed", () => {
  assert.equal(rowFor("groq").modelDiscoveryKind, "DYNAMIC_MODEL_DISCOVERY");
  assert.equal(rowFor("llm7").modelDiscoveryKind, "HYBRID");
  assert.equal(rowFor("azure_openai").modelDiscoveryKind, "NO_MODEL_DISCOVERY");
});

test("an unclassified provider is UNKNOWN, never guessed as a discovery kind", () => {
  // 'wafer' has no entry in FCC_MODEL_DISCOVERY_CLASSIFICATION.data.ts — this
  // must stay UNKNOWN, not silently default to DYNAMIC or STATIC.
  const row = rowFor("wafer");
  assert.equal(row.modelDiscoveryKind, "UNKNOWN");
  assert.equal(row.fccDiscoverySupported, false);
});

// ── Full report aggregate ───────────────────────────────────────────────────

test("coverage report totals are internally consistent (mapped+alias+fccOnly+conflict == count)", () => {
  const report = buildFccProviderCoverageReport();
  assert.equal(report.fccProviderCount, FCC_PROVIDER_SNAPSHOT.length);
  assert.equal(
    report.mapped.length + report.aliased.length + report.fccOnly.length + report.conflict.length,
    report.fccProviderCount
  );
});

test("coverage report currently has zero conflicts against the live registry", () => {
  const report = buildFccProviderCoverageReport();
  assert.deepEqual(report.conflict, []);
});

test("Jarvis-executable + Jarvis-discovery-capable are each a subset of the full provider set", () => {
  const report = buildFccProviderCoverageReport();
  assert.ok(report.jarvisExecutable.length <= report.fccProviderCount);
  assert.ok(report.jarvisDiscoveryCapable.length <= report.fccProviderCount);
  for (const row of report.jarvisExecutable) {
    assert.equal(row.executionSupported, true);
  }
  for (const row of report.jarvisDiscoveryCapable) {
    assert.equal(row.jarvisDiscoverySupported, true);
  }
});
