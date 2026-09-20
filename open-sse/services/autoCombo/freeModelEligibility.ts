import type { DiscoveredOpenRouterModel } from "../../../src/lib/catalog/openrouterFreeDiscovery";

export type FreeRouteClass =
  "free/claude-code-fast" | "free/coding" | "free/general" | "free/reasoning" | "free/experimental";

export type CompatibilityState = "compatible" | "incompatible" | "unknown";
export type AvailabilityState = "available" | "unavailable" | "unknown";
export type ExecutabilityState = "executable" | "not_executable" | "unknown";
export type AuthorizationState = "authorized" | "unauthorized" | "unknown";
export type PolicyEligibilityState = "eligible" | "ineligible" | "unknown";
export type BenchmarkVerificationState = "verified" | "failed" | "unmeasured";

export interface FreeModelRuntimeSignals {
  currentlyAvailable?: AvailabilityState;
  technicallyExecutable?: ExecutabilityState;
  apiKeyAuthorized?: AuthorizationState;
  policyEligible?: PolicyEligibilityState;
  claudeCodeCompatible?: CompatibilityState;
  benchmarkVerified?: BenchmarkVerificationState;
  healthy?: boolean | null;
  p95LatencyMs?: number | null;
  streamingSupported?: boolean | null;
  parallelToolsSupported?: boolean | null;
  anthropicTranslatorCompatible?: boolean | null;
  claudeCodeSelectableIdCompatible?: boolean | null;
}

export interface FreeModelCompatibilityProfile {
  modelId: string;
  routeModelId: string;
  supportsText: boolean;
  supportsStreaming: boolean | null;
  supportsTools: boolean | null;
  supportsParallelTools: boolean | null;
  supportsStructuredOutputs: boolean | null;
  contextLength: number | null;
  anthropicTranslatorCompatible: boolean | null;
  claudeCodeSelectableIdCompatible: boolean | null;
  claudeCodeCompatibleState: CompatibilityState;
  discovered: true;
  currentlyAvailable: AvailabilityState;
  technicallyExecutable: ExecutabilityState;
  apiKeyAuthorized: AuthorizationState;
  policyEligible: PolicyEligibilityState;
  benchmarkVerified: BenchmarkVerificationState;
  verifiedFree: boolean;
  healthy: boolean | null;
  p95LatencyMs: number | null;
}

export interface FreeRouteEligibilityResult {
  routeClass: FreeRouteClass;
  eligible: boolean;
  reasons: string[];
  profile: FreeModelCompatibilityProfile;
}

const CLAUDE_CODE_FAST_MAX_P95_MS = 4_000;
const MIN_CODING_CONTEXT = 16_000;
const MIN_GENERAL_CONTEXT = 4_000;

function stateOrUnknown<T extends string>(value: T | undefined, unknown: T): T {
  return value ?? unknown;
}

export function buildFreeModelCompatibilityProfile(
  model: DiscoveredOpenRouterModel,
  signals: FreeModelRuntimeSignals = {}
): FreeModelCompatibilityProfile {
  const claudeCodeSelectable = signals.claudeCodeSelectableIdCompatible ?? true;
  const anthropicTranslator = signals.anthropicTranslatorCompatible ?? true;
  const claudeCodeCompatibleState =
    signals.claudeCodeCompatible ??
    (claudeCodeSelectable === false || anthropicTranslator === false
      ? "incompatible"
      : claudeCodeSelectable === true && anthropicTranslator === true
        ? "unknown"
        : "unknown");

  return {
    modelId: model.modelId,
    routeModelId: model.qualifiedModelId,
    supportsText: model.capabilities.supportsText,
    supportsStreaming: signals.streamingSupported ?? model.capabilities.supportsStreaming,
    supportsTools: model.toolSupport,
    supportsParallelTools: signals.parallelToolsSupported ?? null,
    supportsStructuredOutputs: model.structuredOutputSupport,
    contextLength: model.contextLength,
    anthropicTranslatorCompatible: anthropicTranslator,
    claudeCodeSelectableIdCompatible: claudeCodeSelectable,
    claudeCodeCompatibleState,
    discovered: true,
    currentlyAvailable: stateOrUnknown(signals.currentlyAvailable, "unknown"),
    technicallyExecutable: stateOrUnknown(signals.technicallyExecutable, "unknown"),
    apiKeyAuthorized: stateOrUnknown(signals.apiKeyAuthorized, "unknown"),
    policyEligible: stateOrUnknown(signals.policyEligible, "unknown"),
    benchmarkVerified: stateOrUnknown(signals.benchmarkVerified, "unmeasured"),
    verifiedFree: model.costStatus === "verified_free",
    healthy: signals.healthy ?? null,
    p95LatencyMs:
      typeof signals.p95LatencyMs === "number" && Number.isFinite(signals.p95LatencyMs)
        ? signals.p95LatencyMs
        : null,
  };
}

function requireFlag(
  reasons: string[],
  value: boolean | null,
  reason: string,
  unknownReason = reason
): void {
  if (value === true) return;
  reasons.push(value === null ? unknownReason : reason);
}

function requireState<T extends string>(
  reasons: string[],
  value: T,
  expected: T,
  reason: string,
  unknownValue: T,
  unknownReason = reason
): void {
  if (value === expected) return;
  reasons.push(value === unknownValue ? unknownReason : reason);
}

export function evaluateFreeRouteEligibility(
  profile: FreeModelCompatibilityProfile,
  routeClass: FreeRouteClass
): FreeRouteEligibilityResult {
  const reasons: string[] = [];

  if (!profile.verifiedFree) reasons.push("pricing_not_verified_free");
  if (!profile.supportsText) reasons.push("text_not_supported");

  if (routeClass === "free/claude-code-fast") {
    requireFlag(reasons, profile.supportsStreaming, "streaming_not_supported", "streaming_unknown");
    requireFlag(reasons, profile.supportsTools, "tools_not_supported", "tools_unknown");
    requireFlag(
      reasons,
      profile.claudeCodeSelectableIdCompatible,
      "claude_code_id_not_selectable",
      "claude_code_id_unknown"
    );
    requireFlag(
      reasons,
      profile.anthropicTranslatorCompatible,
      "anthropic_translator_incompatible",
      "anthropic_translator_unknown"
    );
    requireState(
      reasons,
      profile.claudeCodeCompatibleState,
      "compatible",
      "claude_code_incompatible",
      "unknown",
      "claude_code_compatibility_unknown"
    );
    requireState(
      reasons,
      profile.currentlyAvailable,
      "available",
      "not_currently_available",
      "unknown",
      "availability_unknown"
    );
    requireState(
      reasons,
      profile.technicallyExecutable,
      "executable",
      "not_technically_executable",
      "unknown",
      "executability_unknown"
    );
    requireState(
      reasons,
      profile.apiKeyAuthorized,
      "authorized",
      "api_key_unauthorized",
      "unknown",
      "api_key_authorization_unknown"
    );
    requireState(
      reasons,
      profile.policyEligible,
      "eligible",
      "policy_ineligible",
      "unknown",
      "policy_eligibility_unknown"
    );
    requireFlag(reasons, profile.healthy, "unhealthy", "health_unknown");
    if (profile.p95LatencyMs === null) reasons.push("latency_unknown");
    else if (profile.p95LatencyMs > CLAUDE_CODE_FAST_MAX_P95_MS) reasons.push("latency_too_high");
    if (profile.benchmarkVerified !== "verified") reasons.push("benchmark_not_verified");
  } else if (routeClass === "free/coding") {
    if ((profile.contextLength ?? 0) < MIN_CODING_CONTEXT) reasons.push("context_too_small");
    if (profile.technicallyExecutable === "not_executable")
      reasons.push("not_technically_executable");
    if (profile.policyEligible === "ineligible") reasons.push("policy_ineligible");
  } else if (routeClass === "free/general") {
    if ((profile.contextLength ?? 0) < MIN_GENERAL_CONTEXT) reasons.push("context_too_small");
    if (profile.technicallyExecutable === "not_executable")
      reasons.push("not_technically_executable");
    if (profile.policyEligible === "ineligible") reasons.push("policy_ineligible");
  } else if (routeClass === "free/reasoning") {
    if (profile.supportsStructuredOutputs === false)
      reasons.push("structured_outputs_not_supported");
    if (profile.technicallyExecutable === "not_executable")
      reasons.push("not_technically_executable");
  } else if (routeClass === "free/experimental") {
    if (profile.policyEligible === "ineligible") reasons.push("policy_ineligible");
  }

  return { routeClass, eligible: reasons.length === 0, reasons, profile };
}

export function evaluateAllFreeRouteClasses(
  profile: FreeModelCompatibilityProfile
): FreeRouteEligibilityResult[] {
  return [
    "free/claude-code-fast",
    "free/coding",
    "free/general",
    "free/reasoning",
    "free/experimental",
  ].map((routeClass) => evaluateFreeRouteEligibility(profile, routeClass));
}
