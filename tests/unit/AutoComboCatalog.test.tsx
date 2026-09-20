// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values && typeof values.count !== "undefined") return `${values.count} ${key}`;
    if (values && typeof values.name !== "undefined") return `${String(values.name)} ${key}`;
    return key;
  },
}));

const payload = {
  combos: [
    {
      id: "auto/chat:free",
      name: "Auto Chat Free",
      candidateCount: 2,
      candidatePool: ["openrouter"],
      providerCount: 1,
      active: true,
      management: "auto",
      candidates: [
        { providerId: "openrouter", model: "openrouter/alpha:free" },
        { providerId: "openrouter", model: "openrouter/beta:free" },
      ],
    },
    {
      id: "auto/vision",
      name: "Auto Vision",
      candidateCount: 0,
      candidatePool: [],
      providerCount: 0,
      active: false,
      management: "auto",
      candidates: [],
    },
  ],
};

const cleanupCallbacks: Array<() => void> = [];
let AutoComboCatalog: React.ComponentType<{ onComboCreated?: (comboId: string) => void }>;
let normalizeLiveAutoCombos: typeof import("@/app/(dashboard)/dashboard/combos/AutoComboCatalog").normalizeLiveAutoCombos;
let normalizeEmptyPoolSignals: typeof import("@/app/(dashboard)/dashboard/combos/AutoComboCatalog").normalizeEmptyPoolSignals;

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  return container;
}

/**
 * Poll until an assertion holds instead of counting microtask turns.
 *
 * The component's load is `fetch → async then → then → finally`, so the number
 * of turns needed to observe the rendered result depends on how many awaits the
 * implementation happens to contain — a fixed `await Promise.resolve()` count
 * is green until someone adds one. Each attempt runs inside `act` so React
 * flushes its work and no update escapes the act environment.
 */
async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) throw lastError;
    }
  }
}

async function renderCatalog(props: { onComboCreated?: (comboId: string) => void } = {}) {
  const container = makeContainer();
  const root = createRoot(container);
  await act(async () => root.render(<AutoComboCatalog {...props} />));
  return container;
}

describe("AutoComboCatalog", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    ({
      default: AutoComboCatalog,
      normalizeLiveAutoCombos,
      normalizeEmptyPoolSignals,
    } = await import("@/app/(dashboard)/dashboard/combos/AutoComboCatalog"));
  }, 180_000);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
    document.body.innerHTML = "";
  });

  it("loads the live auto-route catalog instead of the static 17-template snapshot", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("2 autoCatalogLiveRouteCount");
    });
    expect(container.textContent).toContain("auto/chat:free");
    expect(container.textContent).toContain("auto/vision");
  });

  it("reads the live catalog endpoint without caching it", async () => {
    await renderCatalog();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/combos/auto");
    expect(init).toMatchObject({ cache: "no-store" });
    // A stale live panel is worse than a slow one: the route state it renders
    // is the whole point of the panel.
    expect(init.signal).toBeDefined();
  });

  it("is expanded by default and marks live routes as auto-managed", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("autoCatalogRouteActive");
    });
    expect(container.textContent).toContain("autoCatalogRouteInactive");
    expect(container.textContent).toContain("openrouter/alpha:free");
  });

  it("reports models and providers as separate counts", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("2 autoCatalogCandidateCount");
    });
    expect(container.textContent).toContain("1 autoCatalogProviderCount");
  });

  it("can collapse the live route list", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("auto/chat:free");
    });
    const toggle = container.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("auto/chat:free");
  });

  it("does not call the expensive materialization endpoint while collapsed", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const toggle = container.querySelector("button");
    await act(async () => toggle?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows the load-failure banner instead of an empty catalog when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("autoCatalogLoadFailed");
    });
    // The "no routes at all" banner must not also fire — the two states have
    // opposite operator responses (retry vs connect a provider).
    expect(container.textContent).not.toContain("autoCatalogEmpty");
  });

  it("shows the empty banner when the router materializes no routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ combos: [] }) })
    );
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("autoCatalogEmpty");
    });
  });

  it("surfaces empty-pool signals so a fail-closed free tier is visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          combos: payload.combos,
          emptyPoolSignals: [
            {
              label: "auto/free-verified",
              message: "no models with persisted AVAILABLE evidence",
              firstSeenAt: "2026-09-20T00:00:00.000Z",
              lastSeenAt: "2026-09-20T01:00:00.000Z",
              occurrences: 12,
            },
          ],
        }),
      })
    );
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("autoCatalogEmptyPoolSignalsTitle");
    });
    expect(container.textContent).toContain("auto/free-verified");
    expect(container.textContent).toContain("no models with persisted AVAILABLE evidence");
  });

  it("disables duplication for a route with no candidates", async () => {
    const container = await renderCatalog();
    await waitFor(() => {
      expect(container.textContent).toContain("auto/vision");
    });
    const duplicateButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.getAttribute("title")?.includes("duplicateAutoComboTitle")
    );
    expect(duplicateButtons).toHaveLength(2);
    const byTitle = new Map(
      duplicateButtons.map((button) => [button.getAttribute("title") ?? "", button])
    );
    expect(byTitle.get("auto/chat:free duplicateAutoComboTitle")?.disabled).toBe(false);
    expect(byTitle.get("auto/vision duplicateAutoComboTitle")?.disabled).toBe(true);
  });

  it("posts the live route id — not a static template name — when duplicating", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/combos/duplicate")) {
        return { ok: true, json: async () => ({ id: "combo-1" }) };
      }
      return { ok: true, json: async () => payload };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("alert", () => undefined);
    const onComboCreated = vi.fn();
    const container = await renderCatalog({ onComboCreated });
    await waitFor(() => {
      expect(container.textContent).toContain("auto/chat:free");
    });
    const duplicate = [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("title")?.startsWith("auto/chat:free")
    );
    await act(async () => duplicate?.click());
    await waitFor(() => {
      expect(onComboCreated).toHaveBeenCalledWith("combo-1");
    });
    const duplicateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/combos/duplicate")
    );
    expect(duplicateCall).toBeDefined();
    // `auto/chat:free` is a suffix composition, not one of the 17 static
    // templates — the id the panel displays is the id the server must resolve.
    expect(JSON.parse(duplicateCall![1].body)).toMatchObject({
      name: "auto/chat:free",
      strategy: "priority",
    });
    // The snapshot changes what exists; the panel re-reads instead of going stale.
    const autoCalls = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/combos/auto");
    expect(autoCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("normalizeLiveAutoCombos", () => {
  beforeAll(async () => {
    ({ normalizeLiveAutoCombos, normalizeEmptyPoolSignals } =
      await import("@/app/(dashboard)/dashboard/combos/AutoComboCatalog"));
  }, 180_000);

  it("collapses duplicate ids first-wins so React keys stay unique", () => {
    const result = normalizeLiveAutoCombos({
      combos: [
        { id: "auto/coding", name: "first", candidateCount: 3 },
        { id: "auto/coding", name: "second", candidateCount: 9 },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("first");
  });

  it("drops unrenderable entries and sorts deterministically", () => {
    const result = normalizeLiveAutoCombos({
      combos: [
        { id: "auto/zeta", name: "z", candidateCount: 1 },
        { id: "   ", name: "blank", candidateCount: 1 },
        null as never,
        { id: "auto/alpha", name: "a", candidateCount: 1 },
      ],
    });
    expect(result.map((combo) => combo.id)).toEqual(["auto/alpha", "auto/zeta"]);
  });

  it("treats a missing or malformed payload as no routes", () => {
    expect(normalizeLiveAutoCombos(undefined)).toEqual([]);
    expect(normalizeLiveAutoCombos({} as never)).toEqual([]);
    expect(normalizeLiveAutoCombos({ combos: "nope" } as never)).toEqual([]);
  });

  it("keeps only empty-pool signals that can be rendered", () => {
    expect(
      normalizeEmptyPoolSignals({
        combos: [],
        emptyPoolSignals: [
          { label: "auto/free-verified", message: "m", lastSeenAt: "x", occurrences: 1 },
          { label: 7, message: "m", lastSeenAt: "x", occurrences: 1 } as never,
          { label: "auto/x" } as never,
        ],
      })
    ).toHaveLength(1);
    expect(normalizeEmptyPoolSignals(undefined)).toEqual([]);
  });
});
