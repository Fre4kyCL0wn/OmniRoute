# Jarvis Integration Baseline

This document describes how the private Jarvis system uses the `Fre4kyCL0wn/OmniRoute` fork.

## Governing boundary

**OmniRoute routes. Jarvis Authority decides.**

OmniRoute owns inference routing concerns such as provider/model selection, fallback, cooldowns, quota handling, health and request transport. Jarvis Brain Core owns project scope, memory authority, capability grants, approvals and privileged actions.

A successful model route never grants Jarvis permissions.

## Current Jarvis production pin

```text
Image   jarvis-omniroute:o9-f13-calllog-a2899042b
Commit  a2899042b  fix(usage): keep every call log insert, on both collision paths
Health  http://127.0.0.1:20130/api/health/ping
```

The production commit is contained in the Jarvis-specific `phase/o9-f3-5-cost-ladder` history. The public default branch `release/v3.8.51` is not, by itself, proof of the deployed Jarvis revision.

## Claude Code / Jarvis path

Jarvis may route Claude Code through OmniRoute using a dedicated inference credential and loopback API boundary. MCP/TeamFBI authentication is separate from inference credentials.

Do not document or commit the actual credential value.

## Safe extension workflow

1. Inspect the current branch/worktree and preserve unrelated WIP.
2. Use a dedicated branch/worktree for a routing change.
3. Keep normal provider/routing behavior backward-compatible unless the change is explicitly scoped.
4. Add focused tests for routing, fallback, quota/cooldown and error semantics.
5. Test through the same endpoint shape Jarvis clients use.
6. Build an immutable candidate image.
7. Verify production-safe rollback before cutover.
8. Record the exact production image/commit after acceptance.

Do not use `git reset`, `git stash`, `git clean`, broad secret changes or destructive Docker cleanup as development shortcuts.

## Current Jarvis baseline relationship

The accepted Jarvis system baseline is 2026-10-01 / Graphiti perf25. OmniRoute is one component of that baseline; it is not the source of truth for Brain/Graphiti production state.

Jarvis Brain Core repository: `Fre4kyCL0wn/jarvis-brain-core`.

## WIP rule

Local experimental branches may contain newer routing work than production. They are not production authority until they pass their own tests, candidate validation, controlled cutover and production acceptance.
