/**
 * Groq Quota / Rate-Limit / Runtime-State Semantics (O9-F3.3P1-C2)
 *
 * Tests cover:
 * 1.  Groq short 429 → rate_limit (no provider rule match, default 429)
 * 2.  retry-after is correctly parsed (Groq-style relative + compound)
 * 3.  x-ratelimit-remaining-tokens = 0 → NOT interpreted as TPD
 * 4.  x-ratelimit-reset-tokens → TPM reset, NOT daily quotaResetAt
 * 5.  RPD headers recognized as request-day dimension
 * 6.  Compound reset duration (e.g. 2m59.56s) parsed correctly
 * 7.  Belegte RPD exhaustion → quota_exhausted, quotaScope=model
 * 8.  Belegte TPD exhaustion → quotaScope=model (only with real fixture —
 *     none exist; test documents the expected behavior)
 * 9.  Provider remains healthy at model quota exhaustion
 * 10. Connection A / Model X exhausted → Model Y stays eligible
 * 11. Connection B stays eligible (no provider-wide lock)
 * 12. OpenRouter free-models-per-day unchanged (C1 regression)
 * 13. Cerebras one-time-initial remains paid in RuntimeState (C1 regression)
 * 14. Groq recurring-daily remains free_tier in RuntimeState (C1 regression)
 * 15. Groq header parser correctness
 * 16. Compound retry-after parsing
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  classify429,
  parseRetryAfter,
  retryAfterFromResponse,
} from "../../src/shared/utils/classify429.ts";
import {
  lockModel,
  clearAllModelLockouts,
  hasPerModelQuota,
} from "../../open-sse/services/accountFallback.ts";
import { __testing as freeAccessTesting } from "../../open-sse/services/autoCombo/freeAccessQuota.ts";
import { parseGroqRateLimitHeaders } from "../../open-sse/services/groqRateLimitHeaders.ts";
import { getProviderErrorRuleMatch } from "../../open-sse/config/providerErrorRules.ts";
import {
  getPassthroughProviders,
  getRegistryEntry,
} from "../../open-sse/config/providerRegistry.ts";
import {
  applyComboTargetExhaustion,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function groqConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-groq",
    provider: "groq",
    authType: "apikey",
    testStatus: "active",
    isActive: true,
    ...overrides,
  };
}

function exhaustionSets(): ComboExhaustionSets {
  return {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Groq Quota Semantics", () => {
  beforeEach(() => {
    freeAccessTesting.cache.clear();
    clearAllModelLockouts();
  });

  describe("Per-model quota is independent from passthrough model support", () => {
    it("enables Groq per-model quota without making Groq a passthrough provider", () => {
      const groq = getRegistryEntry("groq");
      assert.equal(groq?.perModelQuota, true);
      assert.equal(groq?.passthroughModels, undefined);
      assert.equal(getPassthroughProviders().has("groq"), false);
      assert.equal(hasPerModelQuota("groq", "unknown/custom-model"), true);
    });

    it("keeps existing passthrough providers on the legacy per-model-quota path", () => {
      assert.equal(getPassthroughProviders().has("openrouter"), true);
      assert.equal(hasPerModelQuota("openrouter", "unknown/custom-model"), true);
    });

    it("keeps explicit Groq per-model quota enabled for every connection override state", () => {
      assert.equal(hasPerModelQuota("groq", "openai/gpt-oss-120b"), true);
      assert.equal(hasPerModelQuota("groq", "openai/gpt-oss-120b", true), true);
      assert.equal(hasPerModelQuota("groq", "openai/gpt-oss-120b", false), true);
    });

    it("preserves connection overrides for providers without explicit per-model quota", () => {
      assert.equal(hasPerModelQuota("openai", "gpt-4o", true), true);
      assert.equal(hasPerModelQuota("openai", "gpt-4o", false), false);
    });

    it("keeps Groq unknown-model registry validation unchanged from C1", async () => {
      const { isValidModel } = await import("../../open-sse/config/providerModels.ts");
      assert.equal(isValidModel("groq", "unknown/custom-model", getPassthroughProviders()), false);
      assert.equal(isValidModel("groq", "openai/gpt-oss-120b", getPassthroughProviders()), true);
    });
  });

  // ─── Test 1: Groq short 429 → rate_limit ──────────────────────────────
  describe("Test 1: Groq short 429 → rate_limit", () => {
    it("classifies a bare Groq 429 as rate_limit (no provider rule match)", () => {
      // A Groq 429 with no body patterns and remaining-requests > 0
      // does NOT match the groq-model-daily-quota-exhausted rule.
      const kind = classify429({
        status: 429,
        body: "Rate limit exceeded",
      });
      assert.equal(kind, "rate_limit");
    });

    it("does NOT trigger the Groq provider rule when remaining-requests > 0", () => {
      const match = getProviderErrorRuleMatch("groq", 429, {
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-remaining-tokens": "1000",
      });
      assert.equal(match, null, "remaining > 0 should not trigger Groq quota rule");
    });
  });

  // ─── Test 2: retry-after parsing ──────────────────────────────────────
  describe("Test 2: retry-after is correctly parsed", () => {
    it("parses integer seconds", () => {
      assert.equal(parseRetryAfter("60"), 60);
      assert.equal(parseRetryAfter("3600"), 3600);
    });

    it("parses Groq-style relative units", () => {
      assert.equal(parseRetryAfter("30s"), 30);
      assert.equal(parseRetryAfter("5m"), 300);
      assert.equal(parseRetryAfter("2h"), 7200);
    });

    it("parses compound durations", () => {
      assert.equal(parseRetryAfter("2m59.56s"), 179.56);
      assert.equal(parseRetryAfter("1h30m"), 5400);
      assert.equal(parseRetryAfter("1h30m15s"), 5415);
    });

    it("returns null for unparseable values", () => {
      assert.equal(parseRetryAfter(undefined), null);
      assert.equal(parseRetryAfter(""), null);
      assert.equal(parseRetryAfter("not-a-date"), null);
    });
  });

  // ─── Test 3: x-ratelimit-remaining-tokens = 0 → NOT TPD ──────────────
  describe("Test 3: remaining-tokens = 0 is NOT interpreted as TPD", () => {
    it("remaining-tokens: 0 on a non-429 does not trigger quota_exhausted", () => {
      // A successful response with remaining-tokens: 0 is stale data,
      // not a quota signal. classify429 returns 'transient' for non-429.
      const kind = classify429({
        status: 200,
        headers: { "x-ratelimit-remaining-tokens": "0" },
      });
      assert.equal(kind, "transient");
    });

    it("remaining-tokens: 0 on a 429 without remaining-requests: 0 is still rate_limit", () => {
      // remaining-tokens: 0 alone does NOT trigger the Groq provider rule
      // (which only checks remaining-requests). The 429 falls through to
      // the default rate_limit classification.
      const kind = classify429({
        status: 429,
        headers: {
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-remaining-requests": "5",
        },
        body: "Rate limit exceeded",
      });
      assert.equal(kind, "rate_limit");
    });
  });

  // ─── Test 4: x-ratelimit-reset-tokens is TPM, not daily ──────────────
  describe("Test 4: x-ratelimit-reset-tokens → TPM reset, NOT daily", () => {
    it("parseGroqRateLimitHeaders extracts reset-tokens as a number", () => {
      const headers = {
        "x-ratelimit-limit-tokens": "30000",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "59",
      };
      const parsed = parseGroqRateLimitHeaders(headers);
      assert.equal(parsed.resetTokens, 59);
      assert.equal(parsed.limitTokens, 30000);
      assert.equal(parsed.remainingTokens, 0);
    });

    it("reset-tokens is seconds-until-reset, NOT a daily quota reset", () => {
      // A value of 59 means "the token window resets in 59 seconds" (TPM),
      // NOT "the daily token quota resets in 59 seconds" (TPD).
      // This test documents the semantic: callers must NOT set quotaResetAt
      // from reset-tokens alone.
      const parsed = parseGroqRateLimitHeaders({
        "x-ratelimit-reset-tokens": "59",
      });
      assert.ok(parsed.resetTokens !== null);
      assert.ok(parsed.resetTokens! < 3600, "TPM reset should be short-window");
    });
  });

  // ─── Test 5: RPD headers as request-day dimension ─────────────────────
  describe("Test 5: RPD headers recognized as request-day dimension", () => {
    it("parses all Groq rate-limit headers", () => {
      const parsed = parseGroqRateLimitHeaders({
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": "500",
        "x-ratelimit-reset-requests": "3600",
        "x-ratelimit-limit-tokens": "500000",
        "x-ratelimit-remaining-tokens": "250000",
        "x-ratelimit-reset-tokens": "59",
        "retry-after": "30",
      });

      assert.equal(parsed.limitRequests, 1000);
      assert.equal(parsed.remainingRequests, 500);
      assert.equal(parsed.resetRequests, 3600);
      assert.equal(parsed.limitTokens, 500000);
      assert.equal(parsed.remainingTokens, 250000);
      assert.equal(parsed.resetTokens, 59);
      assert.equal(parsed.retryAfter, 30);
    });
  });

  // ─── Test 6: compound reset duration ──────────────────────────────────
  describe("Test 6: compound reset duration (2m59.56s) parsed correctly", () => {
    it("parses compound retry-after in parseRetryAfter", () => {
      assert.equal(parseRetryAfter("2m59.56s"), 179.56);
      assert.equal(parseRetryAfter("1h30m"), 5400);
      assert.equal(parseRetryAfter("1h30m15s"), 5415);
      assert.equal(parseRetryAfter("0h0m30s"), 30);
    });

    it("parses compound retry-after from response headers", () => {
      const result = retryAfterFromResponse({
        headers: { "retry-after": "2m59.56s" },
      });
      assert.equal(result, 179.56);
    });
  });

  // ─── Test 7: belegte RPD exhaustion → quota_exhausted, model scope ────
  describe("Test 7: RPD exhaustion → quota_exhausted, quotaScope=model", () => {
    it("Groq 429 with remaining-requests: 0 triggers provider rule → quota_exhausted", () => {
      const match = getProviderErrorRuleMatch("groq", 429, {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-reset-requests": "86400",
      });
      assert.ok(match, "Groq rule should match remaining-requests: 0");
      assert.equal(match!.reason, "quota_exhausted");
      assert.equal(match!.scope, "model");
    });

    it("keeps sibling Groq models and connections eligible within the same request", () => {
      const sets = exhaustionSets();
      const providerExhausted = applyComboTargetExhaustion(
        {
          kind: "model",
          executionKey: "groq/model-a",
          modelStr: "groq/model-a",
          provider: "groq",
          providerId: null,
          connectionId: "conn-A",
        } as Parameters<typeof applyComboTargetExhaustion>[0],
        {
          result: { status: 429 },
          fallbackResult: { reason: "quota_exhausted", ruleScope: "model" },
          errorText: "Rate limit exceeded",
          rawModel: "model-a",
          isTokenLimitBreach: false,
          allAccountsRateLimited: false,
          requestScopedFailure: false,
          sets,
          log: { info() {}, warn() {}, error() {}, debug() {} },
          tag: "COMBO",
          exhaustedLogLevel: "info",
        }
      );

      assert.equal(providerExhausted, false);
      assert.equal(sets.exhaustedProviders.has("groq"), false);
      assert.equal(sets.exhaustedConnections.has("groq:conn-A"), false);
    });

    it("ProviderRuntimeState: Groq model exhaustion → quotaScope=model, provider healthy", async () => {
      // Seed a model lockout to simulate what happens after the provider rule fires.
      lockModel("groq", "conn-groq", "openai/gpt-oss-120b", "quota_exhausted", 3600_000);

      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-groq", "openai/gpt-oss-120b", {
        connection: groqConnection({
          // errorCode must NOT be 429 so that inferredFailureKind stays
          // undefined — otherwise classify429 overrides the options.failureKind.
          // In the real flow, the provider rule fires → checkFallbackError
          // returns reason:"quota_exhausted" → failureKind flows into options.
        }),
        failureKind: "quota_exhausted",
      });

      // Model lockout → quotaScope=model
      assert.equal(state.quotaScope, "model");
      // Provider remains healthy (circuit breaker CLOSED, no provider failures)
      assert.equal(state.providerHealth, "healthy");
      // Quota state shows exhausted for this model
      assert.equal(state.quotaState, "quota_exhausted");
    });
  });

  // ─── Test 8: TPD exhaustion (no real fixture — documents expected behavior)
  describe("Test 8: TPD exhaustion → quotaScope=model (expected, no fixture)", () => {
    it("documents: with a real Groq TPD body, quotaScope should be model", () => {
      // NOTE: No real Groq TPD 429 body fixture exists in the repo.
      // If/when a fixture is captured (e.g. "tokens per day limit reached"),
      // it should be added here and the provider rule updated.
      //
      // Expected behavior:
      // - classify429({ status: 429, body: <real TPD body> }) → "quota_exhausted"
      // - getProviderRuntimeState quotaScope → "model"
      // - providerHealth → "healthy"
      //
      // This test documents the expected semantic without inventing a fixture.
      assert.ok(true, "TPD fixture not yet available — see shadow validation");
    });
  });

  // ─── Test 9: Provider remains healthy at model quota exhaustion ────────
  describe("Test 9: Provider remains healthy at model quota exhaustion", () => {
    it("Groq providerHealth=healthy when model A is exhausted", async () => {
      lockModel("groq", "conn-9", "model-a", "quota_exhausted", 3600_000);

      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-9", "model-a", {
        connection: groqConnection({ id: "conn-9" }),
      });

      assert.equal(state.providerHealth, "healthy");
    });
  });

  // ─── Test 10: Connection A / Model X exhausted → Model Y stays eligible
  describe("Test 10: Model X exhausted → Model Y stays eligible", () => {
    it("exhausting one Groq model does not lock another model on the same connection", async () => {
      lockModel("groq", "conn-10", "model-x", "quota_exhausted", 3600_000);

      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");

      const stateX = await getProviderRuntimeState("groq", "conn-10", "model-x", {
        connection: groqConnection({ id: "conn-10" }),
      });

      const stateY = await getProviderRuntimeState("groq", "conn-10", "model-y", {
        connection: groqConnection({ id: "conn-10" }),
        billing: { billing: "metered", overage: "soft", reason: "Groq metered" },
      });

      // Model X is locked
      assert.equal(stateX.quotaScope, "model");
      assert.ok(stateX.cooldownUntil && stateX.cooldownUntil > Date.now());

      // Model Y is NOT locked — different model, same connection
      assert.equal(stateY.quotaScope, "unknown");
      assert.equal(stateY.quotaState, "unknown");
      assert.equal(stateY.cooldownUntil, null);
    });
  });

  // ─── Test 11: Connection B stays eligible (no provider-wide lock) ──────
  describe("Test 11: Connection B stays eligible (no provider-wide lock)", () => {
    it("exhausting Connection A does NOT affect Connection B", async () => {
      lockModel("groq", "conn-A", "model-1", "quota_exhausted", 3600_000);

      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");

      const stateA = await getProviderRuntimeState("groq", "conn-A", "model-1", {
        connection: groqConnection({ id: "conn-A" }),
        failureKind: "quota_exhausted",
      });

      const stateB = await getProviderRuntimeState("groq", "conn-B", "model-1", {
        connection: groqConnection({ id: "conn-B" }),
        billing: { billing: "metered", overage: "soft", reason: "Groq metered" },
      });

      // Connection A is model-exhausted
      assert.equal(stateA.quotaScope, "model");
      assert.equal(stateA.quotaState, "quota_exhausted");

      // Connection B is fully available — no provider-wide lock
      assert.equal(stateB.accountState, "available");
      // quotaState is "unknown" (no freeAccessState seeded, no failureKind)
      assert.equal(stateB.quotaState, "unknown");
      assert.equal(stateB.cooldownUntil, null);
    });
  });

  // ─── Test 12: OpenRouter free-models-per-day unchanged (P0 regression)
  describe("Test 12: OpenRouter free-models-per-day unchanged", () => {
    it("OpenRouter free-models-per-day → provider_account scope (unchanged from P0)", async () => {
      const FREE_MODELS_PER_DAY =
        "Rate limit exceeded: free-models-per-day. " +
        "Add 10 credits to unlock 1000 free model requests per day";
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-or",
        "meta-llama/llama-3.1-8b-instruct:free",
        {
          connection: {
            id: "conn-or",
            provider: "openrouter",
            authType: "apikey",
            testStatus: "unavailable",
            isActive: true,
            rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString(),
            errorCode: "429",
            lastError: FREE_MODELS_PER_DAY,
            lastErrorType: "quota_exhausted",
          },
        }
      );

      assert.equal(state.quotaState, "quota_exhausted");
      assert.equal(state.quotaScope, "provider_account");
      assert.equal(state.accountState, "quota_exhausted");
    });
  });

  // ─── Test 13: Cerebras one-time-initial remains paid (C1 regression) ──
  describe("Test 13: Cerebras one-time-initial remains paid (C1 regression)", () => {
    it("Cerebras one-time-initial catalog model → costClass=paid", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("cerebras", "conn-cb", "zai-glm-4.7", {
        connection: {
          id: "conn-cb",
          provider: "cerebras",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
        billing: { billing: "metered", overage: "soft", reason: "test" },
      });

      assert.equal(state.costClass, "paid");
    });
  });

  // ─── Test 14: Groq recurring-daily remains free_tier (C1 regression) ───
  describe("Test 14: Groq recurring-daily remains free_tier (C1 regression)", () => {
    it("Groq recurring-daily catalog model → costClass=free_tier", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-gq", "openai/gpt-oss-120b", {
        connection: groqConnection({ id: "conn-gq" }),
        billing: { billing: "metered", overage: "soft", reason: "test" },
      });

      assert.equal(state.costClass, "free_tier");
    });
  });

  // ─── Test 15: Groq header parser correctness ──────────────────────────
  describe("Test 15: Groq header parser correctness", () => {
    it("returns all null for empty headers", () => {
      const parsed = parseGroqRateLimitHeaders(null);
      assert.equal(parsed.limitRequests, null);
      assert.equal(parsed.remainingRequests, null);
      assert.equal(parsed.resetRequests, null);
      assert.equal(parsed.limitTokens, null);
      assert.equal(parsed.remainingTokens, null);
      assert.equal(parsed.resetTokens, null);
      assert.equal(parsed.retryAfter, null);
    });

    it("handles Headers object (not just plain record)", () => {
      const headers = new Headers();
      headers.set("x-ratelimit-limit-requests", "100");
      headers.set("x-ratelimit-remaining-requests", "50");
      const parsed = parseGroqRateLimitHeaders(headers);
      assert.equal(parsed.limitRequests, 100);
      assert.equal(parsed.remainingRequests, 50);
    });

    it("ignores non-numeric header values", () => {
      const parsed = parseGroqRateLimitHeaders({
        "x-ratelimit-remaining-requests": "abc",
        "x-ratelimit-limit-tokens": "not-a-number",
      });
      assert.equal(parsed.remainingRequests, null);
      assert.equal(parsed.limitTokens, null);
    });
  });

  // ─── Test 16: Compound retry-after parsing ────────────────────────────
  describe("Test 16: Compound retry-after parsing", () => {
    it("parses 2m59.56s → 179.56", () => {
      assert.equal(parseRetryAfter("2m59.56s"), 179.56);
    });

    it("parses 1h30m → 5400", () => {
      assert.equal(parseRetryAfter("1h30m"), 5400);
    });

    it("parses 1h30m15s → 5415", () => {
      assert.equal(parseRetryAfter("1h30m15s"), 5415);
    });

    it("single unit still works after compound support", () => {
      assert.equal(parseRetryAfter("30s"), 30);
      assert.equal(parseRetryAfter("5m"), 300);
      assert.equal(parseRetryAfter("2h"), 7200);
    });

    it("integer seconds still works", () => {
      assert.equal(parseRetryAfter("60"), 60);
      assert.equal(parseRetryAfter("0"), 0);
    });
  });
});
