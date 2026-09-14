import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-fusion-tool-failover-"));
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "fusion-tool-failover-test-secret";

const { handleFusionChat } = await import("../../open-sse/services/fusion.ts");

type Body = Record<string, unknown>;
const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };
const TOOLS = [{ type: "function", function: { name: "read_file", parameters: {} } }];

function ok(model: string): Response {
  return new Response(JSON.stringify({ model, content: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("tool-bearing fusion falls through 429 to next unique target without mutating body", async () => {
  const requestBody: Body = {
    messages: [{ role: "user", content: "inspect file" }],
    tools: TOOLS,
    tool_choice: "auto",
    stream: true,
  };
  const calls: Array<{ model: string; body: Body }> = [];
  const res = await handleFusionChat({
    body: requestBody,
    models: ["panel/a", "panel/b"],
    judgeModel: "panel/a",
    handleSingleModel: async (body, model) => {
      calls.push({ model, body });
      return model === "panel/a" ? new Response("rate limited", { status: 429 }) : ok(model);
    },
    log,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    calls.map((c) => c.model),
    ["panel/a", "panel/b"]
  );
  assert.strictEqual(calls[0].body, requestBody);
  assert.strictEqual(calls[1].body, requestBody);
  assert.deepEqual(calls[1].body.tools, TOOLS);
  assert.equal(calls[1].body.tool_choice, "auto");
});

test("tool-bearing fusion does not duplicate an explicit judge already present in panel", async () => {
  const calls: string[] = [];
  const res = await handleFusionChat({
    body: { messages: [{ role: "user", content: "use tool" }], tools: TOOLS },
    models: ["panel/a", "panel/b"],
    judgeModel: "panel/a",
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      return new Response("retry", { status: 503 });
    },
    log,
  });

  assert.equal(res.status, 503);
  assert.deepEqual(calls, ["panel/a", "panel/b"]);
});

test("tool-bearing fusion treats explicit model-unavailable 400 as target-local and falls through", async () => {
  const calls: string[] = [];
  const handleSingleModel = async (_body: Body, model: string) => {
    calls.push(model);
    if (model === "model/a") {
      return new Response("Error from provider: Upstream request failed: Model is unavailable.", {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const res = await handleFusionChat({
    body: { messages: [{ role: "user", content: "hi" }], tools: TOOLS },
    models: ["model/a", "model/b"],
    handleSingleModel,
    log,
    comboName: "free",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["model/a", "model/b"]);
});

test("tool-bearing fusion stops on non-retryable 400", async () => {
  const calls: string[] = [];
  const res = await handleFusionChat({
    body: { messages: [{ role: "user", content: "bad" }], tools: TOOLS },
    models: ["panel/a", "panel/b"],
    judgeModel: "panel/a",
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      return new Response("bad request", { status: 400 });
    },
    log,
  });

  assert.equal(res.status, 400);
  assert.deepEqual(calls, ["panel/a"]);
});
