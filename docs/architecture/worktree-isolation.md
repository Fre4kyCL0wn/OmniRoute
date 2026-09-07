# Worktree Isolation — Operational Procedure

Durable reference for the MANDATORY worktree isolation rules (Hard Rule #19 / #22).
AGENTS.md retains only the mandatory pointers; this file holds the full procedure.

## Mandatory Rules (kept in AGENTS.md verbatim)

- Never develop on the shared main checkout.
- Every task gets its own worktree on its own branch; confirm base branch with operator.
- Every worktree lives under `.claude/worktrees/` — never elsewhere.
- Work, commit, push, PR all from inside the worktree.
- Tear down only your own by name (`git worktree remove ...`; `git branch -D <task>`);
  never blanket-delete `fix/*`/`feat/*`.
- End every session with main checkout on the branch it started on (active `release/vX.Y.Z`,
  never `main`).
- Before merging/pushing any PR you did not create this session: `git worktree list` +
  `gh pr view <N> --json state,headRefOid`. Only the owning session merges.

## Full Procedure (reference for operators / subagents)

```bash
BASE_BRANCH="release/vX.Y.Z"          # ← confirmed with operator
TASK="feat/your-feature"
git fetch origin "$BASE_BRANCH"
git worktree add ".claude/worktrees/${TASK##*/}" -b "$TASK" "origin/$BASE_BRANCH"
cd ".claude/worktrees/${TASK##*/}"
cp -al "$(git -C <main_checkout> rev-parse --show-toplevel)/node_modules" node_modules
```

Hard links (`cp -al`), never `ln -s`. Turbopack rejects a symlink resolving outside
project root (`Symlink [project]/node_modules is invalid, it points out of the
filesystem root`) — the error names "filesystem root", not the worktree, costing time.

Why `.claude/worktrees/` only: it is gitignored + excluded from `tsconfig.json` /
`.dockerignore`. Worktrees outside it escape the excludes and poison `next build`
(`tsconfig` `include: **/*` globs ~70× codebase → OOM; incident 2026-06-25).

Base-green check: `gh issue list --repo diegosouzapw/OmniRoute --state open \
  --search "Release branch not green: <base> in:title"`. If red, never treat
inherited failures as your defect; never fix inside feature branch; add
`⚠️ base-red inherited: #<issue>` if you must open anyway.

Sync-back: `main → release/vX+1` must reach as the merge commit already is
(`git merge-base --is-ancestor origin/release/vX+1 <head>` then
`git push origin <head>:refs/heads/release/vX+1`). Squash-merging drops `main` from
ancestry and the next sync-back re-conflicts on every file main touched.

Never `git stash` / `git stash pop` anywhere (shared repo object store; 2026-07-02
`#5923` / `#2296` leak via stash pop, same class through subagent). Compare with
`git show <ref>:<path>` or `git diff <ref> -- <path>` instead. End session on
branch it started (active `release/vX.Y.Z`, never `main`).
