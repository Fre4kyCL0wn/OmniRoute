# Jarvis Autonomous Free Pool Runbook

This runbook covers the Jarvis/O9 managed strict-zero-cost coding pool.

## Runtime contract

`jarvis-auto` points at `jarvis-managed/free-coding` as its first route. The managed child may contain only routes that pass the current strict-zero-cost, capability, compatibility, activation, runtime-health and cooldown gates.

The autonomous pool is fail-closed. Unknown billing safety, stale compatibility evidence, missing tool support, active cooldowns, removed models and paid-only routes cannot silently widen the pool.

## Discovery and qualification

Credentialed providers are discovered through the normal provider observation catalog. Approved no-auth providers use the same observation inventory with a synthetic connection identity.

OpenCode is currently the only unattended no-auth provider admitted by the shared allowlist. Its public catalog is observed first; a real Claude `/v1/messages` tool roundtrip is still required before the route can become active.

Provider-specific recurring-free or trial metadata remains visible even when it is insufficient for strict-zero-cost activation.

## Ranking and diversity

Eligible routes receive a deterministic score from coding/tool/reasoning capability, context window, runtime health, quota state, compatibility latency and recent success/failure evidence.

When scores are close, provider diversity is preferred so one provider/account cannot monopolize every priority slot. `priority` combos preserve this ranked order; the evidence fingerprint stays order-independent for drift detection.

## Lifecycle

Observed routes move through `QUARANTINE`, `ACTIVE`, `DEGRADED`, `COOLDOWN`, `UNAVAILABLE` and `ARCHIVED`. Archiving is non-destructive. A later catalog reappearance reuses the retained history and re-enters qualification.

A fresh `TRANSIENT_FAILURE/rate_limit` compatibility result creates connection-wide probe backoff until its TTL expires. This prevents sequential model probes from repeatedly striking the same rate-limited account.

## Observatory

Use Dashboard → Analytics → Free Pool or `GET /api/jarvis/free-pool/observatory` with management authentication.

The observatory exposes provider/runtime state, lifecycle, compatibility, zero-cost evidence, ranking, cooldowns and exclusion reasons. It intentionally excludes credentials, prompts and upstream response bodies.

## Acceptance expectations

A current-route 429 must prefer a healthy strict-free route on another provider. Provider unavailability or model removal must do the same when such a route exists.

If every strict-free route is unavailable, a paid or cost-unproven candidate is rejected. The decision is `WAIT_COOLDOWN` when the current transient failure has a known recovery time, otherwise `NO_SAFE_ROUTE`.

## Production checks

Before rollout, back up the SQLite database and deployment configuration, retain the previous production image, and validate the candidate on a disposable snapshot.

After rollout verify container health, loopback port bindings, authenticated `/v1/models`, the free-pool observatory, R4.7/R4.8 reconciliation, and one real Claude Code request through `claude/combo/jarvis-auto`.

## Rollback

Keep the previous production image and a stopped rollback container or equivalent recreate metadata. Rollback restores the prior runtime image while keeping the current persistent data volume only when schema compatibility is confirmed; otherwise restore the matching pre-rollout SQLite backup.

Do not delete the last known-good image, current database backup, Compose backup or container inspect until the new runtime has passed the final acceptance checks.

## Cost ladder

`jarvis-auto` schema v2 extends the strict-free runtime with guarded escalation: `jarvis-managed/free-coding` → verified zero-cost fallback → `auto/subscription` → optional `auto/thrifty`.

Subscription routing is enabled by default and uses only connections classified as plan-included by the curated connection-billing catalog. Hard-stop quota exhaustion falls through rather than producing incremental API spend.

Paid routing is disabled by default. Enabling it requires `OMNIROUTE_JARVIS_AUTO_PAID_ROUTING_ENABLED=true` plus explicit `cheap` and `premium` USD budgets in `settings.subscriptionLadder.rungBudgetUsd`; use `0` to disable either rung. Missing either budget keeps paid escalation disabled.
The budget window defaults to `monthly` and may be set to `daily`. Spend is computed from successful OmniRoute usage history. If any paid usage row cannot be priced, accounting becomes incomplete and paid rungs fail closed. The observatory shows budget, spend, remaining amount, window, and accounting state.

Recommended production default remains: subscription enabled, paid routing disabled, `cheap=0`, `premium=0`. Raise budgets only after the corresponding provider connections and pricing evidence have been validated.
