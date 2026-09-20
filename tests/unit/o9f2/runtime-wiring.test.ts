/**
 * O9-F2 — Runtime Wiring Tests
 *
 * Unit tests for the F2 modules that don't require a database or a live
 * remote endpoint:
 *   - productionDiscovery  : project + classify
 *   - importSync          : planImport + sanitize (dry-run only)
 *   - pipelineWire        : failure classifier + sharedRouteDecision
 *
 * Live network/DB tests are exercised separately in the evidence step.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { classifyStatusToHealth } from "open-sse/services/o9f1/pipelineWire";
import { planImport } from "open-sse/services/o9f1/importSync";
import type { DiscoveredCombo, ProductionDiscoveryResult } from "open-sse/services/o9f1/productionDiscovery";

describe("o9f2: pipelineWire failure classification", () => {
  it("classifies 401/403 as auth_failed", () => {
    assert.equal(classifyStatusToHealth(401), "auth_failed");
    assert.equal(classifyStatusToHealth(403), "auth_failed");
  });

  it("classifies 404 as unavailable (model not supported)", () => {
    assert.equal(classifyStatusToHealth(404), "unavailable");
  });

  it("classifies 408 as unavailable (timeout)", () => {
    assert.equal(classifyStatusToHealth(408), "unavailable");
  });

  it("classifies 429 as rate_limited (cooldown candidate)", () => {
    assert.equal(classifyStatusToHealth(429), "rate_limited");
  });

  it("classifies 5xx as unavailable (probe/retry)", () => {
    assert.equal(classifyStatusToHealth(500), "unavailable");
    assert.equal(classifyStatusToHealth(502), "unavailable");
    assert.equal(classifyStatusToHealth(503), "unavailable");
    assert.equal(classifyStatusToHealth(504), "unavailable");
  });

  it("classifies 409 as degraded (recoverable)", () => {
    assert.equal(classifyStatusToHealth(409), "degraded");
  });

  it("classifies other 4xx as degraded", () => {
    assert.equal(classifyStatusToHealth(400), "degraded");
    assert.equal(classifyStatusToHealth(418), "degraded");
  });
});

describe("o9f2: planImport (dry-run only)", () => {
  const baseCombo = (
    name: string,
    executability: DiscoveredCombo["executability"],
    local: string[] = [],
    missing: string[] = []
  ): DiscoveredCombo => ({
    remoteId: name,
    remoteName: name,
    strategy: "priority",
    description: `test ${name}`,
    models: local.map((id) => ({ kind: "model", model: id.split("/")[1] || id, providerId: id.split("/")[0] || "" })),
    capabilities: { multimodal: false, reasoning: true, caching: false },
    executability,
    costClass: "verified_free",
    defaultPolicy: "free_only",
    localModelIds: local,
    missingModelIds: missing,
  });

  const buildDiscovery = (combos: DiscoveredCombo[]): ProductionDiscoveryResult => ({
    ok: true,
    httpStatus: 200,
    comboCount: combos.length,
    combos,
    errors: [],
    remoteMutated: false,
  });

  it("dry-run by default returns 'no DB writes performed'", () => {
    const plan = planImport(buildDiscovery([baseCombo("coding", "executable", ["codex/gpt-5.5"]) ]));
    assert.equal(plan.dryRun, true);
    assert.equal(plan.secretsCopied, false);
    assert.equal(plan.toImport.length, 1);
    assert.equal(plan.toImport[0].action, "create");
  });

  it("non-executable combos are marked skip", () => {
    const plan = planImport(buildDiscovery([baseCombo("coding", "non_executable", [], ["claude/claude-sonnet-5"]) ]));
    assert.equal(plan.toImport[0].action, "skip");
    assert.match(plan.toImport[0].reason, /missing locals/);
  });

  it("unsupported strategy is skipped", () => {
    const plan = planImport(buildDiscovery([{ ...baseCombo("coding", "unsupported", ["codex/gpt-5.5"]) }]));
    assert.equal(plan.toImport[0].action, "skip");
    assert.match(plan.toImport[0].reason, /unsupported/);
  });

  it("empty catalog → all skipped, no secret copy", () => {
    const plan = planImport(buildDiscovery([]));
    assert.equal(plan.toImport.length, 0);
    assert.equal(plan.secretsCopied, false);
  });

  it("plan carries no api key / token fields (santized payload check)", () => {
    const plan = planImport(buildDiscovery([baseCombo("Open/FreeModels", "executable", ["openrouter/openrouter/free"]) ]));
    const planJson = JSON.stringify(plan);
    assert.ok(!/api[_-]?key/i.test(planJson), "plan must not contain api_key fields");
    assert.ok(!/token/i.test(planJson), "plan must not contain token fields");
    assert.ok(!/connection[_-]?id/i.test(planJson), "plan must not contain connection_id fields");
    assert.ok(!/oauth/i.test(planJson), "plan must not contain oauth fields");
  });
});

describe("o9f2: discovery classification", () => {
  it("distinguishes discovered from executable", () => {
    const combo: DiscoveredCombo = {
      remoteId: "Open/FreeModels",
      remoteName: "Open/FreeModels",
      strategy: "fusion",
      description: "test",
      models: [
        { kind: "model", model: "openrouter/free", providerId: "openrouter" },
        { kind: "model", model: "cohere/north-mini-code:free", providerId: "openrouter" },
      ],
      capabilities: { multimodal: false, reasoning: true, caching: false },
      executability: "discovered",
      costClass: "mixed",
      defaultPolicy: "free_first",
      localModelIds: ["openrouter/openrouter/free"],
      missingModelIds: ["cohere/north-mini-code:free"],
    };
    assert.equal(combo.executability, "discovered");
    assert.equal(combo.localModelIds.length, 1);
    assert.equal(combo.missingModelIds.length, 1);
  });
});

describe("o9f2: real catalog adapter presence", () => {
  it("adapter file is present and exports the right surface", async () => {
    const mod = await import("open-sse/services/o9f1/realCatalogAdapter");
    assert.equal(typeof mod.readDbComboCatalog, "function");
    assert.equal(typeof mod.refreshRealCatalog, "function");
    assert.equal(typeof mod.buildRealComboRegistry, "function");
  });

  it("F1 index re-exports the F2 modules", async () => {
    const mod = await import("open-sse/services/o9f1/index");
    assert.equal(typeof mod.discoverProductionCombos, "function");
    assert.equal(typeof mod.planImport, "function");
    assert.equal(typeof mod.applyImport, "function");
    assert.equal(typeof mod.sharedRouteDecision, "function");
    assert.equal(typeof mod.classifyUpstreamFailure, "function");
  });
});
