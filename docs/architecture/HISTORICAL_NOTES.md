# Historical Notes & Completed Phase References

Moved from AGENTS.md to keep agent instructions under 40k characters.

## Completed Phase References

- **Velocity phase (2026-08-30 → v4.0)**: numeric baselines loosened by 20%; `--require-tighten` advisory. Tracked in nightly `baseline-headroom` job (`docs/architecture/QUALITY_GATES.md` → "Velocity phase").
- **Fase 6A.12 / PR #6716**: full pre-push gate folded into pre-commit; `any-budget` + `tracked-artifacts` no longer double-run on push.
- **Fase 6A.3**: stale-enforcement added for allowlist entries suppressing violations that no longer exist.

## Incident References

- 2026-06-05 / 2026-06-13: main checkout branch-switch destroying other sessions' uncommitted work.
- 2026-06-25: worktree outside `.claude/worktrees/` poisoning `next build` via `include: **/*` globs (~70× codebase → OOM).
- 2026-07-02 (`#5923`, `#2296`): `git stash pop` leaking quotaCache change across unrelated worktrees; reincidence through subagent.
- 2026-07-31 (`#9043`): `ln -s node_modules` causing Turbopack FATAL panic (`Symlink [project]/node_modules is invalid, it points out of the filesystem root`).
- 2026-08-08 / 2026-08-10: tracked `_tasks` symlink wiped by `git reset --hard`; `_tasks` must stay a real directory (never symlink), never tracked.
- v3.8.40 / v3.8.41: parallel campaign advancing `release/vX.Y.Z` by 34 commits mid-run, forcing full CHANGELOG re-reconciliation; led to parallel-cycle model (2026-07-04 proposal: `_tasks/finished/release-flow/2026-07-04_proposta-ciclo-paralelo-v2.md`).
- PR #11770 (2026-09-01): merged instruction surface compromised by agent-setup script; reverted in #12249.
- PR #3052: heap-guard auto-calibration.
- PR #3090: claude-web 403.
- PR #3113: WS HTTP fallback.

## Historical Workflow Artifacts

- `.agents/skills/generate-release/phases/phase-5-next-cycle.md` — sync-back landing rules.
- `_tasks/finished/release-flow/2026-07-04_proposta-ciclo-paralelo-v2.md` — cycle-model proposal.
