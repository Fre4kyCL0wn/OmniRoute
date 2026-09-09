import { describe, expect, it } from "vitest";
import { normalizeOpenRouterFreeCatalog } from "../../../../src/lib/catalog/openrouterFreeDiscovery";
import { buildFreeModelCompatibilityProfile } from "../freeModelEligibility";
import {
  aggregateBenchmarkAttempts,
  assertStrictFreeCandidate,
  buildBenchmarkDryRunPlan,
  buildSanitizedBenchmarkEvidence,
  checkPaidCostGuard,
  classifyBenchmarkFailure,
  detectRouteMismatch,
  evaluateStageASurvival,
  median,
  percentile,
  rankBenchmarkAggregates,
  type FreeModelBenchmarkAttempt,
} from "../freeModelBenchmark";

const fixtureModels = normalizeOpenRouterFreeCatalog(
  [
    {
      id: "vendor/tool",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
    },
    {
      id: "vendor/text",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: [],
    },
  ],
  new Date("2026-09-09T00:00:00.000Z")
).verifiedFree;

const toolModel = fixtureModels.find((model) => model.modelId === "vendor/tool");
const textModel = fixtureModels.find((model) => model.modelId === "vendor/text");

if (!toolModel || !textModel) {
  throw new Error("free_model_benchmark_fixture_missing");
}

function attempt(partial: Partial<FreeModelBenchmarkAttempt>): FreeModelBenchmarkAttempt {
  return {
    timestamp: "2026-09-09T00:00:00.000Z",
    requestedModel: "vendor/tool",
    stage: "A",
    scenario: "basic",
    run: 1,
    success: true,
    failureClass: null,
    retryCount: 0,
    ...partial,
  };
}

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

describe("free model benchmark math", () => {
  it("calculates median and interpolated percentiles", () => {
    expect(median([300, 100, null, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(percentile([100, 200, 300, 400], 75)).toBe(325);
    expect(percentile([], 95)).toBeNull();
  });
});

describe("free model benchmark classification", () => {
  it("keeps requested failure classes distinct", () => {
    expect(classifyBenchmarkFailure({ httpStatus: 401 })).toBe("auth_failure");
    expect(classifyBenchmarkFailure({ httpStatus: 403, errorMessage: "policy denied" })).toBe(
      "key_policy_denied"
    );
    expect(classifyBenchmarkFailure({ httpStatus: 404 })).toBe("model_unavailable");
    expect(classifyBenchmarkFailure({ modelNoLongerFree: true })).toBe("model_no_longer_free");
    expect(classifyBenchmarkFailure({ httpStatus: 429 })).toBe("rate_limited");
    expect(classifyBenchmarkFailure({ httpStatus: 502 })).toBe("upstream_5xx");
    expect(classifyBenchmarkFailure({ timeout: true })).toBe("timeout");
    expect(classifyBenchmarkFailure({ malformedStream: true })).toBe("malformed_stream");
    expect(classifyBenchmarkFailure({ routeMismatch: true })).toBe("route_mismatch");
    expect(classifyBenchmarkFailure({ paidCostDetected: true })).toBe("paid_cost_detected");
    expect(classifyBenchmarkFailure({ genericToolUnsupported: true })).toBe(
      "generic_tool_unsupported"
    );
    expect(classifyBenchmarkFailure({ toolProtocolError: true })).toBe("tool_protocol_error");
    expect(classifyBenchmarkFailure({ claudeCodeToolProtocolError: true })).toBe(
      "claude_code_tool_protocol_incompatible"
    );
    expect(classifyBenchmarkFailure({ clientSafetyClassifier: true })).toBe(
      "client_safety_classifier"
    );
    expect(classifyBenchmarkFailure({ clientRuntimeFailure: true })).toBe("client_runtime_failure");
  });

  it("detects route mismatch after normalizing the openrouter prefix", () => {
    expect(detectRouteMismatch("vendor/model:free", "openrouter/vendor/model:free")).toBe(false);
    expect(detectRouteMismatch("vendor/model:free", "openrouter/vendor/paid-model")).toBe(true);
  });
});

describe("free model benchmark cost guard", () => {
  it("requires strict current zero pricing", () => {
    expect(assertStrictFreeCandidate("vendor/tool", [toolModel]).modelId).toBe("vendor/tool");
    expect(() => assertStrictFreeCandidate("vendor/missing:free", [toolModel])).toThrow(
      "model_not_currently_verified_free"
    );
  });

  it("fails closed on paid cost signals", () => {
    expect(() => checkPaidCostGuard(attempt({ cost: 0 }))).not.toThrow();
    expect(() => checkPaidCostGuard(attempt({ cost: 0.0001 }))).toThrow("paid_cost_detected");
  });
});

describe("free model benchmark aggregation and gates", () => {
  it("aggregates latency, reliability, coding, tools, and Claude Code state separately", () => {
    const aggregates = aggregateBenchmarkAttempts(
      [
        attempt({ requestedModel: "vendor/tool", ttftMs: 100, totalLatencyMs: 300 }),
        attempt({ requestedModel: "vendor/tool", ttftMs: 200, totalLatencyMs: 400 }),
        attempt({
          requestedModel: "vendor/tool",
          stage: "B",
          scenario: "coding",
          correctnessScore: 1,
        }),
        attempt({
          requestedModel: "vendor/tool",
          stage: "C",
          scenario: "generic_tool",
          toolCallResult: "pass",
        }),
        attempt({
          requestedModel: "vendor/tool",
          stage: "E",
          scenario: "claude_code_read",
          toolCallResult: "pass",
        }),
      ],
      { "vendor/tool": "PASS" }
    );
    expect(aggregates[0]).toMatchObject({
      successes: 5,
      failures: 0,
      medianTtftMs: 150,
      codingScore: 1,
      genericToolEligible: true,
      claudeCodeCompatibility: "PASS",
      claudeCodeEligible: true,
    });
  });

  it("requires two of three basic successes for Stage-A survival without penalizing one 5xx", () => {
    const decisions = evaluateStageASurvival(
      ["vendor/tool"],
      [
        attempt({ requestedModel: "vendor/tool", run: 1, success: true }),
        attempt({ requestedModel: "vendor/tool", run: 2, success: true }),
        attempt({
          requestedModel: "vendor/tool",
          run: 3,
          success: false,
          failureClass: "upstream_5xx",
        }),
      ],
      new Set(["vendor/tool"])
    );
    expect(decisions).toEqual([{ modelId: "vendor/tool", survives: true, reasons: [] }]);
  });

  it("eliminates Stage-A route mismatch and persistent timeout", () => {
    const decisions = evaluateStageASurvival(
      ["vendor/tool"],
      [
        attempt({
          requestedModel: "vendor/tool",
          run: 1,
          success: false,
          timeout: true,
          failureClass: "timeout",
        }),
        attempt({
          requestedModel: "vendor/tool",
          run: 2,
          success: false,
          timeout: true,
          failureClass: "timeout",
        }),
        attempt({
          requestedModel: "vendor/tool",
          run: 3,
          success: true,
          providerModelMismatch: true,
        }),
      ],
      new Set(["vendor/tool"])
    );
    expect(decisions[0].survives).toBe(false);
    expect(decisions[0].reasons).toEqual(
      expect.arrayContaining([
        "less_than_2_of_3_basic_successes",
        "route_mismatch",
        "persistent_timeout",
      ])
    );
  });
});

describe("free model benchmark scoring", () => {
  it("does not equate generic tool support with Claude Code compatibility", () => {
    const aggregates = aggregateBenchmarkAttempts(
      [
        attempt({ requestedModel: "vendor/tool", stage: "A", ttftMs: 100, totalLatencyMs: 300 }),
        attempt({ requestedModel: "vendor/tool", stage: "B", correctnessScore: 1 }),
        attempt({ requestedModel: "vendor/tool", stage: "C", toolCallResult: "pass" }),
      ],
      { "vendor/tool": "FAIL" }
    );
    const rankings = rankBenchmarkAggregates(aggregates);
    expect(rankings.FREE_TOOL_CAPABLE).toEqual(["vendor/tool"]);
    expect(rankings.FREE_CLAUDE_CODE_FAST).toEqual([]);
  });

  it("ranks Claude Code only when actual compatibility passed", () => {
    const aggregates = aggregateBenchmarkAttempts(
      [
        attempt({ requestedModel: "vendor/tool", stage: "A", ttftMs: 100, totalLatencyMs: 300 }),
        attempt({ requestedModel: "vendor/tool", stage: "B", correctnessScore: 1 }),
        attempt({ requestedModel: "vendor/tool", stage: "C", toolCallResult: "pass" }),
        attempt({ requestedModel: "vendor/tool", stage: "E", toolCallResult: "pass" }),
      ],
      { "vendor/tool": "PASS" }
    );
    expect(rankBenchmarkAggregates(aggregates).FREE_CLAUDE_CODE_FAST).toEqual(["vendor/tool"]);
  });
});

describe("free model benchmark evidence sanitization", () => {
  it("removes credential-bearing fields from nested evidence", () => {
    const evidence = buildSanitizedBenchmarkEvidence({
      phase: "O9-F3.3C",
      benchmarkStart: "2026-09-09T00:00:00.000Z",
      benchmarkEnd: "2026-09-09T00:01:00.000Z",
      endpointClass: "shadow-local",
      target: "http://127.0.0.1:20131",
      productionBenchmarkContacts: 0,
      catalog: { authorization: "Bearer secret", ok: true, nested: { apiKey: "secret" } },
      candidates: [],
      exclusions: [],
      attempts: [],
      aggregates: [],
      rankings: {
        FREE_GENERAL_FAST: [],
        FREE_CODING: [],
        FREE_TOOL_CAPABLE: [],
        FREE_CLAUDE_CODE_FAST: [],
        FREE_REASONING: [],
      },
      requestCounts: { intended: 0, api: 0, retries: 0 },
      costGuard: { paidCostDetected: false, stopped: false },
      claudeCodeCompatibility: {},
    });
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(evidence.catalog).toMatchObject({ ok: true, nested: {} });
  });
});
