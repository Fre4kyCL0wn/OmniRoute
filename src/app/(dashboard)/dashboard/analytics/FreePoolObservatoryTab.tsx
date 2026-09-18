"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import { matchesSearch } from "@/shared/utils/turkishText";
import type { ManagedFreeObservatorySnapshot } from "@/lib/failover/managedFreeObservatory";

async function fetchSnapshot(signal?: AbortSignal): Promise<ManagedFreeObservatorySnapshot> {
  const response = await fetch("/api/jarvis/free-pool/observatory", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Observatory request failed (${response.status})`);
  return (await response.json()) as ManagedFreeObservatorySnapshot;
}

function badgeClass(state: string): string {
  if (state === "ACTIVE" || state === "PASS") return "bg-success/10 text-success";
  if (state === "COOLDOWN" || state === "DEGRADED") return "bg-warning/10 text-warning";
  if (state === "UNAVAILABLE" || state === "ARCHIVED") return "bg-error/10 text-error";
  return "bg-bg text-text-muted";
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value: string | number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function FreePoolObservatoryTab() {
  const [data, setData] = useState<ManagedFreeObservatorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSnapshot());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load free pool");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSnapshot(controller.signal)
      .then((snapshot) => {
        setData(snapshot);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load free pool");
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const candidates = useMemo(() => {
    const query = filter.trim();
    if (!query) return data?.candidates ?? [];
    return (data?.candidates ?? []).filter((candidate) =>
      matchesSearch(
        `${candidate.providerId} ${candidate.routeId} ${candidate.lifecycleState}`,
        query
      )
    );
  }, [data?.candidates, filter]);
  if (loading) {
    return <Card title="Jarvis Free Pool" subtitle="Loading autonomous routing state…" />;
  }
  if (error || !data) {
    return (
      <Card
        title="Jarvis Free Pool"
        subtitle={error ?? "No observatory data available"}
        action={
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Candidates" subtitle="Observed routes">
          <div className="text-3xl font-semibold">{data.totalCandidates}</div>
        </Card>
        <Card title="Strict free" subtitle="Proven zero-cost">
          <div className="text-3xl font-semibold">{data.strictSafeCandidates}</div>
        </Card>
        <Card title="Providers" subtitle="Currently represented">
          <div className="text-3xl font-semibold">{data.providerCount}</div>
        </Card>
        <Card title="Strategy" subtitle={data.strategyConfidence}>
          <div className="text-xl font-semibold">{data.strategy ?? "none"}</div>
        </Card>
      </div>

      {data.costLadder ? (
        <Card
          title="Jarvis cost ladder"
          subtitle={`Budget window: ${data.costLadder.budgetWindow} · accounting ${data.costLadder.accountingComplete ? "complete" : "blocked/incomplete"}`}
        >
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-text-muted">Subscription</div>
              <div className="font-semibold">
                {data.costLadder.subscriptionActive
                  ? "ACTIVE"
                  : data.costLadder.subscriptionRequested
                    ? "READY"
                    : "OFF"}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Paid routing</div>
              <div className="font-semibold">
                {data.costLadder.paidActive
                  ? "ACTIVE"
                  : data.costLadder.paidRequested
                    ? "ARMED / NO BUDGET"
                    : "OFF"}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Cheap rung</div>
              <div className="font-semibold">
                {formatUsd(data.costLadder.cheapSpendUsd)} /{" "}
                {formatUsd(data.costLadder.cheapBudgetUsd)}
              </div>
              <div className="text-xs text-text-muted">
                {formatUsd(data.costLadder.cheapRemainingUsd)} remaining
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Premium rung</div>
              <div className="font-semibold">
                {formatUsd(data.costLadder.premiumSpendUsd)} /{" "}
                {formatUsd(data.costLadder.premiumBudgetUsd)}
              </div>
              <div className="text-xs text-text-muted">
                {formatUsd(data.costLadder.premiumRemainingUsd)} remaining
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Provider health" subtitle={`Snapshot ${formatTime(data.generatedAt)}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-text-muted">
              <tr>
                <th className="pb-2">Provider</th>
                <th>Models</th>
                <th>Strict</th>
                <th>Active</th>
                <th>Quarantine</th>
                <th>Cooldown</th>
                <th>Unavailable</th>
                <th>PASS</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((provider) => (
                <tr key={provider.providerId} className="border-t border-border">
                  <td className="py-2 font-medium">{provider.providerId}</td>
                  <td>{provider.models}</td>
                  <td>{provider.strictSafe}</td>
                  <td>{provider.active}</td>
                  <td>{provider.quarantine}</td>
                  <td>{provider.cooldown}</td>
                  <td>{provider.unavailable + provider.archived}</td>
                  <td>{provider.compatibilityPass}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card
        title="Model routes"
        subtitle="Ranked autonomous free-coding candidates"
        action={
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter provider/model/state"
            className="w-64 rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="text-left text-text-muted">
              <tr>
                <th className="pb-2">Route</th>
                <th>Lifecycle</th>
                <th>Rank</th>
                <th>Compat</th>
                <th>Cost proof</th>
                <th>Quota</th>
                <th>Last seen</th>
                <th>Last success</th>
                <th>Excluded</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr
                  key={`${candidate.connectionId}:${candidate.routeId}`}
                  className="border-t border-border align-top"
                >
                  <td className="py-2 pr-4">
                    <div className="font-medium">{candidate.routeId}</div>
                    <div className="text-xs text-text-muted">{candidate.connectionId}</div>
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${badgeClass(candidate.lifecycleState)}`}
                    >
                      {candidate.lifecycleState}
                    </span>
                  </td>
                  <td title={candidate.rankReasons.join(", ")}>{candidate.rankScore}</td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${badgeClass(candidate.compatibilityState ?? "")}`}
                    >
                      {candidate.compatibilityState ?? "unknown"}
                    </span>
                  </td>
                  <td title={candidate.strictZeroCostReason}>
                    {candidate.costEvidence ?? candidate.strictZeroCostReason}
                  </td>
                  <td>
                    {candidate.quotaState}
                    {candidate.cooldownUntil ? ` until ${formatTime(candidate.cooldownUntil)}` : ""}
                  </td>
                  <td>{formatTime(candidate.lastObservedAt)}</td>
                  <td>{formatTime(candidate.lastSuccessAt)}</td>
                  <td>{candidate.exclusionReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
