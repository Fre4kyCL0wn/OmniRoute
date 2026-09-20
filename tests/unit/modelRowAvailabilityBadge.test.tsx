// @vitest-environment jsdom
/**
 * Model rows must never label a model UNTESTED while the inventory fetch is
 * still in flight.
 *
 * "Untested" is an instruction to the operator: it means "nobody has probed
 * this, go press ▶". Rendering it during the first paint invites re-testing
 * models that are already known-good and makes a slow or failing availability
 * API indistinguishable from an empty inventory. The distinction lives in two
 * places and both are covered here: `resolveRowAvailabilityStatus` (which
 * decides the value) and the rows themselves (which decide the words).
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import ModelRow from "@/app/(dashboard)/dashboard/providers/[id]/components/ModelRow";
import PassthroughModelRow from "@/app/(dashboard)/dashboard/providers/[id]/components/PassthroughModelRow";
import {
  resolveRowAvailabilityStatus,
  type ModelRowAvailabilityStatus,
} from "@/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/**
 * A translator without `.has` — `providerText` then renders its English
 * fallback, which is exactly the string the operator sees for a locale that
 * has not been translated yet.
 */
const t = (key: string) => key;

const sharedProps = {
  provider: "openrouter",
  t,
  onCopy: () => {},
  effectiveModelNormalize: () => false,
  effectiveModelPreserveDeveloper: () => false,
  saveModelCompatFlags: () => {},
  getUpstreamHeadersRecord: () => ({}),
};

function renderRow(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted.push({ root, container });
  return container;
}

function renderModelRow(testStatus?: ModelRowAvailabilityStatus | null): HTMLElement {
  return renderRow(
    <ModelRow
      {...sharedProps}
      model={{ id: "alpha:free", source: "system" }}
      fullModel="openrouter/alpha:free"
      testStatus={testStatus}
    />
  );
}

function renderPassthroughRow(testStatus?: ModelRowAvailabilityStatus | null): HTMLElement {
  return renderRow(
    <PassthroughModelRow
      {...sharedProps}
      modelId="alpha:free"
      fullModel="openrouter/alpha:free"
      testStatus={testStatus}
    />
  );
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

describe("resolveRowAvailabilityStatus", () => {
  it("never reports loading once real evidence exists", () => {
    // A model whose probe already landed keeps its verdict even if a later
    // refresh is in flight — the row would otherwise flicker green → grey.
    expect(resolveRowAvailabilityStatus("ok", true)).toBe("ok");
    expect(resolveRowAvailabilityStatus("quota", true)).toBe("quota");
    expect(resolveRowAvailabilityStatus("error", true)).toBe("error");
  });

  it("separates 'not yet known' from 'known to be untested'", () => {
    expect(resolveRowAvailabilityStatus(undefined, true)).toBe("loading");
    expect(resolveRowAvailabilityStatus(null, true)).toBe("loading");
    expect(resolveRowAvailabilityStatus(undefined, false)).toBe("unknown");
    expect(resolveRowAvailabilityStatus(null, false)).toBe("unknown");
  });

  it("degrades to the historical behavior for a caller that does not track the fetch", () => {
    // Sections that never pass `loading` must keep rendering exactly as before
    // rather than becoming permanently "checking…".
    expect(resolveRowAvailabilityStatus(undefined)).toBe("unknown");
    expect(resolveRowAvailabilityStatus("ok")).toBe("ok");
  });

  it("always resolves to a renderable state", () => {
    // Every discovered model gets a visible chip; there is no input for which
    // the row falls back to "no badge at all".
    const inputs = ["ok", "error", "quota", null, undefined] as const;
    for (const loading of [true, false]) {
      for (const status of inputs) {
        expect(resolveRowAvailabilityStatus(status, loading)).toBeTruthy();
      }
    }
  });
});

describe("ModelRow availability chip", () => {
  it("says checking, not untested, while the inventory fetch is open", () => {
    const container = renderModelRow("loading");
    expect(container.textContent).toContain("checking…");
    expect(container.textContent).not.toContain("untested");
  });

  it("says untested only once the fetch has settled with no evidence", () => {
    const container = renderModelRow("unknown");
    expect(container.textContent).toContain("untested");
    expect(container.textContent).not.toContain("checking…");
  });

  it("keeps the explicit verdicts distinct", () => {
    expect(renderModelRow("ok").textContent).toContain("available");
    expect(renderModelRow("quota").textContent).toContain("quota");
    expect(renderModelRow("error").textContent).toContain("blocked");
  });

  it("colours only a real verdict, so grey means 'no answer yet'", () => {
    const badgeOf = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("span")).find((span) =>
        /available|quota|blocked|checking|untested/.test(span.textContent ?? "")
      );

    const loading = badgeOf(renderModelRow("loading"));
    const untested = badgeOf(renderModelRow("unknown"));
    expect(loading?.className).toContain("text-text-muted");
    expect(untested?.className).toContain("text-text-muted");
    expect(badgeOf(renderModelRow("ok"))?.className).toContain("text-green-500");
    expect(badgeOf(renderModelRow("quota"))?.className).toContain("text-amber-500");
    expect(badgeOf(renderModelRow("error"))?.className).toContain("text-red-500");
  });

  it("renders no chip at all when the section passes nothing", () => {
    // The guard that makes this safe is `resolveRowAvailabilityStatus` above:
    // it never returns null, so a section wired through it always yields a
    // chip. A bare `undefined` here documents the un-wired legacy shape.
    expect(renderModelRow(undefined).textContent).not.toContain("untested");
    expect(renderModelRow(null).textContent).not.toContain("untested");
  });

  it("lets a long model id give way instead of pushing the chip off the card", () => {
    const container = renderModelRow("unknown");
    const code = container.querySelector("code");
    expect(code?.className).toContain("truncate");
    expect(code?.className).toContain("min-w-0");
    // Full id still reachable even when visually clipped.
    expect(code?.getAttribute("title")).toBe("openrouter/alpha:free");
  });
});

describe("PassthroughModelRow availability chip", () => {
  it("says checking, not untested, while the inventory fetch is open", () => {
    const container = renderPassthroughRow("loading");
    expect(container.textContent).toContain("checking…");
    expect(container.textContent).not.toContain("untested");
  });

  it("always shows a state, defaulting to untested when nothing is known", () => {
    // Unlike ModelRow this chip is not gated on a status being passed, so a
    // passthrough model can never appear with no availability information.
    expect(renderPassthroughRow("unknown").textContent).toContain("untested");
    expect(renderPassthroughRow(undefined).textContent).toContain("untested");
  });

  it("keeps the explicit verdicts distinct", () => {
    expect(renderPassthroughRow("ok").textContent).toContain("available");
    expect(renderPassthroughRow("quota").textContent).toContain("quota");
    expect(renderPassthroughRow("error").textContent).toContain("blocked");
  });
});
