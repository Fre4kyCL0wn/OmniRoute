import {
  getModelAvailabilityInventory,
  recordModelTestAvailability,
} from "@/lib/db/modelAvailability";
import { normalizeAvailabilityModelId, type ModelAvailabilityRecord } from "./state";

const MODEL_UNAVAILABLE_RE =
  /\b(model(?:\s+is)?\s+(?:unavailable|not\s+found|unknown)|unknown\s+model|model_not_found)\b/i;

export interface RuntimeModelFailureInput {
  providerId: string;
  connectionId: string;
  modelId: string;
  status: number;
  errorText?: string;
  errorCode?: string | null;
  quotaExhausted?: boolean;
}

export function recordRuntimeModelFailure(
  input: RuntimeModelFailureInput
): ModelAvailabilityRecord | null {
  const modelUnavailable =
    input.status === 404 ||
    input.errorCode === "model_not_found" ||
    MODEL_UNAVAILABLE_RE.test(input.errorText ?? "");
  const rateLimited = input.status === 429;
  if (!modelUnavailable && !rateLimited) return null;

  return recordModelTestAvailability({
    providerId: input.providerId,
    connectionId: input.connectionId,
    modelId: input.modelId,
    source: "runtime",
    result: {
      status: rateLimited ? "rate_limited" : "error",
      statusCode: input.status,
      rateLimited,
      isQuota: rateLimited && input.quotaExhausted === true,
      error: input.errorText,
    },
  });
}

export function recordRuntimeModelSuccessIfTracked(input: {
  providerId: string;
  connectionId: string;
  modelId: string;
}): ModelAvailabilityRecord | null {
  const inventory = getModelAvailabilityInventory(input.connectionId);
  if (!inventory || inventory.providerId !== input.providerId) return null;
  const modelId = normalizeAvailabilityModelId(input.providerId, input.modelId);
  const existing = inventory.models[modelId];
  if (!existing || existing.state === "available") return null;
  return recordModelTestAvailability({
    providerId: input.providerId,
    connectionId: input.connectionId,
    modelId,
    source: "runtime",
    result: { status: "ok", statusCode: 200 },
  });
}
