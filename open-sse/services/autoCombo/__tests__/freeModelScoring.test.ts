import { describe, expect, it } from "vitest";
import { normalizeOpenRouterFreeCatalog } from "../../../../src/lib/catalog/openrouterFreeDiscovery";
import { buildFreeModelCompatibilityProfile } from "../freeModelEligibility";
import { latencyScore, rankFreeModels, reliabilityScore } from "../freeModelScoring";

const [measuredModel, newModel] = normalizeOpenRouterFreeCatalog(
  [
    {
      id: "vendor/measured",
      pricing: { prompt: "0", completion: "0" },
      context_length: 64000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
    {
      id: "vendor/new",
      pricing: { prompt: "0", completion: "0" },
      context_length: 64000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
  ],
  new Date("2026-09-09T00:00:00.000Z")
).verifiedFree;

function profile(model: typeof measuredModel) {
  return buildFreeModelCompatibilityProfile(model, {
    policyEligible: "eligible",
    claudeCodeCompatible: "compatible",
    healthy: true,
    streamingSupported: true,
  });
}

describe("free model scoring", () => {
  it("scores latency and reliability deterministically", () => {
    expect(latencyScore({ p95LatencyMs: 1_000 })).toBe(1);
    expect(latencyScore({ p95LatencyMs: 8_000 })).toBe(0);
    expect(reliabilityScore({ sampleCount: 5, timeoutRate: 0.5 })).toBeLessThan(1);
  });

  it("uses conservative defaults for unknown measurements", () => {
    expect(latencyScore(undefined)).toBeLessThan(0.5);
    expect(reliabilityScore(undefined)).toBeLessThan(0.5);
  });

  it("does not let an unmeasured new model outrank a measured fast model", () => {
    const ranked = rankFreeModels([
      {
        profile: profile(newModel),
        routeClass: "free/claude-code-fast",
      },
      {
        profile: profile(measuredModel),
        routeClass: "free/claude-code-fast",
        metrics: {
          sampleCount: 5,
          p95LatencyMs: 900,
          toolCallSuccessRate: 1,
          streamingStabilityRate: 1,
          malformedToolCallRate: 0,
          timeoutRate: 0,
          serverErrorRate: 0,
          rateLimitRate: 0,
          unauthorizedRate: 0,
        },
      },
    ]);
    expect(ranked[0].modelId).toBe("vendor/measured");
  });
});
