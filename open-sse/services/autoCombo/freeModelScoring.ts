import type { FreeModelCompatibilityProfile, FreeRouteClass } from "./freeModelEligibility";

export interface FreeModelBenchmarkMetrics {
  p95LatencyMs?: number | null;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  toolCallSuccessRate?: number | null;
  malformedToolCallRate?: number | null;
  streamingStabilityRate?: number | null;
  unauthorizedRate?: number | null;
  rateLimitRate?: number | null;
  serverErrorRate?: number | null;
  timeoutRate?: number | null;
  sampleCount?: number | null;
}

export interface FreeModelScoreInput {
  profile: FreeModelCompatibilityProfile;
  metrics?: FreeModelBenchmarkMetrics;
  routeClass: FreeRouteClass;
}

export interface FreeModelScoreBreakdown {
  modelId: string;
  routeClass: FreeRouteClass;
  score: number;
  factors: {
    latency: number;
    reliability: number;
    toolUse: number;
    recentHealth: number;
    policyFit: number;
    costClass: number;
    compatibility: number;
    measurementConfidence: number;
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function boundedRate(value: number | null | undefined, unknown = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return unknown;
  return Math.min(1, value);
}

export function latencyScore(metrics: FreeModelBenchmarkMetrics | undefined): number {
  const p95 = metrics?.p95LatencyMs;
  if (typeof p95 !== "number" || !Number.isFinite(p95) || p95 <= 0) return 0.35;
  if (p95 <= 1_000) return 1;
  if (p95 >= 8_000) return 0;
  return clamp01(1 - (p95 - 1_000) / 7_000);
}

export function reliabilityScore(metrics: FreeModelBenchmarkMetrics | undefined): number {
  if (!metrics || !metrics.sampleCount) return 0.45;
  const failureRate =
    boundedRate(metrics.unauthorizedRate) * 0.3 +
    boundedRate(metrics.rateLimitRate) * 0.2 +
    boundedRate(metrics.serverErrorRate) * 0.2 +
    boundedRate(metrics.timeoutRate) * 0.2 +
    boundedRate(metrics.malformedToolCallRate) * 0.1;
  return clamp01(1 - failureRate);
}

export function toolUseScore(
  profile: FreeModelCompatibilityProfile,
  metrics?: FreeModelBenchmarkMetrics
) {
  if (profile.supportsTools !== true) return 0;
  if (!metrics || !metrics.sampleCount) return 0.45;
  const success = boundedRate(metrics.toolCallSuccessRate, 0.45);
  const malformedPenalty = boundedRate(metrics.malformedToolCallRate) * 0.5;
  return clamp01(success - malformedPenalty);
}

export function recentHealthScore(
  profile: FreeModelCompatibilityProfile,
  metrics?: FreeModelBenchmarkMetrics
) {
  if (profile.healthy === false) return 0;
  if (profile.healthy === null) return 0.4;
  const stability = boundedRate(metrics?.streamingStabilityRate, 0.55);
  return clamp01(0.6 + stability * 0.4);
}

export function policyFitScore(profile: FreeModelCompatibilityProfile): number {
  if (profile.policyEligible === "eligible") return 1;
  if (profile.policyEligible === "unknown") return 0.35;
  return 0;
}

export function costClassScore(profile: FreeModelCompatibilityProfile): number {
  return profile.verifiedFree ? 1 : 0;
}

function compatibilityScore(profile: FreeModelCompatibilityProfile): number {
  if (profile.claudeCodeCompatibleState === "compatible") return 1;
  if (profile.claudeCodeCompatibleState === "unknown") return 0.25;
  return 0;
}

function measurementConfidence(metrics?: FreeModelBenchmarkMetrics): number {
  const samples = metrics?.sampleCount;
  if (typeof samples !== "number" || !Number.isFinite(samples) || samples <= 0) return 0.25;
  return clamp01(samples / 5);
}

export function scoreFreeModel(input: FreeModelScoreInput): FreeModelScoreBreakdown {
  const metrics = input.metrics;
  const profile = input.profile;
  const factors = {
    latency: latencyScore(metrics),
    reliability: reliabilityScore(metrics),
    toolUse: toolUseScore(profile, metrics),
    recentHealth: recentHealthScore(profile, metrics),
    policyFit: policyFitScore(profile),
    costClass: costClassScore(profile),
    compatibility: compatibilityScore(profile),
    measurementConfidence: measurementConfidence(metrics),
  };
  const weights =
    input.routeClass === "free/claude-code-fast"
      ? {
          latency: 0.22,
          reliability: 0.2,
          toolUse: 0.18,
          recentHealth: 0.12,
          policyFit: 0.08,
          costClass: 0.08,
          compatibility: 0.07,
          measurementConfidence: 0.05,
        }
      : {
          latency: 0.15,
          reliability: 0.18,
          toolUse: 0.12,
          recentHealth: 0.15,
          policyFit: 0.12,
          costClass: 0.18,
          compatibility: 0.05,
          measurementConfidence: 0.05,
        };
  const score = clamp01(
    factors.latency * weights.latency +
      factors.reliability * weights.reliability +
      factors.toolUse * weights.toolUse +
      factors.recentHealth * weights.recentHealth +
      factors.policyFit * weights.policyFit +
      factors.costClass * weights.costClass +
      factors.compatibility * weights.compatibility +
      factors.measurementConfidence * weights.measurementConfidence
  );
  return { modelId: profile.modelId, routeClass: input.routeClass, score, factors };
}

export function rankFreeModels(inputs: FreeModelScoreInput[]): FreeModelScoreBreakdown[] {
  return inputs
    .map(scoreFreeModel)
    .sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
}
