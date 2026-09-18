import { describe, expect, it } from "vitest";
import { normalizeOpenRouterFreeCatalog } from "../../../../src/lib/catalog/openrouterFreeDiscovery";
import { buildFreeModelCompatibilityProfile } from "../freeModelEligibility";
import { auditFreeCombo } from "../freeComboAudit";

const discovered = normalizeOpenRouterFreeCatalog(
  [
    { id: "vendor/free", pricing: { prompt: "0", completion: "0" } },
    { id: "vendor/unknown", pricing: { prompt: "0" } },
    { id: "vendor/paid", pricing: { prompt: "0", completion: "1" } },
    { id: "vendor/bad-cc", pricing: { prompt: "0", completion: "0" } },
  ],
  new Date("2026-09-09T00:00:00.000Z")
).models;

const badProfile = buildFreeModelCompatibilityProfile(
  discovered.find((m) => m.modelId === "vendor/bad-cc")!,
  {
    claudeCodeCompatible: "incompatible",
  }
);

describe("free combo audit", () => {
  it("rejects malformed, stale, unknown-cost, paid, and Claude Code incompatible leaves", () => {
    const combo = {
      name: "Open/FreeModels",
      models: [
        { model: "openrouter/vendor/free" },
        { model: "openrouter/vendor/unknown" },
        { model: "openrouter/vendor/paid" },
        { model: "openrouter/vendor/stale" },
        { model: "not-openrouter/model" },
        { label: "missing model" },
        { model: "openrouter/vendor/bad-cc" },
      ],
    };
    const audit = auditFreeCombo(combo, discovered, [badProfile]);
    expect(audit.verifiedZeroCostLeaves).toEqual(["vendor/bad-cc", "vendor/free"]);
    expect(audit.unverifiedLeaves).toEqual(["vendor/paid", "vendor/unknown"]);
    expect(audit.malformedOrStaleLeaves).toContain("vendor/stale");
    expect(audit.malformedOrStaleLeaves).toContain("not-openrouter/model");
    expect(audit.claudeCodeIncompatibleLeaves).toEqual(["vendor/bad-cc"]);
    expect(audit.proposedCleanedDefinition.models as unknown[]).toHaveLength(1);
    expect(combo.models).toHaveLength(7);
  });
});
