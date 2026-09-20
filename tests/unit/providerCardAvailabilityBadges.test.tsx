// @vitest-environment jsdom
/**
 * Provider card availability badges, including the payload shape produced
 * before the catalog join existed.
 *
 * R59 added `discovered`/`untested` to `/api/models/availability`. Gating the
 * whole badge group on `discovered > 0` would have silently removed the
 * quota/blocked badges an operator relies on today for every producer that
 * does not emit the new counters — a regression dressed as a feature. Each
 * badge is therefore gated on its own counter.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProviderCard from "@/app/(dashboard)/dashboard/providers/components/ProviderCard";

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("@/shared/components/ProviderTestSlideOver", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** The counters every producer has always emitted. */
function legacyCounters(overrides: Record<string, number> = {}) {
  return {
    providerId: "openrouter",
    totalChecked: 12,
    available: 9,
    rateLimited: 1,
    quotaExhausted: 2,
    unavailable: 3,
    degraded: 0,
    incompatible: 1,
    blocked: 0,
    ...overrides,
  };
}

function renderCard(modelAvailability: Record<string, unknown> | undefined): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ProviderCard
        providerId="openrouter"
        provider={{ id: "openrouter", name: "OpenRouter", apiType: "chat", serviceKinds: [] }}
        stats={{ total: 1, connected: 1, error: 0, warning: 0, modelAvailability }}
        authType="apikey"
        onToggle={() => {}}
      />
    );
  });
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (!entry) continue;
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
});

describe("ProviderCard availability badges", () => {
  it("keeps quota and blocked badges for a payload without the catalog join", () => {
    const text = renderCard(legacyCounters()).textContent ?? "";
    // quotaExhausted 2 + rateLimited 1, unavailable 3 + incompatible 1.
    expect(text).toContain("3 model quota");
    expect(text).toContain("4 model blocked");
    // Nothing claims models are untested — this payload cannot say.
    expect(text).not.toContain("untested");
  });

  it("shows the untested count when the response does carry it", () => {
    const text = renderCard({ ...legacyCounters(), discovered: 20, untested: 8 }).textContent ?? "";
    expect(text).toContain("8 models untested");
    expect(text).toContain("3 model quota");
  });

  it("does not render a zero-count badge", () => {
    const text =
      renderCard({
        ...legacyCounters({ rateLimited: 0, quotaExhausted: 0, unavailable: 0, incompatible: 0 }),
        discovered: 20,
        untested: 0,
      }).textContent ?? "";
    expect(text).not.toContain("untested");
    expect(text).not.toContain("model quota");
    expect(text).not.toContain("model blocked");
  });

  it("renders no availability badges at all when the provider has no summary", () => {
    const text = renderCard(undefined).textContent ?? "";
    expect(text).not.toContain("untested");
    expect(text).not.toContain("model quota");
    expect(text).not.toContain("model blocked");
  });
});
