import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveEffectiveParamFilter,
  type ProviderParamFilter,
} from "../../src/lib/db/paramFilters.ts";

function config(overrides: Partial<ProviderParamFilter> = {}): ProviderParamFilter {
  return {
    block: [],
    allow: [],
    autoLearn: false,
    ...overrides,
  };
}

test("effective param policy follows provider/model block-allow precedence", () => {
  const result = resolveEffectiveParamFilter(
    config({
      block: ["thinking", "temperature"],
      allow: ["temperature"],
      models: {
        "model-a": {
          block: ["tools", "temperature"],
          allow: ["thinking", "tools"],
        },
      },
    }),
    "model-a"
  );

  assert.deepEqual(result.blocked.sort(), ["temperature"]);
  assert.deepEqual(result.allowed.sort(), ["thinking", "tools"]);
});

test("effective param policy normalizes keys for routing comparisons", () => {
  const result = resolveEffectiveParamFilter(
    config({
      block: [" Reasoning_Effort ", "TOOLS"],
      models: { "model-b": { allow: ["tools"] } },
    }),
    "model-b"
  );

  assert.deepEqual(result.blocked, ["reasoning_effort"]);
  assert.deepEqual(result.allowed, ["tools"]);
});

test("model-specific policy does not leak to sibling models", () => {
  const cfg = config({
    models: { "model-a": { block: ["tools"] } },
  });

  assert.deepEqual(resolveEffectiveParamFilter(cfg, "model-a").blocked, ["tools"]);
  assert.deepEqual(resolveEffectiveParamFilter(cfg, "model-b").blocked, []);
});
