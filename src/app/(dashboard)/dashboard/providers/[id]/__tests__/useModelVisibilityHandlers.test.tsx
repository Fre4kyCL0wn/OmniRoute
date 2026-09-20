// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useModelVisibilityHandlers,
  type UseModelVisibilityHandlersParams,
  type UseModelVisibilityHandlersReturn,
} from "../hooks/useModelVisibilityHandlers";

type HookResult = UseModelVisibilityHandlersReturn;

const t = ((key: string) => key) as ((key: string) => string) & {
  has: (key: string) => boolean;
};
t.has = () => false;

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const baseProps = {
  providerId: "anthropic-compatible-cc-test",
  modelAliases: {},
  customMap: new Map<string, unknown>(),
  providerStorageAlias: "anthropic-compatible-cc-test",
  fetchProviderModelMeta: vi.fn().mockResolvedValue(undefined),
  fetchAliases: vi.fn().mockResolvedValue(undefined),
  notify,
  t,
  selectedConnection: { id: "conn-1", provider: "anthropic-compatible-cc-test" },
  providerNode: { id: "anthropic-compatible-cc-test" },
};

function renderHook(overrides: Partial<UseModelVisibilityHandlersParams> = {}): {
  get: () => HookResult;
} {
  let latestResult: HookResult | null = null;
  const props: UseModelVisibilityHandlersParams = { ...baseProps, ...overrides };

  function Wrapper() {
    const result = useModelVisibilityHandlers(props);
    React.useEffect(() => {
      latestResult = result;
    });
    return null;
  }

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);

  act(() => {
    root.render(<Wrapper />);
  });

  roots.push({ root, el });

  return {
    get: () => {
      if (!latestResult) throw new Error("Hook did not render");
      return latestResult;
    },
  };
}

const roots: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ inventory: null }),
    } as Response)
  );
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("useModelVisibilityHandlers", () => {
  it("defaults auto-hide failed models to off", () => {
    const hook = renderHook();

    expect(hook.get().autoHideFailed).toBe(false);
    expect(hook.get().visibilityFilter).toBe("visible");
  });

  it("aggregates persisted provider availability when no connection is selected", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/models/availability")) {
        expect(url).toBe("/api/models/availability?providerId=codex");
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              providerId: "codex",
              inventories: [
                {
                  models: {
                    "gpt-5.6-sol": { state: "degraded" },
                    "gpt-5.6-terra": { state: "quota_exhausted" },
                    "gpt-5.6-luna": { state: "unavailable" },
                  },
                },
                {
                  models: {
                    "gpt-5.6-sol": { state: "available" },
                  },
                },
              ],
            }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const hook = renderHook({
      providerId: "codex",
      providerStorageAlias: "cx",
      selectedConnection: null,
      providerNode: { id: "codex" },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.get().modelAvailabilityLoading).toBe(false);
    expect(hook.get().modelTestStatus["gpt-5.6-sol"]).toBe("ok");
    expect(hook.get().modelTestStatus["gpt-5.6-terra"]).toBe("quota");
    expect(hook.get().modelTestStatus["gpt-5.6-luna"]).toBe("error");
  });

  it("does not hide a model when a single-model test fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/models/availability")) {
        return {
          ok: true,
          json: () => Promise.resolve({ inventory: null }),
        } as Response;
      }
      if (url === "/api/models/test") {
        return {
          ok: false,
          json: () =>
            Promise.resolve({
              status: "error",
              error: "model unavailable",
              availabilityState: "unavailable",
            }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const hook = renderHook();

    await act(async () => {
      await hook
        .get()
        .onTestModel("claude-opus-4-8", "anthropic-compatible-cc-test/claude-opus-4-8");
    });

    const modelTestCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/models/test");
    expect(modelTestCall).toBeDefined();
    expect(modelTestCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/models/availability"))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/provider-models"))
    ).toBe(false);
    expect(hook.get().modelTestStatus["claude-opus-4-8"]).toBe("error");
  });
});
