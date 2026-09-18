/**
 * Unit tests for Provider Runtime State aggregation layer.
 *
 * Tests cover:
 * 1. OpenRouter free-models-per-day → quota_exhausted + provider_account
 * 2. Ordinary OpenRouter transient 429 → rate_limited
 * 3. Unknown 429 doesn't escalate to provider_account
 * 4. Model-specific failure remains model scope
 * 5. Credential/auth failure remains credential/account scope
 * 6. Provider healthy while one account quota_exhausted
 * 7. One exhausted connection doesn't block separate healthy connection
 * 8. Provider-account exhaustion suppresses all free candidates (no N model lockouts)
 * 9. CostClass unknown stays fail-closed
 * 10. Capability states stay independent, unknown=null
 * 11. CostClass is model-proof driven, not quota/SAFE driven (verified_free /
 *     free_tier require curated free-catalog proof; ":free" suffix or SAFE
 *     allowance alone never proves a model is free)
 *
 * This is a Node native test (node:test). It must NOT rely on `mock.module()`,
 * which only exists on Node >= 22.20 — the repo runs Node 20.20.2. Instead it
 * seeds the module's REAL in-memory state (lockModel, freeAccessQuota.__testing)
 * and injects the connection row / billing verdict through
 * `getProviderRuntimeState`'s options (test seams added for exactly this). The
 * DB read is bypassed via `options.connection`, so no SQLite driver is needed.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { lockModel, getAllModelLockouts } from "../../open-sse/services/accountFallback.ts";
import { __testing as freeAccessTesting } from "../../open-sse/services/autoCombo/freeAccessQuota.ts";

interface ConnectionRow {
  id: string;
  provider: string;
  authType?: string | null;
  testStatus?: string | null;
  rateLimitedUntil?: string | null;
  errorCode?: string | number | null;
  lastError?: string | null;
  lastErrorType?: string | null;
  lastUsedAt?: string | null;
  lastErrorAt?: string | null;
  isActive?: number | boolean | null;
}

const FREE_MODELS_PER_DAY =
  "Rate limit exceeded: free-models-per-day. " +
  "Add 10 credits to unlock 1000 free model requests per day";

// Seeded for Test 7-8 so the healthy sibling (conn-B) reads SAFE free access
// from the real cache instead of kicking off a background quota refresh.
function seedSafeFreeAccess(provider: string, connectionId: string): void {
  freeAccessTesting.cache.set(`${provider}::${connectionId}`, {
    state: {
      status: "SAFE",
      remainingFreeAllowance: 100,
      resetAt: null,
      checkedAt: new Date().toISOString(),
    },
    fetchedAtMs: Date.now(),
  });
}

// Mirrors the metadata classification inside getProviderRuntimeState for the
// (provider, connectionId, model) tuple the test expects to stay lockout-free.
function freeModelsPerDayConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn",
    provider: "openrouter",
    authType: "apikey",
    testStatus: "unavailable",
    isActive: true,
    rateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    errorCode: "429",
    lastError: FREE_MODELS_PER_DAY,
    lastErrorType: "quota_exhausted",
    lastUsedAt: new Date().toISOString(),
    lastErrorAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Provider Runtime State", () => {
  beforeEach(() => {
    freeAccessTesting.cache.clear();
  });

  describe("Test 1: OpenRouter free-models-per-day error classification", () => {
    it("classifies the persisted raw upstream error without caller flags", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-1",
        "meta-llama/llama-3.1-8b-instruct:free",
        { connection: freeModelsPerDayConnection({ id: "conn-1" }) }
      );

      assert.equal(state.quotaState, "quota_exhausted");
      assert.equal(state.quotaScope, "provider_account");
      assert.equal(state.accountState, "quota_exhausted");
      assert.equal(state.failureReason, "free-models-per-day");
    });
  });

  describe("Test 2: Ordinary OpenRouter transient 429", () => {
    it("should classify as rate_limited, not provider_account", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-2",
        "meta-llama/llama-3.1-8b-instruct:free",
        {
          connection: freeModelsPerDayConnection({
            id: "conn-2",
            rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
            lastError: "Rate limit exceeded. Please retry shortly.",
            lastErrorType: "rate_limited",
          }),
        }
      );

      assert.equal(state.quotaState, "rate_limited");
      assert.equal(state.quotaScope, "unknown");
      assert.equal(state.accountState, "rate_limited");
    });
  });

  describe("Test 3: quota exhaustion without scope evidence", () => {
    it("keeps quotaScope unknown", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-3",
        "meta-llama/llama-3.1-8b-instruct:free",
        {
          connection: freeModelsPerDayConnection({
            id: "conn-3",
            lastError: "You exceeded your daily limit.",
          }),
        }
      );

      assert.equal(state.quotaState, "quota_exhausted");
      assert.equal(state.accountState, "quota_exhausted");
      assert.equal(state.quotaScope, "unknown");
    });
  });

  describe("Test 4: Model-specific failure remains model scope", () => {
    it("should classify model lockout as model scope", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // Seed the REAL in-memory model-lockout store (no DB involved).
      lockModel(
        "openrouter",
        "conn-4",
        "meta-llama/llama-3.1-8b-instruct",
        "model_rate_limit",
        60_000
      );

      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-4",
        "meta-llama/llama-3.1-8b-instruct",
        {
          connection: {
            id: "conn-4",
            provider: "openrouter",
            authType: "oauth",
            testStatus: "active",
            isActive: true,
          },
        }
      );

      assert.equal(state.quotaScope, "model");
      assert.ok(state.cooldownUntil && state.cooldownUntil > Date.now());
      assert.ok(state.failureReason?.includes("model_rate_limit"));
    });
  });

  describe("Test 5: Credential/auth failure remains credential/account scope", () => {
    it("should classify auth errors as credential scope", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-5",
        "meta-llama/llama-3.1-8b-instruct",
        {
          connection: {
            id: "conn-5",
            provider: "openrouter",
            authType: "oauth",
            testStatus: "active",
            isActive: true,
            errorCode: "401",
            lastError: "Invalid API key",
            lastErrorType: "auth_error",
          },
        }
      );

      assert.equal(state.quotaScope, "credential");
      assert.equal(state.accountState, "auth_failed");
    });

    it("should classify 403 as credential scope", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-5b",
        "meta-llama/llama-3.1-8b-instruct",
        {
          connection: {
            id: "conn-5b",
            provider: "openrouter",
            authType: "oauth",
            testStatus: "active",
            isActive: true,
            errorCode: "403",
            lastError: "Forbidden",
            lastErrorType: "auth_error",
          },
        }
      );

      assert.equal(state.quotaScope, "credential");
      assert.equal(state.accountState, "auth_failed");
    });
  });

  describe("Test 6: Provider remains healthy while one account is quota_exhausted", () => {
    it("should show healthy provider with quota_exhausted account", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-6",
        "meta-llama/llama-3.1-8b-instruct",
        {
          connection: {
            id: "conn-6",
            provider: "openrouter",
            authType: "oauth",
            testStatus: "active",
            isActive: true,
          },
          isProviderAccountQuotaExhausted: true,
          failureKind: "quota_exhausted",
        }
      );

      // Real circuit breaker is CLOSED for a provider with no recorded failures.
      assert.equal(state.providerHealth, "healthy");
      assert.equal(state.accountState, "quota_exhausted");
      assert.equal(state.quotaState, "quota_exhausted");
    });
  });

  describe("Tests 7-8: provider-account suppression", () => {
    it("removes connection A from every free candidate and keeps healthy B", async () => {
      const { getProviderRuntimeState, filterFreeCandidatesByRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // modelA must be a catalog-proven openrouter free model: costClass is
      // free_tier only for models the curated free-model catalog proves free
      // (":free" suffix alone is no longer sufficient).
      const modelA = "liquid/lfm-2.5-2.6b:free";
      const modelB = "google/gemma-2-9b-it:free";
      seedSafeFreeAccess("openrouter", "conn-B");

      const [stateA, stateB] = await Promise.all([
        getProviderRuntimeState("openrouter", "conn-A", modelA, {
          connection: freeModelsPerDayConnection({ id: "conn-A" }),
        }),
        getProviderRuntimeState("openrouter", "conn-B", modelA, {
          connection: {
            id: "conn-B",
            provider: "openrouter",
            authType: "apikey",
            testStatus: "active",
            isActive: true,
          },
          // openrouter is uncurated in the billing catalog — inject the verdict
          // so the healthy sibling is classified free_tier for the :free model.
          billing: { billing: "metered", overage: "soft", reason: "OpenRouter metered" },
        }),
      ]);

      const candidates = [
        {
          provider: "openrouter",
          connectionId: null,
          allowedConnectionIds: ["conn-A", "conn-B"],
          model: modelA,
        },
        {
          provider: "openrouter",
          connectionId: "conn-A",
          model: modelB,
        },
      ];

      const filtered = filterFreeCandidatesByRuntimeState(candidates, [stateA, stateB]);

      assert.deepEqual(filtered, [
        {
          provider: "openrouter",
          connectionId: null,
          allowedConnectionIds: ["conn-B"],
          model: modelA,
        },
      ]);

      const { isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      assert.equal(stateA.quotaScope, "provider_account");
      assert.equal(stateA.accountState, "quota_exhausted");
      assert.equal(stateB.accountState, "available");
      assert.equal(isFreeCandidateEligible(stateB), true);
      // No per-model lockouts were created for the provider-account event.
      const lockouts = lockModelSeededKeys();
      assert.equal(
        lockouts.some((key) => key.includes("conn-A") && key.includes(modelA)),
        false
      );
      assert.equal(
        lockouts.some((key) => key.includes("conn-A") && key.includes(modelB)),
        false
      );
    });
  });

  describe("Tests 7-8b: pure filter — no spurious suppression", () => {
    function runtimeState(
      overrides: Record<string, unknown>
    ): import("../../open-sse/services/providerRuntimeState.ts").ProviderRuntimeState {
      return {
        providerId: "openrouter",
        connectionId: "conn-A",
        providerHealth: "healthy",
        accountState: "available",
        quotaState: "available",
        quotaScope: "unknown",
        cooldownUntil: null,
        quotaResetAt: null,
        costClass: "free_tier",
        capabilities: {
          executable: null,
          fastEligible: null,
          codingEligible: null,
          genericToolEligible: null,
          claudeCodeEligible: null,
          supervisorEligible: null,
        },
        lastSuccessAt: null,
        lastFailureAt: null,
        failureReason: null,
        latency: { medianMs: null, p95Ms: null },
        computedAtMs: Date.now(),
        ...overrides,
      } as import("../../open-sse/services/providerRuntimeState.ts").ProviderRuntimeState;
    }

    it("passes a connection-less free candidate through untouched (no identity to prove exhausted)", async () => {
      const { filterFreeCandidatesByRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // A free candidate with neither connectionId nor allowedConnectionIds
      // (e.g. a keyless/noauth provider whose sentinel connection id is excluded
      // upstream): the filter has nothing to match it against, so it must be
      // kept verbatim, not dropped.
      const candidates = [
        { provider: "opencode", connectionId: null, model: "some/free-model" },
        { provider: "openrouter", connectionId: "conn-A", model: "x/y:free" },
      ];
      const exhaustedA = runtimeState({
        accountState: "quota_exhausted",
        quotaState: "quota_exhausted",
        quotaScope: "provider_account",
        failureReason: "free-models-per-day",
      });

      const filtered = filterFreeCandidatesByRuntimeState(candidates, [exhaustedA]);
      assert.deepEqual(filtered, [
        { provider: "opencode", connectionId: null, model: "some/free-model" },
      ]);
    });

    it("returns the SAME array reference when nothing is provider-account exhausted (pure, no-op)", async () => {
      const { filterFreeCandidatesByRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const candidates = [{ provider: "openrouter", connectionId: "conn-A", model: "x/y:free" }];
      const filtered = filterFreeCandidatesByRuntimeState(candidates, [runtimeState({})]);
      assert.equal(filtered, candidates, "no exhaustion → original array returned unchanged");
    });
  });

  describe("Test 9: CostClass unknown stays fail-closed", () => {
    it("should return unknown costClass for uncurated providers", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("unknown_provider", "conn-9", "some-model", {
        connection: {
          id: "conn-9",
          provider: "unknown_provider",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
      });

      assert.equal(state.costClass, "unknown");
    });

    it("should not treat unknown as free", async () => {
      const { getProviderRuntimeState, isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("another_unknown", "conn-9b", "some-model", {
        connection: {
          id: "conn-9b",
          provider: "another_unknown",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
      });

      assert.equal(isFreeCandidateEligible(state), false);
    });
  });

  describe("Test 10: Capability states stay independent, unknown=null", () => {
    it("produces fail-closed capabilities; only unproven fields stay null", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-10", "llama-3.1-8b", {
        connection: {
          id: "conn-10",
          provider: "groq",
          authType: null,
          testStatus: "active",
          isActive: true,
        },
      });

      // Groq is catalog-validated (no passthrough) and does not serve
      // llama-3.1-8b → NOT executable (proven false, not unknown).
      assert.equal(state.capabilities.executable, false);
      assert.equal(state.capabilities.fastEligible, null);
      assert.equal(state.capabilities.codingEligible, null);
      assert.equal(state.capabilities.genericToolEligible, null);
      assert.equal(state.capabilities.claudeCodeEligible, null);
      assert.equal(state.capabilities.supervisorEligible, null);
    });

    it("should allow independent capability overrides", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-10b", "llama-3.1-8b", {
        connection: {
          id: "conn-10b",
          provider: "groq",
          authType: null,
          testStatus: "active",
          isActive: true,
        },
        capabilities: { executable: true, fastEligible: true },
      });

      assert.equal(state.capabilities.executable, true);
      assert.equal(state.capabilities.fastEligible, true);
      assert.equal(state.capabilities.codingEligible, null);
      assert.equal(state.capabilities.genericToolEligible, null);
      assert.equal(state.capabilities.claudeCodeEligible, null);
      assert.equal(state.capabilities.supervisorEligible, null);
    });

    it("should not infer capability dependencies", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-10c", "llama-3.1-8b", {
        connection: {
          id: "conn-10c",
          provider: "groq",
          authType: null,
          testStatus: "active",
          isActive: true,
        },
        capabilities: { supervisorEligible: true },
      });

      assert.equal(state.capabilities.supervisorEligible, true);
      assert.equal(state.capabilities.executable, false); // producer verdict, not inferred
      assert.equal(state.capabilities.fastEligible, null);
      assert.equal(state.capabilities.codingEligible, null);
      assert.equal(state.capabilities.genericToolEligible, null);
      assert.equal(state.capabilities.claudeCodeEligible, null);
    });
  });

  describe("CostClass is model-proof driven, not quota/SAFE driven", () => {
    function meteredConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
      return {
        id: "conn-cost",
        provider: "openrouter",
        authType: "apikey",
        testStatus: "active",
        isActive: true,
        ...overrides,
      };
    }

    const METERED = { billing: "metered" as const, overage: "soft" as const, reason: "test" };

    it("does NOT classify a metered paid model as free_tier even with SAFE allowance", async () => {
      const { getProviderRuntimeState, isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // Safe allowance is seeded — previously this alone forced free_tier.
      seedSafeFreeAccess("openrouter", "conn-cost");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-cost",
        "anthropic/claude-3-5-sonnet",
        { connection: meteredConnection(), billing: METERED }
      );

      assert.equal(state.costClass, "paid");
      assert.equal(isFreeCandidateEligible(state), false);
    });

    it("does NOT classify a non-catalog ':free'-suffixed model as free_tier", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // meta-llama/llama-3.1-8b-instruct:free is NOT a curated openrouter
      // catalog entry — the suffix alone must not bypass the catalog.
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-cost",
        "meta-llama/llama-3.1-8b-instruct:free",
        { connection: meteredConnection(), billing: METERED }
      );

      assert.equal(state.costClass, "paid");
    });

    it("keeps unknown model cost unknown/fail-closed even with a ':free' suffix", async () => {
      const { getProviderRuntimeState, isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // Uncurated provider → billing unknown → fail-closed unknown, never free.
      const state = await getProviderRuntimeState(
        "unknown_provider",
        "conn-unknown",
        "some-model:free",
        {
          connection: {
            id: "conn-unknown",
            provider: "unknown_provider",
            authType: "apikey",
            testStatus: "active",
            isActive: true,
          },
        }
      );

      assert.equal(state.costClass, "unknown");
      assert.equal(isFreeCandidateEligible(state), false);
    });

    it("classifies an explicitly catalog-proven free model as free_tier", async () => {
      const { getProviderRuntimeState, isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // liquid/lfm-2.5-2.6b:free is a curated openrouter free-model entry.
      seedSafeFreeAccess("openrouter", "conn-cost");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-cost",
        "liquid/lfm-2.5-2.6b:free",
        { connection: meteredConnection(), billing: METERED }
      );

      assert.equal(state.costClass, "free_tier");
      assert.equal(isFreeCandidateEligible(state), true);
    });

    // O9-F3.3P1-C1: trial != recurring free. A catalog entry whose ONLY free
    // regime is one-time-initial (Cerebras' $5 30-day signup credit) must NOT
    // be classified free_tier here — grantsRecurringFreeAccess excludes it.
    it("does NOT classify a one-time-initial (trial-credit) catalog model as free_tier", async () => {
      const { getProviderRuntimeState, isFreeCandidateEligible } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("cerebras", "conn-cb", "zai-glm-4.7", {
        connection: {
          id: "conn-cb",
          provider: "cerebras",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
        billing: METERED,
      });

      assert.equal(state.costClass, "paid", "one-time-initial is not a sustained free tier");
      assert.equal(isFreeCandidateEligible(state), false);
    });

    // Groq's recurring-daily entries remain free_tier — the C1 change narrows to
    // RECURRING regimes only, it does not drop recurring-* free tiers.
    it("keeps a recurring-daily catalog model (Groq free tier) classified free_tier", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState("groq", "conn-gq", "openai/gpt-oss-120b", {
        connection: {
          id: "conn-gq",
          provider: "groq",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
        billing: METERED,
      });

      assert.equal(state.costClass, "free_tier");
    });

    it("leaves provider-account exhaustion classification unchanged for a catalog-proven free model", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const state = await getProviderRuntimeState(
        "openrouter",
        "conn-exh",
        "liquid/lfm-2.5-2.6b:free",
        {
          connection: freeModelsPerDayConnection({ id: "conn-exh" }),
          billing: METERED,
        }
      );

      // Exhaustion is provider-account scope regardless of the model being free.
      assert.equal(state.costClass, "free_tier");
      assert.equal(state.quotaState, "quota_exhausted");
      assert.equal(state.quotaScope, "provider_account");
      assert.equal(state.accountState, "quota_exhausted");
    });
  });

  describe("Additional edge cases", () => {
    it("should handle missing connection gracefully", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      // No connection injected → the module has no DB read to perform, so the
      // absence of a matching row yields the default unknown state.
      const state = await getProviderRuntimeState("nonexistent", "conn-missing", "model", {
        connection: null,
      });

      assert.equal(state.providerHealth, "unknown");
      assert.equal(state.accountState, "unknown");
      assert.equal(state.quotaState, "unknown");
    });

    it("should compute cooldownUntil as maximum of all cooldown sources", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const futureTime = new Date(Date.now() + 120_000).toISOString();
      const state = await getProviderRuntimeState("openrouter", "conn-cooldown", "model", {
        connection: {
          id: "conn-cooldown",
          provider: "openrouter",
          authType: "oauth",
          testStatus: "active",
          isActive: true,
          rateLimitedUntil: futureTime,
        },
      });

      assert.ok(state.cooldownUntil);
      assert.ok((state.cooldownUntil as number) > Date.now());
    });
  });

  describe("Test 12: quotaResetAt is converted from ISO string to epoch ms", () => {
    it("returns a number, not the raw ISO string, when the free-access cache reports a resetAt", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      const resetAtIso = new Date(Date.now() + 3_600_000).toISOString();
      freeAccessTesting.cache.set("openrouter::conn-reset", {
        state: {
          status: "SAFE",
          remainingFreeAllowance: 10,
          resetAt: resetAtIso,
          checkedAt: new Date().toISOString(),
        },
        fetchedAtMs: Date.now(),
      });

      const state = await getProviderRuntimeState("openrouter", "conn-reset", "model", {
        connection: {
          id: "conn-reset",
          provider: "openrouter",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
      });

      assert.equal(typeof state.quotaResetAt, "number");
      assert.equal(state.quotaResetAt, new Date(resetAtIso).getTime());
    });

    it("stays null when the cache reports no resetAt (fail-closed, not 0/NaN)", async () => {
      const { getProviderRuntimeState } =
        await import("../../open-sse/services/providerRuntimeState.ts");
      freeAccessTesting.cache.set("openrouter::conn-no-reset", {
        state: {
          status: "SAFE",
          remainingFreeAllowance: 10,
          resetAt: null,
          checkedAt: new Date().toISOString(),
        },
        fetchedAtMs: Date.now(),
      });

      const state = await getProviderRuntimeState("openrouter", "conn-no-reset", "model", {
        connection: {
          id: "conn-no-reset",
          provider: "openrouter",
          authType: "apikey",
          testStatus: "active",
          isActive: true,
        },
      });

      assert.equal(state.quotaResetAt, null);
    });
  });
});

// Prove the provider-account event did NOT create per-model lockouts: the
// only lockout seeded across Tests 7-8 is none — this lists every lockout the
// real store holds and asserts conn-A has none for either free model.
function lockModelSeededKeys(): string[] {
  return getAllModelLockouts().map((l) => `${l.provider}::${l.connectionId}::${l.model}`);
}
