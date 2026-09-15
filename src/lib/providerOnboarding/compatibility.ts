/** Dynamic Claude-Code compatibility evidence for one observed provider model. */
export type ClaudeCodeCompatibilityProbeState = "PASS" | "INCOMPATIBLE" | "TRANSIENT_FAILURE";

export type ClaudeCodeCompatibilityFailureClass =
  | "tool_protocol"
  | "anthropic_translation"
  | "model_unavailable"
  | "auth"
  | "rate_limit"
  | "upstream_5xx"
  | "timeout"
  | "malformed_response"
  | "unknown";

export interface ProviderModelCompatibilityEvidence {
  schemaVersion: 1;
  providerId: string;
  connectionId: string;
  providerModelId: string;
  canonicalModelId: string;
  state: ClaudeCodeCompatibilityProbeState;
  checkedAt: string;
  expiresAt: string;
  source: "claude-v1-messages-tool-roundtrip";
  latencyMs: number | null;
  failureClass: ClaudeCodeCompatibilityFailureClass | null;
}

export interface ProviderModelCompatibilityInventory {
  schemaVersion: 1;
  providerId: string;
  connectionId: string;
  updatedAt: string;
  models: Record<string, ProviderModelCompatibilityEvidence>;
}

export const COMPATIBILITY_PASS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPATIBILITY_INCOMPATIBLE_TTL_MS = 24 * 60 * 60 * 1000;
export const COMPATIBILITY_TRANSIENT_TTL_MS = 15 * 60 * 1000;

export function compatibilityTtlMs(state: ClaudeCodeCompatibilityProbeState): number {
  if (state === "PASS") return COMPATIBILITY_PASS_TTL_MS;
  if (state === "INCOMPATIBLE") return COMPATIBILITY_INCOMPATIBLE_TTL_MS;
  return COMPATIBILITY_TRANSIENT_TTL_MS;
}

export function buildCompatibilityEvidence(input: {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  state: ClaudeCodeCompatibilityProbeState;
  checkedAtMs: number;
  latencyMs?: number | null;
  failureClass?: ClaudeCodeCompatibilityFailureClass | null;
}): ProviderModelCompatibilityEvidence {
  const checkedAt = new Date(input.checkedAtMs).toISOString();
  return {
    schemaVersion: 1,
    providerId: input.providerId,
    connectionId: input.connectionId,
    providerModelId: input.providerModelId,
    canonicalModelId: `${input.providerId}/${input.providerModelId}`,
    state: input.state,
    checkedAt,
    expiresAt: new Date(input.checkedAtMs + compatibilityTtlMs(input.state)).toISOString(),
    source: "claude-v1-messages-tool-roundtrip",
    latencyMs: input.latencyMs ?? null,
    failureClass: input.failureClass ?? null,
  };
}

export function compatibilityEvidenceFresh(
  evidence: ProviderModelCompatibilityEvidence | null | undefined,
  nowMs: number
): boolean {
  if (!evidence || evidence.schemaVersion !== 1) return false;
  const expiry = Date.parse(evidence.expiresAt);
  return Number.isFinite(expiry) && expiry > nowMs;
}

export function compatibilityVerdict(
  evidence: ProviderModelCompatibilityEvidence | null | undefined,
  nowMs: number
): boolean | null {
  if (!compatibilityEvidenceFresh(evidence, nowMs) || !evidence) return null;
  if (evidence.state === "PASS") return true;
  if (evidence.state === "INCOMPATIBLE") return false;
  return null;
}
