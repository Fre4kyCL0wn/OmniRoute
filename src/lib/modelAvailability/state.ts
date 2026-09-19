export const MODEL_AVAILABILITY_SCHEMA_VERSION = 1 as const;

export type ModelAvailabilityState =
  "available" | "rate_limited" | "quota_exhausted" | "unavailable" | "degraded" | "incompatible";

export type ModelAvailabilitySource = "manual_test" | "batch_test" | "reprobe" | "runtime";

export interface ModelAvailabilityRecord {
  providerId: string;
  connectionId: string;
  modelId: string;
  state: ModelAvailabilityState;
  checkedAt: string;
  retryAfterAt: string | null;
  statusCode: number | null;
  reason: string;
  consecutiveFailures: number;
  source: ModelAvailabilitySource;
}

export interface ModelAvailabilityInventory {
  schemaVersion: typeof MODEL_AVAILABILITY_SCHEMA_VERSION;
  providerId: string;
  connectionId: string;
  updatedAt: string;
  models: Record<string, ModelAvailabilityRecord>;
}

export interface ModelAvailabilityProbeResult {
  status: string;
  httpStatus?: number;
  statusCode?: number;
  rateLimited?: boolean;
  isQuota?: boolean;
  isTransient?: boolean;
  isTimeout?: boolean;
  retryAfter?: number;
  error?: string;
}

export interface ClassifyModelAvailabilityOptions {
  providerId: string;
  connectionId: string;
  modelId: string;
  result: ModelAvailabilityProbeResult;
  source: ModelAvailabilitySource;
  previous?: ModelAvailabilityRecord | null;
  nowMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function finiteStatus(input: ModelAvailabilityProbeResult): number | null {
  const raw = input.statusCode ?? input.httpStatus;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : null;
}

function retryDelayMs(
  state: Exclude<ModelAvailabilityState, "available">,
  failures: number,
  retryAfterSeconds?: number
): number {
  if (
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.max(5_000, retryAfterSeconds * 1000);
  }
  const step = Math.max(0, Math.min(3, failures - 1));
  const multiplier = 2 ** step;
  switch (state) {
    case "rate_limited":
      return Math.min(2 * HOUR, 10 * MINUTE * multiplier);
    case "quota_exhausted":
      return Math.min(2 * HOUR, 30 * MINUTE * multiplier);
    case "unavailable":
      return Math.min(6 * HOUR, HOUR * multiplier);
    case "incompatible":
      return 6 * HOUR;
    case "degraded":
      return Math.min(HOUR, 10 * MINUTE * multiplier);
  }
}

function classifyFailure(result: ModelAvailabilityProbeResult): {
  state: Exclude<ModelAvailabilityState, "available">;
  reason: string;
} {
  const status = finiteStatus(result);
  if (result.isQuota === true) return { state: "quota_exhausted", reason: "quota_exhausted" };
  if (result.rateLimited === true || status === 429 || result.status === "rate_limited") {
    return { state: "rate_limited", reason: "rate_limited" };
  }
  if (result.isTimeout === true || result.status === "slow") {
    return { state: "degraded", reason: "timeout" };
  }
  if (status === 400 || status === 404) {
    return { state: "unavailable", reason: "model_unavailable" };
  }
  if (status === 401 || status === 403) {
    return { state: "unavailable", reason: "auth_or_policy_denied" };
  }
  if (status !== null && status >= 500) {
    return { state: "degraded", reason: "upstream_5xx" };
  }
  return { state: "degraded", reason: "probe_failed" };
}

export function normalizeAvailabilityModelId(providerId: string, modelId: string): string {
  const trimmed = modelId.trim();
  const prefix = `${providerId.trim()}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

export function classifyModelAvailability(
  options: ClassifyModelAvailabilityOptions
): ModelAvailabilityRecord {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const modelId = normalizeAvailabilityModelId(options.providerId, options.modelId);
  const statusCode = finiteStatus(options.result);

  if (options.result.status === "ok") {
    return {
      providerId: options.providerId,
      connectionId: options.connectionId,
      modelId,
      state: "available",
      checkedAt,
      retryAfterAt: null,
      statusCode,
      reason: "probe_ok",
      consecutiveFailures: 0,
      source: options.source,
    };
  }

  const failure = classifyFailure(options.result);
  const previousFailures =
    options.previous && options.previous.state !== "available"
      ? options.previous.consecutiveFailures
      : 0;
  const consecutiveFailures = previousFailures + 1;
  const delayMs = retryDelayMs(failure.state, consecutiveFailures, options.result.retryAfter);
  return {
    providerId: options.providerId,
    connectionId: options.connectionId,
    modelId,
    state: failure.state,
    checkedAt,
    retryAfterAt: new Date(nowMs + delayMs).toISOString(),
    statusCode,
    reason: failure.reason,
    consecutiveFailures,
    source: options.source,
  };
}

export function isPersistedModelAvailabilityRoutable(
  record: ModelAvailabilityRecord | null | undefined
): boolean {
  return record == null || record.state === "available";
}

export function modelAvailabilityUiStatus(
  record: ModelAvailabilityRecord | null | undefined
): "ok" | "error" | "quota" | null {
  if (!record) return null;
  if (record.state === "available") return "ok";
  if (record.state === "rate_limited" || record.state === "quota_exhausted") return "quota";
  return "error";
}
