import { describe, expect, it } from "vitest";
import {
  applyFreeModelLifecycleEvent,
  createFreeModelLifecycleRecord,
  isReprobeDue,
} from "../freeModelLifecycle";

const now = new Date("2026-09-09T00:00:00.000Z");

describe("free model lifecycle", () => {
  it("promotes candidate to verified and preferred only after benchmark pass", () => {
    let record = createFreeModelLifecycleRecord(now);
    record = applyFreeModelLifecycleEvent(record, "metadata_verified_free", { now });
    expect(record.state).toBe("verified");
    record = applyFreeModelLifecycleEvent(record, "preferred_selected", { now });
    expect(record.state).toBe("verified");
    record = applyFreeModelLifecycleEvent(record, "benchmark_passed", { now });
    record = applyFreeModelLifecycleEvent(record, "preferred_selected", { now });
    expect(record.state).toBe("preferred");
  });

  it("demotes repeated failures to cooldown and schedules reprobe", () => {
    let record = { ...createFreeModelLifecycleRecord(now), state: "verified" as const };
    record = applyFreeModelLifecycleEvent(record, "timeout", { now, failureThreshold: 2 });
    expect(record.state).toBe("degraded");
    record = applyFreeModelLifecycleEvent(record, "malformed_tool_call", {
      now,
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    expect(record.state).toBe("cooldown");
    expect(record.cooldownUntil).toBe("2026-09-09T00:00:01.000Z");
    expect(record.reprobeAfter).toBe(record.cooldownUntil);
  });

  it("uses bounded reprobe for recovery", () => {
    let record = { ...createFreeModelLifecycleRecord(now), state: "cooldown" as const };
    record = applyFreeModelLifecycleEvent(record, "cooldown_elapsed", { now });
    expect(record.state).toBe("degraded");
    expect(isReprobeDue(record, now)).toBe(true);
    record = applyFreeModelLifecycleEvent(record, "reprobe_passed", { now });
    expect(record.state).toBe("candidate");
    expect(record.failureCount).toBe(0);
  });

  it("marks classifier incompatibility separately", () => {
    const record = applyFreeModelLifecycleEvent(
      createFreeModelLifecycleRecord(now),
      "classifier_incompatible",
      {
        now,
      }
    );
    expect(record.state).toBe("incompatible");
    expect(record.reprobeAfter).toBeTruthy();
  });
});
