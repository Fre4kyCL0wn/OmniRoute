export type FreeModelLifecycleState =
  "candidate" | "verified" | "preferred" | "degraded" | "cooldown" | "incompatible";

export type FreeModelLifecycleEvent =
  | "metadata_verified_free"
  | "benchmark_passed"
  | "preferred_selected"
  | "timeout"
  | "malformed_tool_call"
  | "rate_limited"
  | "server_error"
  | "classifier_incompatible"
  | "cooldown_elapsed"
  | "reprobe_passed"
  | "reprobe_failed";

export interface FreeModelLifecycleRecord {
  state: FreeModelLifecycleState;
  failureCount: number;
  malformedToolCallCount: number;
  timeoutCount: number;
  rateLimitCount: number;
  serverErrorCount: number;
  cooldownUntil: string | null;
  reprobeAfter: string | null;
  benchmarkVerified: boolean;
  updatedAt: string;
}

export interface FreeModelLifecycleOptions {
  now?: Date | (() => Date);
  cooldownMs?: number;
  failureThreshold?: number;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;

function resolveNow(now: FreeModelLifecycleOptions["now"]): Date {
  return now instanceof Date ? now : now ? now() : new Date();
}

function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

export function createFreeModelLifecycleRecord(
  now: Date | (() => Date) = () => new Date()
): FreeModelLifecycleRecord {
  const updatedAt = resolveNow(now).toISOString();
  return {
    state: "candidate",
    failureCount: 0,
    malformedToolCallCount: 0,
    timeoutCount: 0,
    rateLimitCount: 0,
    serverErrorCount: 0,
    cooldownUntil: null,
    reprobeAfter: null,
    benchmarkVerified: false,
    updatedAt,
  };
}

export function applyFreeModelLifecycleEvent(
  record: FreeModelLifecycleRecord,
  event: FreeModelLifecycleEvent,
  options: FreeModelLifecycleOptions = {}
): FreeModelLifecycleRecord {
  const now = resolveNow(options.now);
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const next: FreeModelLifecycleRecord = { ...record, updatedAt: now.toISOString() };

  if (event === "metadata_verified_free" && next.state === "candidate") {
    next.state = "verified";
  } else if (event === "benchmark_passed") {
    next.benchmarkVerified = true;
    next.failureCount = 0;
    next.malformedToolCallCount = 0;
    next.timeoutCount = 0;
    next.rateLimitCount = 0;
    next.serverErrorCount = 0;
    next.cooldownUntil = null;
    next.reprobeAfter = null;
    next.state = next.state === "preferred" ? "preferred" : "verified";
  } else if (event === "preferred_selected" && next.benchmarkVerified) {
    next.state = "preferred";
  } else if (event === "classifier_incompatible") {
    next.state = "incompatible";
    next.reprobeAfter = addMs(now, cooldownMs);
  } else if (event === "cooldown_elapsed") {
    if (next.state === "cooldown") {
      next.state = "degraded";
      next.cooldownUntil = null;
      next.reprobeAfter = now.toISOString();
    }
  } else if (event === "reprobe_passed") {
    next.failureCount = 0;
    next.malformedToolCallCount = 0;
    next.timeoutCount = 0;
    next.rateLimitCount = 0;
    next.serverErrorCount = 0;
    next.cooldownUntil = null;
    next.reprobeAfter = null;
    next.state = next.benchmarkVerified ? "verified" : "candidate";
  } else if (event === "reprobe_failed") {
    next.failureCount += 1;
    next.state = "cooldown";
    next.cooldownUntil = addMs(now, cooldownMs);
    next.reprobeAfter = next.cooldownUntil;
  } else if (
    event === "timeout" ||
    event === "malformed_tool_call" ||
    event === "rate_limited" ||
    event === "server_error"
  ) {
    next.failureCount += 1;
    if (event === "timeout") next.timeoutCount += 1;
    if (event === "malformed_tool_call") next.malformedToolCallCount += 1;
    if (event === "rate_limited") next.rateLimitCount += 1;
    if (event === "server_error") next.serverErrorCount += 1;

    if (next.failureCount >= failureThreshold) {
      next.state = "cooldown";
      next.cooldownUntil = addMs(now, cooldownMs);
      next.reprobeAfter = next.cooldownUntil;
    } else if (next.state === "verified" || next.state === "preferred") {
      next.state = "degraded";
    }
  }

  return next;
}

export function isReprobeDue(record: FreeModelLifecycleRecord, now: Date = new Date()): boolean {
  if (!record.reprobeAfter) return false;
  const reprobeAt = Date.parse(record.reprobeAfter);
  return Number.isFinite(reprobeAt) && reprobeAt <= now.getTime();
}
