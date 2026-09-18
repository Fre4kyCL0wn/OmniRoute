import test from "node:test";
import assert from "node:assert/strict";

import { runClaudeCompatibilityProbe } from "../../src/lib/providerOnboarding/claudeCompatibilityProbe.ts";
import { getCompatibilityProbeContext, runAsProbe } from "../../src/shared/utils/probeOrigin.ts";

const base = {
  providerId: "openrouter",
  connectionId: "conn-or",
  providerModelId: "vendor/free-model:free",
  nowMs: Date.parse("2026-09-15T20:00:00.000Z"),
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("F3.3D probe PASS requires tool_use plus tool_result continuation", async () => {
  const seen: Array<Record<string, unknown>> = [];
  let call = 0;
  const result = await runClaudeCompatibilityProbe(base, {
    pickApiKey: async () => "internal-test-key",
    postMessages: async (request) => {
      assert.deepEqual(getCompatibilityProbeContext(), {
        providerId: "openrouter",
        connectionId: "conn-or",
        providerModelId: "vendor/free-model:free",
      });
      seen.push(await request.json());
      call++;
      if (call === 1) {
        assert.equal(request.headers.get("x-omniroute-connection"), "conn-or");
        assert.equal(request.headers.get("x-internal-test"), "combo-health-check");
        return response({
          content: [
            { type: "tool_use", id: "toolu_probe", name: "jarvis_compat_probe", input: {} },
          ],
          stop_reason: "tool_use",
        });
      }
      return response({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    },
  });
  assert.equal(call, 2);
  assert.equal(result.evidence.state, "PASS");
  assert.equal(result.evidence.failureClass, null);
  assert.equal(result.firstHttpStatus, 200);
  assert.equal(result.secondHttpStatus, 200);
  assert.equal(seen[0].model, "openrouter/vendor/free-model:free");
  const secondMessages = seen[1].messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.length, 3);
});

test("F3.3D probe marks missing tool_use as incompatible", async () => {
  const result = await runClaudeCompatibilityProbe(base, {
    pickApiKey: async () => null,
    postMessages: async () => response({ content: [{ type: "text", text: "I refuse the tool" }] }),
  });
  assert.equal(result.evidence.state, "INCOMPATIBLE");
  assert.equal(result.evidence.failureClass, "tool_protocol");
  assert.equal(result.secondHttpStatus, null);
});

test("F3.3D probe keeps quota and server failures transient", async () => {
  for (const [status, expected] of [
    [429, "rate_limit"],
    [503, "upstream_5xx"],
    [401, "auth"],
  ] as const) {
    const result = await runClaudeCompatibilityProbe(base, {
      pickApiKey: async () => null,
      postMessages: async () => response({ error: { message: "temporary" } }, status),
    });
    assert.equal(result.evidence.state, "TRANSIENT_FAILURE");
    assert.equal(result.evidence.failureClass, expected);
  }
});

test("F3.3D explicit tool-protocol 400 is incompatible but generic 400 stays transient", async () => {
  const incompatible = await runClaudeCompatibilityProbe(base, {
    pickApiKey: async () => null,
    postMessages: async () => response({ error: { message: "tool_choice is not supported" } }, 400),
  });
  assert.equal(incompatible.evidence.state, "INCOMPATIBLE");
  assert.equal(incompatible.evidence.failureClass, "tool_protocol");

  const generic = await runClaudeCompatibilityProbe(base, {
    pickApiKey: async () => null,
    postMessages: async () => response({ error: { message: "bad request" } }, 400),
  });
  assert.equal(generic.evidence.state, "TRANSIENT_FAILURE");
  assert.equal(generic.evidence.failureClass, "anthropic_translation");
});

test("F3.3D generic probe context cannot impersonate a compatibility probe", async () => {
  await runAsProbe(async () => {
    assert.equal(getCompatibilityProbeContext(), null);
  });
  assert.equal(getCompatibilityProbeContext(), null);
});
