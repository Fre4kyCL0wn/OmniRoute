import test from "node:test";
import assert from "node:assert/strict";
import {
  observeConnectionBillingSafety,
  type ConnectionBillingObservationDeps,
} from "../../src/lib/failover/connectionBillingObservation.ts";

const OPENROUTER = {
  connectionId: "or-1",
  provider: "openrouter",
  isActive: true,
};

function deps(quota: Record<string, unknown> | null): ConnectionBillingObservationDeps {
  return {
    loadProviderConnections: async () => [
      { id: "or-1", provider: "openrouter", isActive: true, apiKey: "not-printed" },
    ],
    fetchOpenrouterQuota: async () => quota,
    now: () => "2026-09-14T10:00:00.000Z",
  };
}

test("R4.5 billing: OpenRouter free-tier signal yields provider-observed safe evidence", async () => {
  const out = await observeConnectionBillingSafety(OPENROUTER, deps({ isFreeTier: true }));
  assert.equal(out.status, "observed");
  assert.equal(out.basis, "openrouter-free-tier");
  assert.deepEqual(out.evidence, {
    billingLinked: false,
    origin: "provider-observed",
    observedAt: "2026-09-14T10:00:00.000Z",
  });
});

test("R4.5 billing: OpenRouter paid-tier signal yields explicit unsafe evidence", async () => {
  const out = await observeConnectionBillingSafety(OPENROUTER, deps({ isFreeTier: false }));
  assert.equal(out.status, "observed");
  assert.equal(out.basis, "openrouter-paid-tier");
  assert.deepEqual(out.evidence, {
    billingLinked: true,
    origin: "provider-observed",
    observedAt: "2026-09-14T10:00:00.000Z",
  });
});

test("R4.5 billing: missing free-tier signal fails closed", async () => {
  const out = await observeConnectionBillingSafety(OPENROUTER, deps({ usageDaily: 0 }));
  assert.equal(out.status, "unavailable");
  assert.equal(out.evidence, null);
  assert.equal(out.basis, "free-tier-signal-unavailable");
});
test("R4.5 billing: unsupported providers remain unknown without probing", async () => {
  let probes = 0;
  const out = await observeConnectionBillingSafety(
    { connectionId: "g-1", provider: "groq", isActive: true },
    {
      ...deps({ isFreeTier: true }),
      fetchOpenrouterQuota: async () => {
        probes += 1;
        return { isFreeTier: true };
      },
    }
  );
  assert.equal(out.status, "unsupported");
  assert.equal(out.evidence, null);
  assert.equal(probes, 0);
});

test("R4.5 billing: inactive connections are never probed", async () => {
  const out = await observeConnectionBillingSafety(
    { ...OPENROUTER, isActive: false },
    deps({ isFreeTier: true })
  );
  assert.equal(out.status, "inactive");
  assert.equal(out.evidence, null);
});
