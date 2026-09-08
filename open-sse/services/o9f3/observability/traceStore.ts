/**
 * F3 — Sanitized Routing Decision Trace Store
 *
 * Captures bounded, sanitized per-request routing metadata needed to
 * reconstruct O9 decision paths. NEVER stores prompts, responses,
 * credentials, API keys, tokens, cookies, or Authorization headers.
 *
 * Retention: bounded in-memory (TTL + LRU cap).
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Sanitized observation model                                        */
/* ------------------------------------------------------------------ */

export type Protocol = "anthropic_messages" | "openai_chat";
export type CostClass = "verified_free" | "subscription" | "paid" | "mixed" | "unknown";
export type HealthState = "healthy" | "degraded" | "cooldown" | "auth_failed" | "unavailable" | "unknown";
export type FailureClass =
  | "auth_failure"
  | "cooldown"
  | "circuit_open"
  | "quota_exhausted"
  | "model_lockout"
  | "client_restricted"
  | "timeout"
  | "server_error"
  | "quality_rejection"
  | "availability"
  | "concurrency_cap"
  | "admission_lane"
  | "unknown";

export interface RejectedCandidate {
  candidate: string;
  reason: string;
}

export interface RouteSwitch {
  from: string;
  to: string;
  reason: string;
  timestamp: number;
}

export interface ObservationTrace {
  /** Unique request identifier (not a user identifier). */
  requestId: string;
  /** Correlation id for cross-service tracing. */
  correlationId: string;
  /** Session id (opaque, not user-identifying). */
  sessionId: string | null;
  timestamp: number;
  protocol: Protocol;
  requestedIntent: string;
  requestedModel: string | null;
  requestedCombo: string | null;
  activePolicy: string;
  candidateCount: number;
  executableCandidateCount: number;
  rejectedCandidates: RejectedCandidate[];
  selectedCombo: string | null;
  selectedLeaf: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  costClass: CostClass;
  executable: boolean;
  healthBefore: HealthState;
  healthAfter: HealthState;
  attemptCount: number;
  routeSwitchCount: number;
  routeSwitches: RouteSwitch[];
  failureClass: FailureClass | null;
  fallbackReason: string | null;
  retryAfterMs: number | null;
  cooldownUntilMs: number | null;
  reprobeResult: boolean | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  responseCost: number | null;
  success: boolean;
}

/* ------------------------------------------------------------------ */
/* Bounded store                                                      */
/* ------------------------------------------------------------------ */

const MAX_TRACES = 5000;
const TRACE_TTL_MS = 60 * 60 * 1000; // 1 hour
const traces = new Map<string, ObservationTrace>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, trace] of traces) {
    if (now - trace.timestamp > TRACE_TTL_MS) {
      traces.delete(id);
    }
  }
}

function evictOldest(): void {
  if (traces.size >= MAX_TRACES) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, trace] of traces) {
      if (trace.timestamp < oldestTime) {
        oldestTime = trace.timestamp;
        oldest = id;
      }
    }
    if (oldest) traces.delete(oldest);
  }
}

export function createTraceId(): string {
  return `f3-${randomUUID()}`;
}

export function storeTrace(trace: ObservationTrace): void {
  pruneExpired();
  evictOldest();
  traces.set(trace.requestId, trace);
}

export function getTrace(requestId: string): ObservationTrace | null {
  const trace = traces.get(requestId);
  if (!trace) return null;
  if (Date.now() - trace.timestamp > TRACE_TTL_MS) {
    traces.delete(requestId);
    return null;
  }
  return trace;
}

export function getAllTraces(sinceMs: number = 0): ObservationTrace[] {
  pruneExpired();
  const now = Date.now();
  return Array.from(traces.values())
    .filter((t) => now - t.timestamp <= TRACE_TTL_MS && t.timestamp >= sinceMs)
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function clearTraces(): void {
  traces.clear();
}

export function getTraceCount(): number {
  pruneExpired();
  return traces.size;
}
