/**
 * O9-F3.3P1-D3 — Provider-level FCC snapshot diff (Schritt 11).
 *
 * Verifies additions/removals/changes are REPORTED only (never mutate the
 * inputs, never delete anything from any registry), and that the
 * mapping/discovery-classification diff reflects the LIVE join.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  diffFccProviderSnapshots,
  diffFccProviderCoverage,
  diffFccCatalogSnapshots,
} from "../../open-sse/services/fccSync.ts";
import type { FccProviderSnapshotEntry } from "../../open-sse/config/providers/fccProviderSnapshot.data.ts";

function entry(overrides: Partial<FccProviderSnapshotEntry>): FccProviderSnapshotEntry {
  return {
    fccProviderId: "groq",
    displayName: "Groq",
    authKind: "configuration",
    local: false,
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    credentialEnv: "GROQ_API_KEY",
    credentialUrl: "https://console.groq.com/keys",
    ...overrides,
  };
}

test("added and removed providers are reported without mutating either input", () => {
  const previous = [
    entry({ fccProviderId: "groq" }),
    entry({ fccProviderId: "cerebras", displayName: "Cerebras" }),
  ];
  const next = [
    entry({ fccProviderId: "groq" }),
    entry({ fccProviderId: "gemini", displayName: "Gemini" }),
  ];
  const previousSnapshot = JSON.stringify(previous);
  const nextSnapshot = JSON.stringify(next);

  const diff = diffFccProviderSnapshots(previous, next);

  assert.equal(diff.addedProviders.length, 1);
  assert.equal(diff.addedProviders[0].fccProviderId, "gemini");
  assert.equal(diff.removedProviders.length, 1);
  assert.equal(diff.removedProviders[0].fccProviderId, "cerebras");
  assert.equal(JSON.stringify(previous), previousSnapshot);
  assert.equal(JSON.stringify(next), nextSnapshot);
});

test("removed != delete: a removed provider is only ever reported, this module has no delete capability", () => {
  const previous = [entry({ fccProviderId: "groq" })];
  const next: FccProviderSnapshotEntry[] = [];
  const diff = diffFccProviderSnapshots(previous, next);
  assert.equal(diff.removedProviders.length, 1);
  // No function in this module accepts a "registry" to mutate — structurally
  // there is nothing here that could delete a Jarvis registry entry.
});

test("a changed descriptor field is reported with the specific changed field names", () => {
  const previous = [entry({ fccProviderId: "groq", defaultBaseUrl: "https://old.example/v1" })];
  const next = [entry({ fccProviderId: "groq", defaultBaseUrl: "https://api.groq.com/openai/v1" })];
  const diff = diffFccProviderSnapshots(previous, next);
  assert.equal(diff.changedProviders.length, 1);
  assert.deepEqual(diff.changedProviders[0].changedFields, ["defaultBaseUrl"]);
});

test("identical provider snapshots produce an empty diff", () => {
  const snapshot = [entry({})];
  const diff = diffFccProviderSnapshots(snapshot, snapshot);
  assert.deepEqual(diff.addedProviders, []);
  assert.deepEqual(diff.removedProviders, []);
  assert.deepEqual(diff.changedProviders, []);
});

// ── Mapping / discovery coverage diff ───────────────────────────────────────

test("mapping/discovery coverage diff is empty for a provider unchanged in both position and identity", () => {
  const previous = [entry({ fccProviderId: "groq" })];
  const next = [entry({ fccProviderId: "groq" })];
  const { mappingChanges, discoveryChanges } = diffFccProviderCoverage(previous, next);
  assert.deepEqual(mappingChanges, []);
  assert.deepEqual(discoveryChanges, []);
});

test("a provider only present in one snapshot is not reported as a mapping/discovery CHANGE (it is an add/remove instead)", () => {
  const previous: FccProviderSnapshotEntry[] = [];
  const next = [entry({ fccProviderId: "groq" })];
  const { mappingChanges, discoveryChanges } = diffFccProviderCoverage(previous, next);
  assert.deepEqual(mappingChanges, []);
  assert.deepEqual(discoveryChanges, []);
});

// ── Combined catalog diff ───────────────────────────────────────────────────

test("diffFccCatalogSnapshots combines provider diff, coverage diff, and static-model diff into the full Schritt-11 shape", () => {
  const previousProviders = [entry({ fccProviderId: "groq" })];
  const nextProviders = [
    entry({ fccProviderId: "groq" }),
    entry({ fccProviderId: "gemini", displayName: "Gemini" }),
  ];

  const diff = diffFccCatalogSnapshots({ previousProviders, nextProviders });

  assert.equal(diff.addedProviders.length, 1);
  assert.equal(diff.removedProviders.length, 0);
  assert.deepEqual(diff.changedProviders, []);
  assert.deepEqual(diff.mappingChanges, []);
  assert.deepEqual(diff.discoveryChanges, []);
  // No model-evidence snapshots supplied -> empty, not an error.
  assert.deepEqual(diff.addedStaticModels, []);
  assert.deepEqual(diff.removedStaticModels, []);
  assert.deepEqual(diff.changedStaticModels, []);
});

test("diffFccCatalogSnapshots wires through the static-model (per-model evidence) diff when supplied", () => {
  const modelEntry = (overrides: Record<string, unknown>) => ({
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
    claudeCode: { compatible: null, evidenceNote: null },
    codex: { compatible: null, evidenceNote: null },
    openCode: { compatible: null, evidenceNote: null },
    ...overrides,
  });

  const diff = diffFccCatalogSnapshots({
    previousProviders: [],
    nextProviders: [],
    previousModelEvidence: [modelEntry({})],
    nextModelEvidence: [modelEntry({ contextWindow: 131072 })],
  });

  assert.equal(diff.changedStaticModels.length, 1);
  assert.equal(diff.changedStaticModels[0].next.contextWindow, 131072);
});
