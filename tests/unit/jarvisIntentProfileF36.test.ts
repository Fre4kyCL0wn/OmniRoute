import test from "node:test";
import assert from "node:assert/strict";

import {
  detectJarvisModalities,
  detectJarvisToolSignals,
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
          { type: "input_audio", input_audio: { data: "y", format: "wav" } },
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

test("F3.6 recognizes legacy, wrapped and forced tool declarations", () => {
  for (const body of [
    { functions: [{ name: "legacy" }], messages: [{ role: "user", content: "hello" }] },
    { request: { tools: [{ name: "wrapped" }] }, messages: [{ role: "user", content: "hello" }] },
    {
      tool_choice: { type: "tool", name: "forced" },
      messages: [{ role: "user", content: "hello" }],
    },
    { additional_tools: [{ type: "namespace", tools: [{ name: "extra" }] }], input: "hello" },
  ]) {
    const signals = detectJarvisToolSignals(body);
    assert.equal(signals.requiresCompatibility, true);
    assert.equal(resolveJarvisIntentRoute("jarvis-auto", body)?.routeModel, "jarvis-auto");
  }
});

test("F3.6 treats tool protocol history as compatibility-sensitive even without declarations", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };
  const signals = detectJarvisToolSignals(body);
  assert.equal(signals.requiresCompatibility, true);
  assert.ok(signals.reasons.includes("tool-protocol-history"));
  assert.equal(resolveJarvisIntentRoute("jarvis-auto", body)?.profile, "managed-coding");
});

test("F3.6 does not invent tool requirements from tool_choice none or auto", () => {
  for (const tool_choice of ["none", "auto", { type: "auto" }]) {
    const body = { tool_choice, messages: [{ role: "user", content: "Hello there" }] };
    assert.equal(detectJarvisToolSignals(body).requiresCompatibility, false);
    assert.equal(resolveJarvisIntentRoute("jarvis-auto", body)?.routeModel, "auto/chat:free");
  }
});

test("F3.6 uses the unified structured media detector and ignores arbitrary image keys", () => {
  const falsePositive = {
    messages: [{ role: "user", content: [{ type: "text", text: "hello", image: "not-media" }] }],
  };
  assert.deepEqual(detectJarvisModalities(falsePositive), []);
  assert.equal(
    resolveJarvisIntentRoute("jarvis-auto", falsePositive)?.routeModel,
    "auto/chat:free"
  );

  const anthropicImage = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
    ],
  };
  assert.deepEqual(detectJarvisModalities(anthropicImage), ["image"]);
  assert.equal(
    resolveJarvisIntentRoute("jarvis-auto", anthropicImage)?.routeModel,
    "auto/vision:free"
  );
});

test("F3.6 routes audio-only and video-only requests to multimodal free", () => {
  const audio = {
    input: [{ type: "input_audio", input_audio: { data: "abc", format: "wav" } }],
  };
  assert.deepEqual(detectJarvisModalities(audio), ["audio"]);
  assert.equal(resolveJarvisIntentRoute("jarvis-auto", audio)?.routeModel, "auto/multimodal:free");

  const video = {
    messages: [
      { role: "user", content: [{ type: "video_url", video_url: { url: "https://x/v.mp4" } }] },
    ],
  };
  assert.deepEqual(detectJarvisModalities(video), ["video"]);
  assert.equal(resolveJarvisIntentRoute("jarvis-auto", video)?.routeModel, "auto/multimodal:free");
});

test("F3.6 tool-bearing media stays on managed compatibility pool", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/i.png" } }] },
    ],
    tools: [{ name: "inspect" }],
  };
  const d = resolveJarvisIntentRoute("jarvis-auto", body);
  assert.equal(d?.profile, "managed-coding");
  assert.equal(d?.routeModel, "jarvis-auto");
  assert.deepEqual(d?.modalities, ["image"]);
});
