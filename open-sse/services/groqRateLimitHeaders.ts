/**
 * Groq Rate-Limit Header Parsing
 *
 * Groq exposes per-request rate-limit metadata via standard headers.
 * This module parses them into a structured form for downstream
 * classification (providerRuntimeState, quota-scope decisions).
 *
 * ## Groq header semantics (verified):
 *
 *   x-ratelimit-limit-requests     — max requests in the current window
 *   x-ratelimit-remaining-requests — requests remaining in the current window
 *   x-ratelimit-reset-requests     — seconds until the window resets
 *
 *   x-ratelimit-limit-tokens       — max tokens in the current window
 *   x-ratelimit-remaining-tokens   — tokens remaining in the current window
 *   x-ratelimit-reset-tokens       — seconds until the window resets
 *
 *   retry-after                    — concrete retry hint on 429 (seconds or
 *                                    Groq-style "Ns"/"Nm"/"Nh")
 *
 * ## Critical distinction:
 *
 *   x-ratelimit-reset-* is a TPM/RPM WINDOW reset — NOT a daily (TPD/RPD)
 *   reset. TPD/RPD exist as separate limits but are NOT directly represented
 *   in these headers. A remaining=0 on these headers means the CURRENT
 *   WINDOW is exhausted, not necessarily the daily quota.
 *
 * ## Scope note:
 *
 *   Groq limits are model-specific: exhausting openai/gpt-oss-120b does NOT
 *   automatically exhaust qwen/qwen3.8-27b on the same connection. Org/project
 *   limits exist as an independent ceiling but we hold no reliable
 *   organizationId/projectId, so we never infer provider-wide exhaustion.
 *
 * @module open-sse/services/groqRateLimitHeaders
 */

/**
 * Parsed Groq rate-limit header values.
 *
 * All numeric fields are `number | null` — null when the header is absent
 * or unparseable. Callers must check for null before acting on a value.
 */
export interface GroqRateLimitHeaders {
  /** Max requests in the current window (from x-ratelimit-limit-requests). */
  limitRequests: number | null;
  /** Requests remaining in the current window. */
  remainingRequests: number | null;
  /** Seconds until the request window resets. */
  resetRequests: number | null;

  /** Max tokens in the current window (from x-ratelimit-limit-tokens). */
  limitTokens: number | null;
  /** Tokens remaining in the current window. */
  remainingTokens: number | null;
  /** Seconds until the token window resets. */
  resetTokens: number | null;

  /** Upstream retry-after hint (from retry-after header). */
  retryAfter: number | null;
}

/**
 * Parse a positive integer from a header string. Returns null if the value
 * is absent, empty, or not a valid positive integer.
 */
function parsePositiveInt(value: string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalize a headers value (Headers object, plain record, or null) into
 * a case-insensitive plain record for safe lookups.
 */
function toRecord(
  headers: Headers | Record<string, string> | null | undefined
): Record<string, string> {
  if (!headers) return {};
  if (typeof (headers as Headers).entries === "function") {
    try {
      return Object.fromEntries((headers as Headers).entries());
    } catch {
      return {};
    }
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
  );
}

/**
 * Case-insensitive header lookup from a plain record.
 */
function h(rec: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parse Groq rate-limit headers from a response.
 *
 * Returns a fully-populated GroqRateLimitHeaders with null for any
 * absent or unparseable header. This is a pure function with no side
 * effects — safe to call on every response for classification.
 */
export function parseGroqRateLimitHeaders(
  headers: Headers | Record<string, string> | null | undefined
): GroqRateLimitHeaders {
  const rec = toRecord(headers);
  return {
    limitRequests: parsePositiveInt(h(rec, "x-ratelimit-limit-requests")),
    remainingRequests: parsePositiveInt(h(rec, "x-ratelimit-remaining-requests")),
    resetRequests: parsePositiveInt(h(rec, "x-ratelimit-reset-requests")),
    limitTokens: parsePositiveInt(h(rec, "x-ratelimit-limit-tokens")),
    remainingTokens: parsePositiveInt(h(rec, "x-ratelimit-remaining-tokens")),
    resetTokens: parsePositiveInt(h(rec, "x-ratelimit-reset-tokens")),
    retryAfter: parsePositiveInt(h(rec, "retry-after")),
  };
}
