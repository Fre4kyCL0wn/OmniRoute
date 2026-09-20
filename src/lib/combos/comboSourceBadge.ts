/**
 * Provenance badge for a persisted combo row.
 *
 * A persisted combo can reach the dashboard from three different writers, and
 * the operator has to be able to tell them apart before editing one:
 *
 * - `JARVIS_MANAGED`  — reconciled continuously by the managed-combo apply loop
 *   (`src/lib/failover/managedComboApply.ts` writes `config.jarvisManaged`).
 *   Hand edits are overwritten on the next reconcile.
 * - `STATIC_SNAPSHOT` — a one-off copy of an `auto/*` route taken through
 *   "duplicate" (`config.sourceAutoCombo`). It is frozen: the live router keeps
 *   evolving, this copy does not.
 * - `MANUAL_LEGACY`   — everything else: built by hand, imported, or written by
 *   an OmniRoute version that predates both markers.
 *
 * Why this is not a one-line ternary on the page: `config` is persisted inside
 * the combo's JSON blob, but not every writer has gone through
 * `comboRuntimeConfigSchema`. Restored backups and older import paths can hand
 * us the config as an already-serialized JSON *string*, and
 * `("" as string).jarvisManaged` is simply `undefined` — so a managed combo
 * would silently render as MANUAL / LEGACY and invite an operator to hand-edit
 * a row the reconciler owns. Parsing defensively here makes the label a
 * function of what was actually persisted, in one place that can be tested.
 */

export type ComboSource = "JARVIS_MANAGED" | "STATIC_SNAPSHOT" | "MANUAL_LEGACY";

/**
 * Best-effort view of a combo's `config` as a plain object.
 *
 * Accepts the object shape (normal), a JSON string (restored/imported rows) and
 * anything else (returns `null`). A JSON string that parses to a non-object —
 * `"null"`, `"42"`, `"[]"` — is treated as "no config", never as a truthy bag.
 */
export function resolveComboConfig(config: unknown): Record<string, unknown> | null {
  if (typeof config === "string") {
    const trimmed = config.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Not JSON at all. Nothing to read — do not guess.
      return null;
    }
  }
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return null;
}

/**
 * Precedence is deliberate and must stay in this order:
 *
 * 1. `jarvisManaged` / `jarvisAuto` win over everything. A combo that the
 *    reconciler owns stays labelled as owned even when it *also* carries a
 *    `sourceAutoCombo` marker from having been duplicated out of `auto/*`
 *    before Jarvis adopted it — the stronger warning is the accurate one.
 * 2. `sourceAutoCombo` marks the frozen snapshot copy.
 * 3. Otherwise manual/legacy.
 *
 * Markers are treated as present when merely truthy: the managed writer stores
 * an ownership object, but older rows stored `true`, and both mean "owned".
 */
export function resolveComboSource(config: unknown): ComboSource {
  const resolved = resolveComboConfig(config);
  if (!resolved) return "MANUAL_LEGACY";
  if (resolved.jarvisManaged || resolved.jarvisAuto) return "JARVIS_MANAGED";
  if (resolved.sourceAutoCombo) return "STATIC_SNAPSHOT";
  return "MANUAL_LEGACY";
}
