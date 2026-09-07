# OmniRoute agent guide

> **Single source of truth.** ALL project rules, conventions, architecture notes and Hard
> Rules for every AI assistant (Claude Code, Gemini, Codex, Copilot, …) live HERE.
> `CLAUDE.md` and `GEMINI.md` only add assistant-specific deltas and point back. When a rule
> needs to change, change it HERE — never re-fork it into an assistant-specific file.
>
> Historical phase details and incident references moved to
> [`docs/architecture/HISTORICAL_NOTES.md`](docs/architecture/HISTORICAL_NOTES.md).

## Quick Start

```bash
npm install                    # Auto-generates .env from .env.example
npm run dev                    # Dev server at http://localhost:20128
npm run build                  # Next.js 16 production build
npm run build:release          # Release build
npm run lint                   # ESLint (0 errors; warnings pre-existing)
npm run typecheck:core         # TypeScript check
npm run test:coverage          # 60/60/60/60 — statements/lines/functions/branches
npm run check                  # lint + test combined
npm run check:cycles           # Detect circular dependencies
npm run check:docs-all         # Fabricated-docs validation
```

Single test: `node --import tsx/esm --test tests/unit/your-file.test.ts`. Full matrix:
`CONTRIBUTING.md` → "Running Tests".

---

## Project at a Glance

**OmniRoute** — unified AI proxy/router. One endpoint, 356 LLM providers, auto-fallback.

| Layer         | Location                | Purpose                                                |
| ------------- | ----------------------- | ------------------------------------------------------ |
| API Routes    | `src/app/api/v1/`       | Next.js App Router entry points                        |
| Handlers      | `open-sse/handlers/`    | Request processing (chat, embeddings, …)               |
| Executors     | `open-sse/executors/`   | Provider-specific HTTP dispatch                         |
| Translators   | `open-sse/translator/`  | Format conversion (OpenAI ↔ Claude ↔ Gemini)            |
| Transformer   | `open-sse/transformer/` | Responses API ↔ Chat Completions                       |
| Services      | `open-sse/services/`    | Combo routing, rate limits, caching, …                 |
| Database      | `src/lib/db/`           | SQLite domain modules (169 migrations)                  |
| Domain/Policy | `src/domain/`           | Policy engine, cost rules, fallback logic              |
| MCP Server    | `open-sse/mcp-server/`  | 110 tools, 3 transports, 33 scopes                     |
| A2A Server    | `src/lib/a2a/`          | JSON-RPC 2.0 agent protocol                            |
| Skills        | `src/lib/skills/`       | Extensible skill framework                              |
| Memory        | `src/lib/memory/`       | Persistent conversational memory                        |

Monorepo: `src/` (Next.js 16 app), `open-sse/` (streaming engine workspace), `electron/`,
`tests/`, `bin/` (CLI entry point). **No global Next.js middleware** — interception is
route-specific.

### Request Pipeline

```
Client → /v1/chat/completions → CORS → Zod → auth? → policy → injection guard
  → handleChatCore() → cache → rate limit → combo routing? → handleSingleModel()
  → translateRequest() → getExecutor() → fetch() upstream (retry w/ backoff)
  → response translation → SSE stream or JSON
  → If Responses API: responsesTransformer.ts TransformStream
```

**Combo routing** (`open-sse/services/combo.ts`): 19 strategies (priority, weighted,
fill-first, round-robin, p2c, random, least-used, cost-optimized, reset-aware, reset-window,
headroom, strict-random, auto, lkgp, context-optimized, cache-optimized, context-relay,
fusion, pipeline). The `fusion` strategy fans out to a panel in parallel, then a judge
model synthesizes one final answer. Full table + 16-factor Auto-Combo scoring:
`docs/routing/AUTO-COMBO.md`. Resilience: `docs/architecture/RESILIENCE_GUIDE.md`.

---

## Resilience Runtime State (3 layers)

OmniRoute has three distinct temporary-failure mechanisms. Keep their scope separate when
debugging routing. Diagram: [resilience-3layers.svg](./docs/diagrams/exported/resilience-3layers.svg).

| Layer                   | Scope                                | Code                                                              |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Provider Circuit Breaker | whole provider (`glm`, `openai`, …) | `src/shared/utils/circuitBreaker.ts` → `src/sse/handlers/chatHelpers.ts` |
| Connection Cooldown     | one provider connection/account/key  | `src/sse/services/auth.ts` → `open-sse/services/accountFallback.ts`         |
| Model Lockout           | provider + connection + model        | `open-sse/services/accountFallback.ts`                                    |

### Provider Circuit Breaker

**States** (4): `CLOSED` (normal) → `DEGRADED` (warning band) → `OPEN` (blocked) →
`HALF_OPEN` (probe after reset; success closes, failure re-opens). **Lazy recovery** — reads
(`getStatus()`, `canExecute()`, `getRetryAfterMs()`) refresh expired `OPEN` → `HALF_OPEN`.

Trip on provider-level failures only: `(408, 500, 502, 503, 504)`. **Do NOT** trip on normal
`401`/`403`/`429` (those belong to connection cooldown or model lockout). A generic
API-key `403` is recoverable unless classified as terminal.

Defaults (OAuth / API key / Local profiles), `providerFailureWindowMs`, `providerCooldownMs`,
env-var overrides and the runtime-accurate reference table:
[`docs/architecture/RESILIENCE_GUIDE.md`](docs/architecture/RESILIENCE_GUIDE.md).
⚠️ `providerFailureThreshold` / `windowMs` / `cooldownMs` power the opt-in **Provider
Cooldown window gate** (`PROVIDER_COOLDOWN_ENABLED`, default off) — they are NOT the live
breaker's thresholds (do not tune them expecting breaker behavior).

### Connection Cooldown

Connection fields: `rateLimitedUntil`, `testStatus: "unavailable"`, `lastError`,
`lastErrorType`, `errorCode`, `backoffLevel`. Skipped while
`new Date(rateLimitedUntil).getTime() > Date.now()`. Lazy recovery; `clearAccountError()`
clears the fields on success.

Default base cooldowns: OAuth `5s`, API-key `3s`. API-key `429` prefers upstream retry hints
(`Retry-After`, reset headers, parseable reset text). Exponential backoff:
`baseCooldownMs * 2 ** failureIndex`. Anti-thundering-herd guard prevents concurrent failures
from extending cooldown or double-incrementing `backoffLevel`.

Terminal states (`banned`, `expired` after `EXPIRED_RETRY_MAX`, `credits_exhausted`) must NOT
be overwritten by transient cooldown state — they stay unavailable until credentials/settings
change.

### Model Lockout

Avoids disabling a whole connection when only one model is unavailable or quota-limited
(per-model `429`, local `404` for one missing model, Grok mode/permission failures). Lives in
`open-sse/services/accountFallback.ts`.

### Debugging — pick the right layer

- All keys for a provider skipped → check provider breaker state + each connection's
  `rateLimitedUntil`/`testStatus`.
- Provider permanently excluded → code may read raw `state` instead of `getStatus()`/`canExecute()`.
- One key fails, others work → connection cooldown (NOT breaker).
- Only one model fails → model lockout (NOT connection cooldown).
- Self-recovery needs future timestamp + read path that refreshes expired state. Permanent
  statuses need manual credential/config changes.

---

## Repository map

Read the nearest nested `AGENTS.md` and the linked deep-dive before a non-trivial change.

| Area                               | Location                                                | Start here                                                                |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| API routes / streaming handling    | `src/app/api/v1/`, `open-sse/handlers/`                | `docs/architecture/ARCHITECTURE.md`                                       |
| Provider execution / translation   | `open-sse/executors/`, `open-sse/translator/`           | `docs/architecture/CODEBASE_DOCUMENTATION.md`                             |
| Routing and resilience             | `open-sse/services/`                                   | `open-sse/services/AGENTS.md`, `docs/routing/AUTO-COMBO.md`                |
| Database and migrations            | `src/lib/db/`, `src/lib/db/migrations/`                | `src/lib/db/AGENTS.md`                                                    |
| Domain policy                      | `src/domain/`                                          | `docs/architecture/ARCHITECTURE.md`                                       |
| MCP and A2A                        | `open-sse/mcp-server/`, `src/lib/a2a/`                 | `docs/frameworks/MCP-SERVER.md`, `docs/frameworks/A2A-SERVER.md`          |
| Agent features                     | `src/lib/{acp,memory,skills,cloudAgent}/`              | `docs/frameworks/AGENT_PROTOCOLS_GUIDE.md`, `docs/frameworks/SKILLS.md`    |
| Safety and governance              | `src/lib/{guardrails,compliance}/`, `src/server/authz/` | `docs/security/GUARDRAILS.md`, `docs/architecture/AUTHZ_GUIDE.md`        |
| Operations                         | `src/mitm/`, tunnels, `electron/`                      | `docs/ops/TUNNELS_GUIDE.md`, `docs/guides/ELECTRON_GUIDE.md`              |

---

## File placement & repo-root hygiene

- **Tests**: ALL unit/integration/ecosystem/Vitest files go in `tests/` (e.g.
  `tests/unit/`). Never in repo root.
- **Scripts**: ALL `.cjs`/`.mjs`/`.js`/`.ts` maintenance/debug/gen scripts go under
  `scripts/<sub>/` (`build/`, `dev/`, `check/`, `docs/`, `i18n/`, `ad-hoc/`, `quality/`,
  `release/`, `ci/`, `ops/`, `perf/`, `research/`, `sre/`, `vps/`, `homolog/`, `packs/`,
  `skills/`, `test/`, `cli/`, `compression/`, `compression-eval/`, `devin-bridge/`,
  `docker/`, `features/`, `router-eval/`). One-shot → `scripts/ad-hoc/`. Never in repo
  root or top-level `scripts/`.
- **Root `_*` paths** (`_tasks/`, `_references/`, `_mono_repo/`, `_ideia/`, `_cache/`):
  private, gitignored by `/_*/`, live on disk only. `_tasks/` is its own git repo
  (remote `_tasks_omniroute`). Never `git add` inside (plain `add` blocked; never `-f`);
  untrack with `git rm --cached`. Gate `check:tracked-artifacts` fails on any tracked `_`
  path. See Hard Rule #23 for `_tasks` specifics.

**Repo root contains ONLY**: config files (`vitest.config.ts`, `next.config.mjs`,
`eslint.config.mjs`, `tsconfig*.json`, `playwright.config.ts`, `prettier.config.mjs`,
`postcss.config.mjs`, `sonar-project.properties`, `fly.toml`, `docker-compose*.yml`,
`Dockerfile`), deps (`package.json`, `package-lock.json`), docs (`README.md`,
`CHANGELOG.md`, `ROADMAP.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `llm.txt`), and CI/ignore
(`.gitignore`, `.dockerignore`, `.npmignore`, `.npmrc`, `.node-version`, `.nvmrc`,
`.env.example`).

---

## Key Conventions

**Code Style**: 2 spaces, semicolons, double quotes, 100 char width, es5 trailing commas
(Prettier via lint-staged). Imports: external → internal (`@/`, `@omniroute/open-sse`) →
relative. Naming: files=camelCase/kebab, components=PascalCase, constants=UPPER_SNAKE.
ESLint: `no-eval`/`no-implied-eval`/`no-new-func` = error everywhere;
`no-explicit-any` = error in `open-sse/` and `tests/` (pre-existing frozen in
`config/quality/eslint-suppressions.json`; `npm run lint` applies suppressions — what CI runs).
TypeScript: `strict: false`, target ES2022, module esnext, resolution bundler. Prefer
explicit types.

**Database**: always through `src/lib/db/` — **never** raw SQL in routes/handlers. **Never**
barrel-import from `localDb.ts` — import specific `src/lib/db/*` modules. Singleton:
`getDbInstance()` from `src/lib/db/core.ts` (WAL journaling). Migrations:
`src/lib/db/migrations/` — versioned SQL, idempotent, in transactions.

**Error Handling**: try/catch with specific error types; log with pino context. Never
swallow errors in SSE streams — use abort signals. Return proper HTTP status codes (4xx/5xx).

**Security**: never `eval()`, `new Function()`, or implied eval. Validate inputs with Zod.
Encrypt credentials at rest (AES-256-GCM); never log SQLite encryption keys. Sanitize HTML
with DOMPurify. Upstream header denylist: `src/shared/constants/upstreamHeaders.ts` — keep
sanitize, Zod schemas, and unit tests aligned. Public upstream credentials via
`resolvePublicCred()` (`open-sse/utils/publicCreds.ts`) — never string literals
(Hard Rule #11, `docs/security/PUBLIC_CREDS.md`). Error responses via `buildErrorBody()` /
`sanitizeErrorMessage()` (`open-sse/utils/error.ts`) — never raw `err.stack`/`err.message`
(Hard Rule #12, `docs/security/ERROR_SANITIZATION.md`). Shell `exec()`/`spawn()` with runtime
values: pass via `env` option, never string-interpolate untrusted paths
(Hard Rule #13). Prefer secure-by-default libs (Helmet.js, DOMPurify, ssrf-req-filter,
safe-regex, Google Tink) over custom implementations for security-sensitive surfaces.

---

## Documentation accuracy

Documentation must describe verified behavior, not plausible behavior.

1. Before documenting an API name, endpoint, path, CLI command, or env var, search for it:
   `rg -n "name" src/ open-sse/ bin/`. If no source match, do not document it.
2. Measure mutable counts (`wc -l <file>`, dir-specific count) — never write from memory.
3. Copy code examples from working usage or run them. Prefer a source link
   `path/to/file.ts:line` to an invented signature.
4. Run `npm run check:docs-all` for edits under `docs/` (includes fabricated-docs validation).

---

## Common Modification Scenarios

Full step-by-step procedure for each pattern (Provider, API route, DB module, MCP tool,
A2A skill, Cloud agent, Embedded service, Guardrail/Eval/Skill/Webhook/Log-export
destination) → `docs/architecture/modification-scenarios.md`.

Quick pointers:

- **Provider**: register in `src/shared/constants/providers.ts`; executor in
  `open-sse/executors/`; translator in `open-sse/translator/`; OAuth via
  `resolvePublicCred()` if public (Hard Rule #11); models in
  `open-sse/config/providerRegistry.ts`. Check `docs/reference/REMOVED_PROVIDERS.md`
  first (blocklist guard).
- **API route**: `src/app/api/v1/your-route/route.ts`; CORS → Zod → auth → handler
  delegation. Handler in `open-sse/handlers/`. Errors via `buildErrorBody()`
  (Hard Rule #12).
- **DB module / MCP tool / A2A skill / Cloud agent**: see docs file for exact files
  (each has a `createMcpServer()`/`A2A_SKILL_HANDLERS`/`CloudAgentBase`/etc. registration
  step).
- **Embedded service**: full guide `docs/frameworks/EMBEDDED-SERVICES.md` (Hard Rules
  #13, #17 apply).
- **Guardrail / Eval / Skill / Webhook / Log-export**: add code at the listed location and
  update the listed doc; for log-export destinations, runner + REST + dashboard form all
  read the registry.

---

## Reference Documentation

Deep-dives to read before any non-trivial change:

| Area                                                  | Doc                                                            |
| ------------------------------------------------ --- | -------------------------------------------------------------- |
| Repo / Arch / Engineering                           | `docs/architecture/REPOSITORY_MAP.md`, `ARCHITECTURE.md`, `CODEBASE_DOCUMENTATION.md` |
| Auto-Combo / Replay / Resilience                      | `docs/routing/AUTO-COMBO.md`, `REASONING_REPLAY.md`, `docs/architecture/RESILIENCE_GUIDE.md` |
| Skills / Memory / Radar / Cloud / A2A / MCP / Protocols | `docs/frameworks/SKILLS.md`, `MEMORY.md`, `RADAR.md`, `CLOUD_AGENT.md`, `A2A-SERVER.md`, `MCP-SERVER.md`, `AGENT_PROTOCOLS_GUIDE.md` |
| Security / Guardrails / Creds / Sanitize / Compliance / Authz / Stealth | `docs/security/GUARDRAILS.md`, `PUBLIC_CREDS.md`, `ERROR_SANITIZATION.md`, `COMPLIANCE.md`, `AUTHZ_GUIDE.md`, `STEALTH_GUIDE.md` |
| Webhooks / Log-export / Tunnels / Electron / Copilot / Release / Embedded / Quality | `docs/frameworks/WEBHOOKS.md`, `LOG-EXPORT.md`, `docs/ops/TUNNELS_GUIDE.md`, `docs/guides/ELECTRON_GUIDE.md`, `VSCODE-COPILOT.md`, `RELEASE_CHECKLIST.md`, `EMBEDDED-SERVICES.md`, `QUALITY_GATES.md` |
| API / OpenAPI / Provider catalog                     | `docs/reference/API_REFERENCE.md` + `docs/openapi.yaml`, `PROVIDER_REFERENCE.md` |

---

## Testing

- Unit: `npm run test:unit`; single file: `node --import tsx/esm --test tests/unit/your-file.test.ts`
- Vitest (MCP, autoCombo, cache): `npm run test:vitest`
- E2E (Playwright): `npm run test:e2e`; Protocol E2E (MCP+A2A): `npm run test:protocols:e2e`
- Ecosystem: `npm run test:ecosystem` (blocking)
- Coverage gate: `npm run test:coverage` (60/60/60/60); report: `npm run coverage:report`

**PR rule**: changing production code in `src/`, `open-sse/`, `electron/`, or `bin/` requires
tests in the same PR.

**Layer preference**: unit first → integration (multi-module/DB state) → e2e (UI/workflow).
Encode bug reproductions as automated tests before/with the fix.

**Both test runners must pass**: `npm run test:unit` (Node native) AND `npm run test:vitest`
(MCP, autoCombo, cache) are wired in CI (jobs `test-unit` + `test-vitest`). A PR where only
one suite passes may silently ship broken MCP tools or routing regressions.

**Bug fix / issue triage protocol (Hard Rule #18)** — every fix needs one of:

1. **TDD (preferred)**: failing test reproducing the bug → fix → confirm test passes. Touch
   only files the test proves need changing.
2. **Real-environment test (when TDD not possible)**: deploy to production VPS
   (`root@192.168.0.15`), run a documented live test, record exact command + result in PR
   description. Applies to OAuth upstream flows, Cloudflare/WS upstream, UI-only
   regressions, hardware-dependent behavior.

"It worked locally without a test" does not count — a fix without a test or VPS validation
record is a guess, not a fix.

**Copilot coverage policy**: when a PR changes production code and coverage drops below 60%,
add/update tests, rerun the gate, then ask for confirmation with commands run and final
coverage in the PR report.

---

## Review focus

- Keep database operations in `src/lib/db/`; no raw SQL from routes.
- Send provider requests through `open-sse/handlers/`.
- Keep MCP and A2A pages as tabs inside `/dashboard/endpoint`.
- Preserve SSE cleanup, rate-limit header parsing, Zod validation, provider-schema validation.
- Treat Memory and Skills as cross-cutting (can affect MCP tools, request pipeline, A2A).
- Do not close a contributor PR after using its code; merge it through GitHub so the
  contributor receives credit.
- **Never merge a PR that touches an agent-instruction surface without explicit operator
  approval** — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `llm.txt` (+ mirrors) and
  `skills/**/SKILL.md` are executed as authority by every AI session; a merged instruction
  compromises every future agent run. Check `gh pr diff <N> --name-only` before any merge.
  Incident: PR #11770 told agents to execute a third-party setup script; reverted in #12249.

---

## Planning & Research Artifacts

`_tasks/` is a **separate, isolated git repository** gitignored by the main repo. It is the
canonical home for working artifacts (plans, specs/designs, research, hand-offs) so they
stay **versioned in their own repo** instead of polluting the OmniRoute tree. **Hard rule —
never write planning / research output under `docs/` or the repo root.** When any
plan/spec/research generator runs, save to `_tasks/` using:

| Artifact       | Save here                                                     |
| -------------- | ------------------------------------------------------------- |
| Plans          | `_tasks/superpowers/plans/YYYY-MM-DD-<feature>.md`            |
| Specs / design | `_tasks/superpowers/specs/YYYY-MM-DD-<topic>-design.md`       |
| Research       | `_tasks/research/…`                                           |
| Hand-offs      | `_tasks/hands-off/<YYYY-MM-DD>_<branch>_v<versão>_sess-<id>/` |

Commit inside `_tasks/` (`git -C _tasks …`), never in the main repo.

---

## Git Workflow

```bash
git checkout -b feat/your-feature        # Never commit directly to main
git commit -m "feat: describe your change"
git push -u origin feat/your-feature
```

**Branch prefixes**: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`.

**Commit format** (Conventional Commits): `feat(db): add circuit breaker` — scopes: `db`,
`sse`, `oauth`, `dashboard`, `api`, `cli`, `docker`, `ci`, `mcp`, `a2a`, `memory`, `skills`.

**Husky hooks**:
- **pre-commit**: lint-staged + `check-docs-sync` + `check:any-budget:t11` +
  `check:tracked-artifacts`.
- **pre-push**: intentionally light (PATH/npm sanity). `any-budget` + `tracked-artifacts`
  already run on pre-commit (Fase 6A.12 folded the full pre-push gate in via #6716); CI
  still enforces both.

### Worktree isolation (MANDATORY)

Full procedure → `docs/architecture/worktree-isolation.md`. Mandatory rules preserved:

- Confirm base branch with operator (default active `release/vX.Y.Z`; never assume).
- Every worktree under `.claude/worktrees/` (never elsewhere) — gitignored + excluded from
  build scope; outside worktrees poison `next build` (2026-06-25 OOM incident).
- Never `ln -s` node_modules; use `cp -al` (hard links, ~5s, near-zero disk). Turbopack
  rejects symlinks resolving outside project root (2026-07-31 `#9043`).
- Work/commit/push/PR from inside worktree; tear down only your own by name; never
  blanket-delete `fix/*`/`feat/*`. End session on branch it started (`release/vX.Y.Z`).
- Before merging any PR you did not create: `git worktree list` + `gh pr view <N> --json
  state,headRefOid`. Only owning session merges its in-flight PR.
- Never `git stash` / `git stash pop` — operates on shared repo object store, not
  per-worktree working tree (2026-07-02 `#5923`/`#2296` leak; same class through subagent).
  Compare with `git show <ref>:<path>`; never stash to "get it clean". Put this verbatim
  in every subagent that touches git.

Quick starter:
```bash
BASE_BRANCH="release/vX.Y.Z"; TASK="feat/your-feature"
git fetch origin "$BASE_BRANCH"
git worktree add ".claude/worktrees/${TASK##*/}" -b "$TASK" "origin/$BASE_BRANCH"
cd ".claude/worktrees/${TASK##*/}"; cp -al "$(git -C <main> rev-parse --show-toplevel)/node_modules" node_modules
```
Full procedure and sync-back rules (`git merge-base --is-ancestor`, never squash-merge
release sync-backs, base-green check with `gh issue list --label base-red`):
`docs/architecture/worktree-isolation.md`.

---

## Upstream contributions

This checkout is a fork of `diegosouzapw/OmniRoute`. Keep fork-only deployment and personal
automation changes out of upstream PRs.

Start upstream work from the active upstream default branch, not `main`:

```bash
git fetch upstream
git switch -c <branch-name> upstream/<default-branch>
```

Target that same release branch in the pull request. Stage only the intended files, run the
focused checks, use a Conventional Commit message (e.g. `docs: slim AGENTS.md`).

---

## Environment

- **Runtime**: Node.js ≥22.22.2 <23 || ≥24.0.0 <27, ES Modules. **Only supported** for the
  published `omniroute` CLI, server, and test suites (`node:test` + vitest) —
  `engines.node` is authoritative; end users never need Bun. Best-effort `bun:sqlite`
  path exists but is not supported.
- **Bun (gate/generator runner + compatibility smoke only)**: pinned `1.4.0` (lockfile
  `@oven/bun-*` binaries; no `setup-bun`/ad-hoc install). **Only** for allow-listed
  gate/generator scripts replacing `node --import tsx`: CI checks
  `check:provider-consistency`, `check:compression-budget`, `check:known-symbols`; non-CI
  `gen:provider-reference`, `bench:compression`; plus `test:bun:db`. **Do NOT** widen to
  `npm install`, build (`build:cli*`), `check:pack-artifact`, the supported published
  runtime, or main test runners. New Bun scripts must be validated byte-identical vs
  `node --import tsx`. After pulling lockfile change, `npm install` so `bun` resolves.
- **TypeScript**: 6.0+, target ES2022, module esnext, resolution bundler.
- **Path aliases**: `@/*` → `src/`, `@omniroute/open-sse` → `open-sse/`, `@omniroute/open-sse/*` → `open-sse/*`.
- **Default port**: 20128 (API + dashboard). **Data dir**: `DATA_DIR` env var, `~/.omniroute/`.
- **Key env vars**: `PORT`, `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`,
  `REQUIRE_API_KEY`, `APP_LOG_LEVEL`. Setup: `cp .env.example .env`; generate keys:
  `openssl rand -base64 48` → `JWT_SECRET`, `openssl rand -hex 32` → `API_KEY_SECRET`.

---

## Quality Gates & Ratchets

OmniRoute has **~90 quality-gate scripts** (`scripts/check/` + `scripts/quality/`) wired
across CI jobs in `.github/workflows/ci.yml` + `quality.yml` + 5 nightly workflows. Full
inventory, per-job breakdown and procedures:
[`docs/architecture/QUALITY_GATES.md`](docs/architecture/QUALITY_GATES.md).

- **Pass/fail** (lint, docs-sync-strict): fix or allowlist with justification.
- **Ratchet** (quality-gate): must not regress vs `quality-baseline.json`; update with `npm run quality:ratchet -- --update` when improving.
- **Blocking**: `test-unit`, `test-vitest` (MCP, autoCombo, cache).
- **Velocity (2026-08-30 → v4.0)**: baselines loosened 20%; `--require-tighten` advisory.

**Allowlist**: fix cause; allowlist only pre-existing impossible fixes. Justify + issue
number required. Stale entries caught by Fase 6A.3 enforcement.

---

## Hard Rules

1. Never commit secrets or credentials.
2. Never barrel-import from `localDb.ts` — import specific `src/lib/db/*` modules.
3. Never use `eval()` / `new Function()` / implied eval.
4. Never commit directly to `main`.
5. Never write raw SQL in routes — use `src/lib/db/` modules.
6. Never silently swallow errors in SSE streams.
7. Always validate inputs with Zod schemas.
8. Always include tests when changing production code.
9. Coverage must not regress below the baseline frozen in `quality-baseline.json` (ratchet);
   absolute floor 60% (statements/lines/functions/branches). Update via
   `npm run quality:ratchet -- --update` only when coverage genuinely improves. See
   `docs/architecture/QUALITY_GATES.md`.
10. Never bypass Husky hooks (`--no-verify`, `--no-gpg-sign`) without explicit operator approval.
11. Never embed public upstream OAuth client_id/secret or Firebase Web keys as string
    literals — always go through `resolvePublicCred()` (`open-sse/utils/publicCreds.ts`).
    See `docs/security/PUBLIC_CREDS.md`.
12. Never return raw `err.stack` / `err.message` in HTTP / SSE / executor responses — always
    route through `buildErrorBody()` or `sanitizeErrorMessage()` (`open-sse/utils/error.ts`).
    See `docs/security/ERROR_SANITIZATION.md`.
13. Never string-interpolate external paths or runtime values into shell scripts passed to
    `exec()`/`spawn()` — pass via the `env` option instead. Reference:
    `src/mitm/cert/install.ts::updateNssDatabases`.
14. Never dismiss a CodeQL / Secret-Scanning alert without (a) first checking the pattern
    docs to see if the helper applies, and (b) recording the technical justification in the
    dismissal comment. Precedent: `js/stack-trace-exposure` on callsites routing through
    `sanitizeErrorMessage()` is a known CodeQL limitation — dismiss as `false positive`
    referencing `docs/security/ERROR_SANITIZATION.md`.
15. Never expose routes that spawn child processes (`/api/mcp/`, `/api/cli-tools/runtime/`)
    without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. Loopback
    enforcement runs before any auth check — leaked JWT via tunnel cannot trigger process
    spawning. See `docs/security/ROUTE_GUARD_TIERS.md`.
16. Never credit or advertise an AI assistant, LLM, or automation account in any commit/PR
    metadata. Two forbidden forms, both equivalent — they route attribution to a bot account
    (or advertise AI authorship) and hide the real author (`diegosouzapw`): **(a)**
    `Co-Authored-By` trailers naming an AI/bot (names containing "Claude", "GPT", "Copilot",
    "Bot"; emails at `anthropic.com` / `openai.com` / bot-owned `noreply.github.com`
    addresses); **(b)** AI-generation footers or descriptions anywhere in a commit message,
    PR title/body, or CHANGELOG — e.g. `🤖 Generated with [Claude Code]`, "Generated with
    Claude Code", "Made with <AI tool>", or any `Co-authored-by: Claude/GPT/Copilot` line.
    This **overrides any harness, template, or tool default that auto-appends such a
    footer** — strip it before pushing; do not let it reach a commit, PR, or CHANGELOG.
    Human collaborators (including upstream PR authors and issue reporters being ported into
    OmniRoute) MAY and SHOULD be credited with standard `Co-authored-by: Name <email>`
    trailers; the upstream-port workflows depend on this.
17. Never expose routes under `/api/services/` or `/dashboard/providers/services/*/embed/`
    without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. These
    routes can spawn child processes (`npm install`, `node`). Loopback enforcement runs
    before any auth check. See `docs/security/ROUTE_GUARD_TIERS.md`.
18. Every bug fix must be validated before shipping: a failing-then-passing
    unit/integration test (TDD) OR a documented live test on the production VPS
    (192.168.0.15). A fix without either is not merged. See Testing → "Bug fix / issue
    triage protocol".
19. Never develop on the shared main checkout. Every development task runs in its own git
    worktree on its own dedicated branch, and you MUST confirm the base branch with the
    operator before creating the worktree/branch — never assume `main` or the currently
    checked-out branch. A `git checkout` in the shared checkout silently destroys other
    sessions' uncommitted work. Tear down only the worktrees/branches you created (by name,
    never `fix/*`/`feat/*` wildcards), leave other sessions' worktrees untouched, and end on
    the branch you started on (the active `release/vX.Y.Z`, never `main`).
20. PII redaction/sanitization is **opt-in — never on by default**. OmniRoute proxies
    for self-hosted/local LLMs where the operator owns the data; mutating payloads by
    default would silently corrupt legitimate traffic. The two data-mutating PII feature
    flags **MUST** keep `defaultValue: "false"` in
    `src/shared/constants/featureFlagDefinitions.ts`: `PII_REDACTION_ENABLED` (request) and
    `PII_RESPONSE_SANITIZATION` (response + streaming). All three application points —
    `src/lib/guardrails/piiMasker.ts`, `src/lib/piiSanitizer.ts`,
    `src/lib/streamingPiiTransform.ts` — are gated on these flags; with both off the
    `pii-masker` guardrail still runs but never mutates payloads. Flipping either default
    to `"true"` requires explicit operator approval. Regression guard:
    `tests/unit/pii-opt-in-default.test.ts`. Opt-in is per-operator via env or the
    settings/DB override (`src/lib/db/featureFlags.ts`), never a silent default. See
    `docs/security/GUARDRAILS.md`.
21. **Release-freeze — the FROZEN release branch belongs to the release captain;
    development does NOT stop (parallel-cycle model).** `/generate-release` opens a marker
    issue labeled `release-freeze` at the start of reconciliation (Phase 0a), immediately
    cuts the next cycle's branch `release/vX+1` from the frozen tip (Phase 0a.0b), and
    closes the freeze once the release PR squash-merges to `main`. Before merging any PR,
    every campaign workflow (`/review-prs`, `/review-group-prs`, `/merge-prs`,
    `/triage-fix-bugs`, `/implement-fix-bugs`, `/triage-features`, `/implement-features`,
    `/green-prs`, `/port-upstream-*`) **MUST** check
    `gh issue list --repo diegosouzapw/OmniRoute --label release-freeze --state open` — if
    a freeze is active: **NEVER merge into the frozen `release/vX.Y.Z`**; resolve the
    ACTIVE development branch (highest `release/v*` by semver, normally `release/vX+1`,
    announced in a freeze-issue comment) and retarget the PR there (`gh pr edit <N> --base
    release/vX+1`, then VERIFY with `gh pr view <N> --json baseRefName` — the edit fails
    silently). **HOLD only when the highest release/v\* branch IS the frozen one** — leave
    the PR ready and open, tell the operator, resume when the next branch appears or the
    freeze lifts. Just-shipped fixes reach `release/vX+1` via the Phase 5 sync-back
    (`scripts/release/sync-next-cycle.mjs`); do not try to sync mid-release. The release
    captain's own reconciliation/cycle-open pushes are exempt — they _are_ the release.
    Post-merge read-only rule: land on `main` first (`fix/release-vX.Y.Z-*`). **⛔ ONLY
    `/generate-release` may raise a release-freeze, and ONLY at its Phase 0a — lifted at
    Phase 12c after the squash-merge to `main`.** No campaign, session, or agent may open
    a `release-freeze` marker at any other time. If a session ever believes a freeze is
    genuinely, unavoidably necessary outside the `/generate-release` flow, it **MUST
    first ask the operator (`diegosouzapw`) in chat, explicitly alert "estou criando um
    freeze" and get an explicit yes** — never open, extend, or re-open a `release-freeze`
    autonomously. Conversely, do **not** close/lift an active `/generate-release` freeze
    to unblock campaign merges: it protects the captain's single clean CI run and
    auto-lifts at Phase 12c. Verify a freeze is legitimate before acting on it: an open
    `release-freeze` whose title/body references an OPEN release PR
    (`gh pr view <N> --json state`) is the authorized captain freeze — hold, don't touch.
22. **Cross-session safety — this repo is worked by MANY parallel sessions/agents at once;
    never step on another's in-flight work.** Two absolute bans, both recurring incidents:
    - **(a) Never `git stash` / `git stash pop` — ANYWHERE in this repo, including inside
      an isolated worktree, and including inside any subagent you dispatch.** `git stash`
      operates on the **shared repository object store**, not the per-worktree working
      tree — so a stash pushed or popped in one session can silently clobber or resurrect
      another parallel session's uncommitted changes. To compare working changes against a
      base ref **without** stashing, use `git show <ref>:<path>` or `git diff <ref> --
      <path>`; to confirm a typecheck/lint error is pre-existing on the base, inspect the
      base ref directly (`git show origin/release/vX.Y.Z:<path>`) — never stash your tree
      away to "get it clean". **Put this ban verbatim in the prompt of every subagent
      that touches git** (agents don't inherit this file's context — the recurrence was a
      subagent).
    - **(b) Never merge, push, rebase, or force-push a PR / branch / worktree that another
      session is actively working.** An open PR whose head is a live fix worktree in
      `.claude/worktrees/` you did **not** create, or any branch another session owns, is
      **off-limits — HOLD**, and let the owning session merge it. **Before** merging or
      pushing to any PR you did not create _this_ session, run `git worktree list` to
      check for a matching in-flight worktree and re-check `gh pr view <N> --json
      state,headRefOid`. Only the owning session merges its own in-flight PR; mid-flight
      merges race the owner and re-trigger the exact commit/CHANGELOG races Rules #19 and
      #21 guard against.
23. **`_tasks/` é INTOCÁVEL como estrutura — append/edit-only.** É um repositório git
    SEPARADO (remote privado `diegosouzapw/_tasks_omniroute`) montado como diretório real na
    raiz do checkout principal. Regras absolutas: (a) NUNCA mover, renomear, deletar,
    esvaziar ou transformar `_tasks` em symlink; sessões só podem CRIAR ou EDITAR arquivos
    dentro dele; (b) NUNCA rastrear `_tasks` (nem como symlink) no repo principal — o blob
    rastreado foi a causa-raiz de DOIS wipes (2026-08-08 e 2026-08-10: `git reset --hard`
    materializou o symlink rastreado por cima do diretório real e o git apagou todo o
    conteúdo ignorado sem aviso); (c) após qualquer escrita relevante,
    `git -C _tasks add -A && git -C _tasks commit && git -C _tasks push` — o push frequente
    é o backup real; (d) repetir esta proibição VERBATIM no prompt de todo subagente que
    toque git; (e) se `_tasks` aparecer como symlink quebrado, NÃO commitar nada —
    restaurar do remote e avisar o operador. O gate `check:tracked-artifacts` (pre-commit
    + CI) bloqueia `_tasks` rastreado em qualquer forma.

---

## PII & Stream Sanitization Learnings

1. **ReDoS**: regex patterns matching variable-length strings (IPv6, credit cards, …) MUST
   use strictly bounded, non-overlapping sequences (e.g. `{1,7}`) to prevent catastrophic
   backtracking on untrusted input.
2. **SSE snapshot**: final-snapshot chunks (`done`/`completed`) MUST be sanitized as a
   standalone string (bypassing rolling delta buffers) to prevent text duplication.
3. **DB handles in tests**: any test triggering migrations / opening SQLite MUST call
   `resetDbInstance()` and close all DB handles in `test.after(...)` — Node's test runner
   hangs otherwise.

---

## Local development access

The dashboard is at the operator's chosen URL/port (default `http://localhost:20128`).
Credentials are operator-specific:

- **Initial admin password** is read from the `INITIAL_PASSWORD` env var on first install
  (defaults to `CHANGEME` in `.env.example`; rotate immediately after first login).
- **Local VPS / shared dev environments**: ask the operator for the URL and current
  credentials — they live in their personal vault, NOT in this repo.

> Any credential observed in a previous version of this file was a non-production demo
> value; treat it as compromised and do not reuse it.
