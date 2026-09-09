import crypto from "crypto";
import type { DiscoveredOpenRouterModel } from "../../../src/lib/catalog/openrouterFreeDiscovery";
import type { FreeModelCompatibilityProfile } from "./freeModelEligibility";

export type FreeModelBenchmarkScenarioId =
  | "simple_text"
  | "short_coding"
  | "streaming"
  | "one_tool_call"
  | "tool_result_continuation"
  | "multi_turn_tool_flow";

export type FreeModelBenchmarkStage = "A" | "B" | "C" | "D" | "E";

export type FreeModelBenchmarkFailureClass =
  | "auth_failure"
  | "key_policy_denied"
  | "model_unavailable"
  | "model_no_longer_free"
  | "rate_limited"
  | "upstream_5xx"
  | "timeout"
  | "malformed_stream"
  | "route_mismatch"
  | "paid_cost_detected"
  | "generic_tool_unsupported"
  | "tool_protocol_error"
  | "claude_code_tool_protocol_incompatible"
  | "client_safety_classifier"
  | "client_runtime_failure"
  | "benchmark_harness_failure";

export type ClaudeCodeCompatibilityState = "PASS" | "FAIL" | "NOT_RUN";

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

export interface FreeModelBenchmarkAttempt {
  timestamp: string;
  requestedModel: string;
  returnedModel?: string | null;
  stage: FreeModelBenchmarkStage;
  scenario: string;
  run: number;
  httpStatus?: number | null;
  success: boolean;
  failureClass?: FreeModelBenchmarkFailureClass | null;
  reachedRealUpstream?: boolean | null;
  ttfcMs?: number | null;
  ttftMs?: number | null;
  totalLatencyMs?: number | null;
  outputTokens?: number | null;
  inputTokens?: number | null;
  tokensPerSecond?: number | null;
  cost?: number | null;
  rateLimit?: Record<string, string> | null;
  providerModelMismatch?: boolean;
  toolCallResult?: "pass" | "fail" | "not_run" | null;
  correctnessScore?: number | null;
  timeout?: boolean;
  retryCount?: number;
  detail?: string;
}

export interface FreeModelBenchmarkAggregate {
  modelId: string;
  attempts: number;
  successes: number;
  failures: number;
  rateLimits: number;
  timeouts: number;
  routeMismatches: number;
  paidCostDetected: boolean;
  medianTtftMs: number | null;
  p75TtftMs: number | null;
  p95TtftMs: number | null;
  medianTotalLatencyMs: number | null;
  medianTokensPerSecond: number | null;
  codingScore: number;
  genericToolPasses: number;
  genericToolEligible: boolean;
  claudeCodeCompatibility: ClaudeCodeCompatibilityState;
  claudeCodeEligible: boolean;
  reliability: number;
  fastEligible: boolean;
  codingEligible: boolean;
  performanceTier: "FAST" | "ACCEPTABLE" | "SLOW" | "VERY_SLOW" | "UNUSABLE";
}

export interface FreeModelStageSurvivalDecision {
  modelId: string;
  survives: boolean;
  reasons: string[];
}

export interface FreeModelBenchmarkRankings {
  FREE_GENERAL_FAST: string[];
  FREE_CODING: string[];
  FREE_TOOL_CAPABLE: string[];
  FREE_CLAUDE_CODE_FAST: string[];
  FREE_REASONING: string[];
}

export interface SanitizedFreeModelBenchmarkEvidence {
  phase: "O9-F3.3C";
  benchmarkStart: string;
  benchmarkEnd: string;
  endpointClass: "shadow-local";
  target: string;
  productionBenchmarkContacts: 0;
  catalog: Record<string, unknown>;
  candidates: string[];
  exclusions: FreeModelStageSurvivalDecision[];
  attempts: FreeModelBenchmarkAttempt[];
  aggregates: FreeModelBenchmarkAggregate[];
  rankings: FreeModelBenchmarkRankings;
  requestCounts: { intended: number; api: number; retries: number };
  costGuard: { paidCostDetected: boolean; stopped: boolean };
  claudeCodeCompatibility: Record<string, ClaudeCodeCompatibilityState>;
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

export function median(values: readonly (number | null | undefined)[]): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(
  values: readonly (number | null | undefined)[],
  percentileValue: number
): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(100, Math.max(0, percentileValue)) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function classifyBenchmarkFailure(input: {
  httpStatus?: number | null;
  errorMessage?: string | null;
  timeout?: boolean;
  malformedStream?: boolean;
  modelNoLongerFree?: boolean;
  paidCostDetected?: boolean;
  routeMismatch?: boolean;
  genericToolUnsupported?: boolean;
  toolProtocolError?: boolean;
  claudeCodeToolProtocolError?: boolean;
  clientSafetyClassifier?: boolean;
  clientRuntimeFailure?: boolean;
}): FreeModelBenchmarkFailureClass | null {
  if (input.paidCostDetected) return "paid_cost_detected";
  if (input.modelNoLongerFree) return "model_no_longer_free";
  if (input.clientSafetyClassifier) return "client_safety_classifier";
  if (input.clientRuntimeFailure) return "client_runtime_failure";
  if (input.claudeCodeToolProtocolError) return "claude_code_tool_protocol_incompatible";
  if (input.genericToolUnsupported) return "generic_tool_unsupported";
  if (input.toolProtocolError) return "tool_protocol_error";
  if (input.routeMismatch) return "route_mismatch";
  if (input.timeout) return "timeout";
  if (input.malformedStream) return "malformed_stream";
  const status = input.httpStatus ?? null;
  if (status === 401 || status === 403) {
    const msg = (input.errorMessage ?? "").toLowerCase();
    return msg.includes("policy") || msg.includes("denied") ? "key_policy_denied" : "auth_failure";
  }
  if (status === 404 || status === 400) return "model_unavailable";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "upstream_5xx";
  return input.errorMessage ? "benchmark_harness_failure" : null;
}

export function detectRouteMismatch(
  requestedModel: string,
  returnedModel?: string | null
): boolean {
  if (!returnedModel) return false;
  const normalize = (value: string) =>
    value
      .replace(/^openrouter\//, "")
      .trim()
      .toLowerCase();
  return normalize(requestedModel) !== normalize(returnedModel);
}

export function assertStrictFreeCandidate(
  modelId: string,
  catalog: readonly DiscoveredOpenRouterModel[]
): DiscoveredOpenRouterModel {
  const normalized = modelId.replace(/^openrouter\//, "");
  const match = catalog.find(
    (model) => model.modelId === normalized || model.qualifiedModelId === modelId
  );
  if (!match || match.costStatus !== "verified_free") {
    throw new Error(`model_not_currently_verified_free:${modelId}`);
  }
  const input = Number(match.pricing.input);
  const output = Number(match.pricing.output);
  if (input !== 0 || output !== 0) throw new Error(`model_not_zero_priced:${modelId}`);
  return match;
}

export function checkPaidCostGuard(attempt: FreeModelBenchmarkAttempt): void {
  if (typeof attempt.cost === "number" && Number.isFinite(attempt.cost) && attempt.cost > 0) {
    throw new Error(`paid_cost_detected:${attempt.requestedModel}:${attempt.cost}`);
  }
}

function performanceTier(
  aggregate: Pick<FreeModelBenchmarkAggregate, "reliability" | "medianTtftMs">
) {
  if (aggregate.reliability < 0.5 || aggregate.medianTtftMs === null) return "UNUSABLE" as const;
  if (aggregate.medianTtftMs <= 1_500 && aggregate.reliability >= 0.8) return "FAST" as const;
  if (aggregate.medianTtftMs <= 3_500 && aggregate.reliability >= 0.67)
    return "ACCEPTABLE" as const;
  if (aggregate.medianTtftMs <= 7_500) return "SLOW" as const;
  return "VERY_SLOW" as const;
}

export function aggregateBenchmarkAttempts(
  attempts: readonly FreeModelBenchmarkAttempt[],
  claudeCode: Record<string, ClaudeCodeCompatibilityState> = {}
): FreeModelBenchmarkAggregate[] {
  const byModel = new Map<string, FreeModelBenchmarkAttempt[]>();
  for (const attempt of attempts) {
    const list = byModel.get(attempt.requestedModel) ?? [];
    list.push(attempt);
    byModel.set(attempt.requestedModel, list);
  }
  return [...byModel.entries()]
    .map(([modelId, list]) => {
      const successes = list.filter((attempt) => attempt.success).length;
      const failures = list.length - successes;
      const coding = list.filter((attempt) => attempt.stage === "B");
      const tool = list.filter((attempt) => attempt.stage === "C");
      const aggregate = {
        modelId,
        attempts: list.length,
        successes,
        failures,
        rateLimits: list.filter((attempt) => attempt.failureClass === "rate_limited").length,
        timeouts: list.filter((attempt) => attempt.failureClass === "timeout" || attempt.timeout)
          .length,
        routeMismatches: list.filter((attempt) => attempt.providerModelMismatch).length,
        paidCostDetected: list.some((attempt) => attempt.failureClass === "paid_cost_detected"),
        medianTtftMs: median(list.map((attempt) => attempt.ttftMs)),
        p75TtftMs: percentile(
          list.map((attempt) => attempt.ttftMs),
          75
        ),
        p95TtftMs: percentile(
          list.map((attempt) => attempt.ttftMs),
          95
        ),
        medianTotalLatencyMs: median(list.map((attempt) => attempt.totalLatencyMs)),
        medianTokensPerSecond: median(list.map((attempt) => attempt.tokensPerSecond)),
        codingScore: coding.length
          ? coding.reduce((sum, a) => sum + (a.correctnessScore ?? 0), 0) / coding.length
          : 0,
        genericToolPasses: tool.filter((attempt) => attempt.toolCallResult === "pass").length,
        genericToolEligible:
          tool.length > 0 && tool.every((attempt) => attempt.toolCallResult === "pass"),
        claudeCodeCompatibility: claudeCode[modelId] ?? "NOT_RUN",
        claudeCodeEligible: claudeCode[modelId] === "PASS",
        reliability: list.length === 0 ? 0 : successes / list.length,
        fastEligible: false,
        codingEligible: false,
        performanceTier: "UNUSABLE" as const,
      } satisfies FreeModelBenchmarkAggregate;
      aggregate.fastEligible = aggregate.reliability >= 0.67 && !aggregate.paidCostDetected;
      aggregate.codingEligible = coding.length > 0 && aggregate.codingScore >= 0.75;
      aggregate.performanceTier = performanceTier(aggregate);
      return aggregate;
    })
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function evaluateStageASurvival(
  modelIds: readonly string[],
  attempts: readonly FreeModelBenchmarkAttempt[],
  currentStrictFreeIds: ReadonlySet<string>
): FreeModelStageSurvivalDecision[] {
  return modelIds.map((modelId) => {
    const modelAttempts = attempts.filter((attempt) => attempt.requestedModel === modelId);
    const successes = modelAttempts.filter((attempt) => attempt.success).length;
    const reasons: string[] = [];
    if (!currentStrictFreeIds.has(modelId.replace(/^openrouter\//, "")))
      reasons.push("not_currently_strict_free");
    if (successes < 2) reasons.push("less_than_2_of_3_basic_successes");
    if (modelAttempts.some((attempt) => attempt.failureClass === "auth_failure"))
      reasons.push("auth_failure");
    if (modelAttempts.some((attempt) => attempt.providerModelMismatch))
      reasons.push("route_mismatch");
    if (modelAttempts.some((attempt) => attempt.failureClass === "paid_cost_detected"))
      reasons.push("paid_cost_detected");
    if (modelAttempts.filter((attempt) => attempt.failureClass === "timeout").length >= 2)
      reasons.push("persistent_timeout");
    return { modelId, survives: reasons.length === 0, reasons };
  });
}

function latencyRank(aggregates: readonly FreeModelBenchmarkAggregate[]) {
  return [...aggregates].sort(
    (a, b) =>
      (a.medianTtftMs ?? Number.POSITIVE_INFINITY) - (b.medianTtftMs ?? Number.POSITIVE_INFINITY) ||
      b.reliability - a.reliability
  );
}

export function rankBenchmarkAggregates(
  aggregates: readonly FreeModelBenchmarkAggregate[]
): FreeModelBenchmarkRankings {
  const reliable = aggregates.filter(
    (a) => a.fastEligible && !a.paidCostDetected && !a.routeMismatches
  );
  return {
    FREE_GENERAL_FAST: latencyRank(reliable).map((a) => a.modelId),
    FREE_CODING: [...reliable]
      .filter((a) => a.codingEligible)
      .sort(
        (a, b) =>
          b.codingScore - a.codingScore ||
          (a.medianTtftMs ?? Number.POSITIVE_INFINITY) -
            (b.medianTtftMs ?? Number.POSITIVE_INFINITY)
      )
      .map((a) => a.modelId),
    FREE_TOOL_CAPABLE: latencyRank(reliable.filter((a) => a.genericToolEligible)).map(
      (a) => a.modelId
    ),
    FREE_CLAUDE_CODE_FAST: latencyRank(
      reliable.filter((a) => a.claudeCodeEligible && a.codingEligible)
    ).map((a) => a.modelId),
    FREE_REASONING: [],
  };
}

export function sanitizeEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|api[_-]?key|token|password|cookie|secret|credential/i.test(key)) continue;
    clean[key] = sanitizeEvidenceValue(entry);
  }
  return clean;
}

export function buildSanitizedBenchmarkEvidence(input: SanitizedFreeModelBenchmarkEvidence) {
  return sanitizeEvidenceValue(input) as SanitizedFreeModelBenchmarkEvidence;
}

export function deterministicShuffle<T>(items: readonly T[], seed: string): T[] {
  return [...items]
    .map((item, index) => {
      const hash = crypto
        .createHash("sha256")
        .update(`${seed}:${index}:${String(item)}`)
        .digest("hex");
      return { item, hash };
    })
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map((entry) => entry.item);
}
