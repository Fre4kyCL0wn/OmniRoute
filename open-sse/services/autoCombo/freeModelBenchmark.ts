import type { FreeModelCompatibilityProfile } from "./freeModelEligibility";

export type FreeModelBenchmarkScenarioId =
  | "simple_text"
  | "short_coding"
  | "streaming"
  | "one_tool_call"
  | "tool_result_continuation"
  | "multi_turn_tool_flow";

export interface FreeModelBenchmarkScenario {
  id: FreeModelBenchmarkScenarioId;
  label: string;
  stream: boolean;
  maxTokens: number;
  turns: number;
  requiresTools: boolean;
  requestTemplate: Record<string, unknown>;
}

export interface FreeModelBenchmarkDryRunCandidate {
  modelId: string;
  routeModelId: string;
  scenarios: FreeModelBenchmarkScenarioId[];
  estimatedRequests: number;
  reasons: string[];
}

export interface FreeModelBenchmarkDryRunPlan {
  mode: "dry_run";
  executesProviderTraffic: false;
  scenarioCount: number;
  estimatedRequestCount: number;
  scenarios: FreeModelBenchmarkScenario[];
  candidates: FreeModelBenchmarkDryRunCandidate[];
}

export const FREE_MODEL_BENCHMARK_SCENARIOS: FreeModelBenchmarkScenario[] = [
  {
    id: "simple_text",
    label: "Simple text",
    stream: false,
    maxTokens: 32,
    turns: 1,
    requiresTools: false,
    requestTemplate: { messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 32 },
  },
  {
    id: "short_coding",
    label: "Short coding task",
    stream: false,
    maxTokens: 96,
    turns: 1,
    requiresTools: false,
    requestTemplate: {
      messages: [{ role: "user", content: "Write a JS function add(a,b)." }],
      max_tokens: 96,
    },
  },
  {
    id: "streaming",
    label: "Streaming",
    stream: true,
    maxTokens: 48,
    turns: 1,
    requiresTools: false,
    requestTemplate: { messages: [{ role: "user", content: "Count to three." }], stream: true },
  },
  {
    id: "one_tool_call",
    label: "One tool call",
    stream: false,
    maxTokens: 96,
    turns: 1,
    requiresTools: true,
    requestTemplate: {
      messages: [{ role: "user", content: "Call get_time once." }],
      tools: [{ type: "function", function: { name: "get_time", parameters: { type: "object" } } }],
    },
  },
  {
    id: "tool_result_continuation",
    label: "Tool result continuation",
    stream: false,
    maxTokens: 96,
    turns: 2,
    requiresTools: true,
    requestTemplate: {
      messages: [{ role: "user", content: "Use the tool result in one sentence." }],
    },
  },
  {
    id: "multi_turn_tool_flow",
    label: "Multi-turn tool flow",
    stream: false,
    maxTokens: 128,
    turns: 3,
    requiresTools: true,
    requestTemplate: {
      messages: [{ role: "user", content: "Plan, call a tool, then summarize." }],
    },
  },
];

function scenarioIdsFor(profile: FreeModelCompatibilityProfile): FreeModelBenchmarkScenarioId[] {
  return FREE_MODEL_BENCHMARK_SCENARIOS.filter(
    (scenario) => !scenario.requiresTools || profile.supportsTools === true
  ).map((scenario) => scenario.id);
}

export function buildBenchmarkDryRunPlan(
  profiles: readonly FreeModelCompatibilityProfile[]
): FreeModelBenchmarkDryRunPlan {
  const candidates = profiles.map((profile) => {
    const scenarios = scenarioIdsFor(profile);
    const reasons = [
      profile.verifiedFree ? "pricing_verified_zero" : "pricing_not_verified_zero",
      profile.supportsTools === true ? "tools_declared" : "tools_not_declared",
      profile.supportsStreaming === true ? "streaming_declared" : "streaming_unverified",
      `claude_code_${profile.claudeCodeCompatibleState}`,
    ];
    return {
      modelId: profile.modelId,
      routeModelId: profile.routeModelId,
      scenarios,
      estimatedRequests: scenarios.reduce((sum, id) => {
        const scenario = FREE_MODEL_BENCHMARK_SCENARIOS.find((candidate) => candidate.id === id);
        return sum + (scenario?.turns ?? 1);
      }, 0),
      reasons,
    };
  });

  return {
    mode: "dry_run",
    executesProviderTraffic: false,
    scenarioCount: FREE_MODEL_BENCHMARK_SCENARIOS.length,
    estimatedRequestCount: candidates.reduce(
      (sum, candidate) => sum + candidate.estimatedRequests,
      0
    ),
    scenarios: FREE_MODEL_BENCHMARK_SCENARIOS,
    candidates,
  };
}
