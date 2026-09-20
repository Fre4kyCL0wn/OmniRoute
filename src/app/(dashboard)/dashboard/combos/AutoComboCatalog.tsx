"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";
import { AUTO_COMBO_TEMPLATES, type AutoComboTemplate } from "@/domain/assessment/types";

interface LiveAutoCandidate {
  providerId: string;
  model: string;
  allowedConnectionIds?: string[];
}

interface LiveAutoCombo {
  id: string;
  name: string;
  /** Number of routable MODELS in the materialized pool. */
  candidateCount: number;
  /** Distinct providers backing those models (already deduped server-side). */
  candidatePool?: string[];
  /** Same count as `candidatePool.length`, sent explicitly since R59. */
  providerCount?: number;
  candidates?: LiveAutoCandidate[];
  active?: boolean;
  management?: string;
}

/** One auto route that resolved to an empty candidate pool this process. */
interface EmptyAutoPoolSignal {
  label: string;
  message: string;
  lastSeenAt: string;
  occurrences: number;
}

interface LiveAutoPayload {
  combos?: LiveAutoCombo[];
  emptyPoolSignals?: EmptyAutoPoolSignal[];
}

const templateByName = new Map(AUTO_COMBO_TEMPLATES.map((template) => [template.name, template]));

/**
 * Drop payload entries that cannot be rendered, and collapse duplicate ids.
 *
 * `/api/combos/auto` enumerates four independent variant families into one
 * array; a future overlap between them would otherwise render the same route
 * twice and — because the id is the React key — make React reconcile two
 * different cards onto one key. First entry wins, matching the route's own
 * `seenIds` precedence (templates before suffixes before families).
 */
export function normalizeLiveAutoCombos(payload: LiveAutoPayload | null | undefined) {
  const combos = Array.isArray(payload?.combos) ? payload.combos : [];
  const byId = new Map<string, LiveAutoCombo>();
  for (const combo of combos) {
    if (!combo || typeof combo.id !== "string" || !combo.id.trim()) continue;
    if (byId.has(combo.id)) continue;
    byId.set(combo.id, combo);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Keep only signals that can actually be rendered. The message is the operator's
 * only explanation for why a route is dark, so a signal without one is noise.
 */
export function normalizeEmptyPoolSignals(
  payload: LiveAutoPayload | null | undefined
): EmptyAutoPoolSignal[] {
  const signals = Array.isArray(payload?.emptyPoolSignals) ? payload.emptyPoolSignals : [];
  return signals.filter(
    (signal): signal is EmptyAutoPoolSignal =>
      !!signal && typeof signal.label === "string" && typeof signal.message === "string"
  );
}

export default function AutoComboCatalog({
  onComboCreated,
}: {
  onComboCreated?: (comboId: string) => void;
}) {
  const t = useTranslations("combos");
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [liveCombos, setLiveCombos] = useState<LiveAutoCombo[]>([]);
  const [emptyPoolSignals, setEmptyPoolSignals] = useState<EmptyAutoPoolSignal[]>([]);
  const [duplicatingName, setDuplicatingName] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // Collapsed panel ⇒ no request at all. Materializing every auto route is
    // the most expensive read on this page, and nothing of it is visible while
    // the section is closed.
    if (!open) return;
    const controller = new AbortController();
    // Deferred by a microtask so the effect body itself stays free of
    // synchronous setState (react-hooks/set-state-in-effect); the fetch below
    // cannot settle before this runs, so the panel still shows the spinner for
    // the whole request.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
    });
    void fetch("/api/combos/auto", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as LiveAutoPayload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setLiveCombos(normalizeLiveAutoCombos(payload));
        setEmptyPoolSignals(normalizeEmptyPoolSignals(payload));
        setLoadFailed(false);
      })
      .catch(() => {
        // An abort is this effect being torn down, not a failed load — showing
        // the error banner for it would be wrong and would outlive the unmount.
        if (controller.signal.aborted) return;
        setLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [open, reloadToken]);

  const handleDuplicate = useCallback(
    async (combo: LiveAutoCombo) => {
      const template = templateByName.get(combo.id);
      if (
        !confirm(
          `${t("duplicateAutoComboConfirm", { name: combo.id })}\n\n${t("duplicateAutoComboSnapshotMsg")}`
        )
      )
        return;

      setDuplicatingName(combo.id);
      try {
        const res = await fetch("/api/combos/duplicate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: combo.id, strategy: template?.strategy ?? "priority" }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(
            `${t("duplicateAutoComboFailedPrefix")} ${data.error || t("duplicateAutoComboUnknownError")}`
          );
          return;
        }
        const created = await res.json();
        // The snapshot copy changes what the router can materialize (and the
        // persisted list this panel sits above), so re-read the live state
        // instead of leaving a stale card on screen.
        setReloadToken((token) => token + 1);
        onComboCreated?.(String(created.id));
      } catch (error) {
        console.error("Error duplicating auto-combo:", error);
        alert(
          `${t("duplicateAutoComboFailedPrefix")} ${error instanceof Error ? error.message : t("duplicateAutoComboUnknownError")}`
        );
      } finally {
        setDuplicatingName(null);
      }
    },
    [onComboCreated, t]
  );

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={open}
        aria-label={open ? t("autoCatalogCollapse") : t("autoCatalogExpand")}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="material-symbols-outlined text-xl text-primary">auto_awesome</span>
            <h2 className="text-base font-bold text-text-main">{t("autoCatalogTitle")}</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {loading ? "…" : t("autoCatalogLiveRouteCount", { count: liveCombos.length })}
            </span>
            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold text-green-500">
              {t("autoCatalogAutoManaged")}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t("autoCatalogDescription")}</p>
          <p className="mt-1 text-[10px] text-text-muted">{t("autoCatalogLiveHint")}</p>
        </div>
        <span className="material-symbols-outlined text-base text-text-muted">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          {loading && <p className="text-xs text-text-muted">{t("autoCatalogLoading")}</p>}
          {loadFailed && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
              {t("autoCatalogLoadFailed")}
            </p>
          )}
          {!loading && emptyPoolSignals.length > 0 && (
            <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
              <p className="font-semibold">{t("autoCatalogEmptyPoolSignalsTitle")}</p>
              <ul className="mt-1 space-y-0.5">
                {emptyPoolSignals.map((signal) => (
                  <li key={signal.label}>
                    <code className="font-mono">{signal.label}</code> — {signal.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!loading && !loadFailed && liveCombos.length === 0 && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
              {t("autoCatalogEmpty")}
            </p>
          )}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {liveCombos.map((combo) => {
              const template: AutoComboTemplate | undefined = templateByName.get(combo.id);
              const candidates = Array.isArray(combo.candidates) ? combo.candidates : [];
              const active = combo.active === true && combo.candidateCount > 0;
              // Models and providers are different units; prefer the explicit
              // field and fall back to the deduped provider pool for payloads
              // produced before it existed.
              const providerCount =
                typeof combo.providerCount === "number"
                  ? combo.providerCount
                  : (combo.candidatePool?.length ?? 0);
              return (
                <div
                  key={combo.id}
                  className="relative rounded-lg border border-border bg-bg-subtle p-3 text-xs"
                >
                  <button
                    onClick={() => void handleDuplicate(combo)}
                    disabled={duplicatingName !== null || !active}
                    className="absolute bottom-1.5 right-1.5 rounded p-0.5 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-30 dark:hover:bg-white/5"
                    title={t("duplicateAutoComboTitle", { name: combo.id })}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px] ${duplicatingName === combo.id ? "animate-spin" : ""}`}
                    >
                      {duplicatingName === combo.id ? "progress_activity" : "content_copy"}
                    </span>
                  </button>

                  <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
                    <code className="font-mono text-sm text-text-main">{combo.id}</code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                        active ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                      }`}
                    >
                      {active ? t("autoCatalogRouteActive") : t("autoCatalogRouteInactive")}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-text-muted">
                    {t("autoCatalogCandidateCount", { count: combo.candidateCount })}
                    {providerCount > 0
                      ? ` · ${t("autoCatalogProviderCount", { count: providerCount })}`
                      : ""}
                  </p>
                  {template && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {template.categories.map((category) => (
                        <span
                          key={category}
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                        >
                          {category}
                        </span>
                      ))}
                      {template.tiers.map((tier) => (
                        <span
                          key={tier}
                          className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] text-text-muted dark:bg-white/[0.04]"
                        >
                          {tier}
                        </span>
                      ))}
                    </div>
                  )}
                  {candidates.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-border pt-2">
                      {candidates.slice(0, 4).map((candidate, index) => (
                        <div
                          key={`${candidate.providerId}:${candidate.model}:${index}`}
                          className="truncate font-mono text-[10px] text-text-muted"
                        >
                          {candidate.model}
                        </div>
                      ))}
                      {candidates.length > 4 && (
                        <div className="text-[10px] text-text-muted">
                          {t("autoCatalogMoreCandidates", { count: candidates.length - 4 })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
