import { describe, expect, it } from "vitest";
import { normalizeOpenRouterFreeCatalog } from "../../../../src/lib/catalog/openrouterFreeDiscovery";
import {
  buildFreeModelCompatibilityProfile,
  evaluateFreeRouteEligibility,
} from "../freeModelEligibility";

const model = normalizeOpenRouterFreeCatalog(
  [
    {
      id: "vendor/tool-model",
      pricing: { prompt: "0", completion: "0" },
      context_length: 64000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools", "response_format"],
    },
  ],
  new Date("2026-09-09T00:00:00.000Z")
).verifiedFree[0];

describe("free model eligibility", () => {
  it("keeps discovered/available/executable/authorized/policy/compatibility/benchmark states separate", () => {
    const profile = buildFreeModelCompatibilityProfile(model, {
      currentlyAvailable: "available",
      technicallyExecutable: "executable",
      apiKeyAuthorized: "authorized",
      policyEligible: "eligible",
      claudeCodeCompatible: "compatible",
      benchmarkVerified: "verified",
      streamingSupported: true,
      healthy: true,
      p95LatencyMs: 900,
    });
    expect(profile.discovered).toBe(true);
    expect(profile.currentlyAvailable).toBe("available");
    expect(profile.technicallyExecutable).toBe("executable");
    expect(profile.apiKeyAuthorized).toBe("authorized");
    expect(profile.policyEligible).toBe("eligible");
    expect(profile.claudeCodeCompatibleState).toBe("compatible");
    expect(profile.benchmarkVerified).toBe("verified");
  });

  it("free/claude-code-fast fails closed on unknowns", () => {
    const profile = buildFreeModelCompatibilityProfile(model);
    const result = evaluateFreeRouteEligibility(profile, "free/claude-code-fast");
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("streaming_unknown");
    expect(result.reasons).toContain("claude_code_compatibility_unknown");
    expect(result.reasons).toContain("api_key_authorization_unknown");
    expect(result.reasons).toContain("benchmark_not_verified");
  });

  it("free/claude-code-fast accepts only fully verified fast tool-compatible models", () => {
    const profile = buildFreeModelCompatibilityProfile(model, {
      currentlyAvailable: "available",
      technicallyExecutable: "executable",
      apiKeyAuthorized: "authorized",
      policyEligible: "eligible",
      claudeCodeCompatible: "compatible",
      benchmarkVerified: "verified",
      streamingSupported: true,
      parallelToolsSupported: true,
      healthy: true,
      p95LatencyMs: 1_200,
    });
    const result = evaluateFreeRouteEligibility(profile, "free/claude-code-fast");
    expect(result).toMatchObject({ eligible: true, reasons: [] });
  });
});
