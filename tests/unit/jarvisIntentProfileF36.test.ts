import test from "node:test";
import assert from "node:assert/strict";

import {
  detectJarvisModalities,
  extractJarvisIntentText,
  resolveJarvisIntentRoute,
} from "../../src/lib/failover/jarvisIntentProfile.ts";

test("F3.6 ignores non-Jarvis routes", () => {
  assert.equal(resolveJarvisIntentRoute("auto/chat:free", { messages: [] }), null);
});

test("F3.6 keeps tool-bearing requests on the compatibility-gated managed pool", () => {
  const d = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "summarize this" }],
    tools: [{ name: "read" }],
  });
  assert.equal(d?.routeModel, "jarvis-auto");
  assert.equal(d?.profile, "managed-coding");
  assert.ok(d?.reasons.includes("tool-compatibility-managed-pool"));
});

test("F3.6 keeps coding intent on the managed pool even without tools", () => {
  const d = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "debug this TypeScript function" }],
  });
  assert.equal(d?.routeModel, "jarvis-auto");
  assert.equal(d?.profile, "managed-coding");
});

test("F3.6 sends reasoning and math to the dynamic strict-free reasoning pool", () => {
  const r = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "reason step by step and prove the theorem" }],
  });
  assert.equal(r?.routeModel, "auto/reasoning:free");
  const m = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "calculate the integral of x squared" }],
  });
  assert.equal(m?.routeModel, "auto/reasoning:free");
});

test("F3.6 explicit high reasoning effort selects reasoning even for neutral text", () => {
  const d = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "consider the options" }],
    reasoning_effort: "high",
  });
  assert.equal(d?.routeModel, "auto/reasoning:free");
});

test("F3.6 routes image and mixed-media inputs to capability-filtered free pools", () => {
  const visionBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      },
    ],
  };
  assert.deepEqual(detectJarvisModalities(visionBody), ["image"]);
  assert.equal(resolveJarvisIntentRoute("jarvis-auto", visionBody)?.routeModel, "auto/vision:free");
  const multiBody = {
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "x" },
          { type: "input_audio", audio: "y" },
        ],
      },
    ],
  };
  assert.equal(
    resolveJarvisIntentRoute("jarvis-auto", multiBody)?.routeModel,
    "auto/multimodal:free"
  );
});

test("F3.6 general tool-free chat uses the dynamic strict-free chat pool", () => {
  const d = resolveJarvisIntentRoute("jarvis-auto", {
    messages: [{ role: "user", content: "Hello, how are you?" }],
  });
  assert.equal(d?.routeModel, "auto/chat:free");
  assert.equal(d?.profile, "chat");
});

test("F3.6 extracts text from Anthropic/OpenAI content arrays", () => {
  assert.equal(
    extractJarvisIntentText({
      messages: [
        {
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      ],
    }),
    "one\ntwo"
  );
});
