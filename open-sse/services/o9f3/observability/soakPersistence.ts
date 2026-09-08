import {
  addRequestEntry,
  ActiveSoakWindow,
  assertRequestInActiveWindow,
  SoakRequestEntry,
  SoakState,
} from "./soakState";

export interface AtomicSoakStore {
  load(): SoakState;
  save(next: SoakState): void;
}

export function assertSanitizedRequestEntry(entry: SoakRequestEntry): void {
  const raw = entry as unknown as Record<string, unknown>;
  for (const key of [
    "prompt",
    "messages",
    "content",
    "credential",
    "credentials",
    "authorization",
  ]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`F3_2_UNSANITIZED_REQUEST_EVIDENCE:${key}`);
    }
  }
}

export function persistWindowRequest(
  store: AtomicSoakStore,
  active: ActiveSoakWindow | null,
  entry: SoakRequestEntry
): SoakState {
  assertRequestInActiveWindow(active, entry);
  assertSanitizedRequestEntry(entry);

  const current = store.load();
  const next = addRequestEntry(current, entry);
  store.save(next);
  return next;
}
