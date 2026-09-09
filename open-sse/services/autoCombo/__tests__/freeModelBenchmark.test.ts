import { describe, expect, it } from "vitest";
import { normalizeOpenRouterFreeCatalog } from "../../../../src/lib/catalog/openrouterFreeDiscovery";
import { buildFreeModelCompatibilityProfile } from "../freeModelEligibility";
import { buildBenchmarkDryRunPlan } from "../freeModelBenchmark";

const [toolModel, textModel] = normalizeOpenRouterFreeCatalog(
  [
    {
      id: "vendor/tool",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
    },
    { id: "vendor/text", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
  ],
  new Date("2026-09-09T00:00:00.000Z")
).verifiedFree;

describe("free model benchmark dry-run", () => {
  it("builds a dry-run plan without provider traffic", () => {
    const plan = buildBenchmarkDryRunPlan([
      buildFreeModelCompatibilityProfile(toolModel),
      buildFreeModelCompatibilityProfile(textModel),
    ]);
    expect(plan.executesProviderTraffic).toBe(false);
    expect(plan.scenarioCount).toBe(6);
    expect(
      plan.candidates.find((candidate) => candidate.modelId === "vendor/tool")?.scenarios
    ).toContain("one_tool_call");
    expect(
      plan.candidates.find((candidate) => candidate.modelId === "vendor/text")?.scenarios
    ).not.toContain("one_tool_call");
  });
});
