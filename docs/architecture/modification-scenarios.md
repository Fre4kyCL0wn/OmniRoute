# Common Modification Scenarios — Full Procedure Reference

Detailed steps for the scenarios listed in AGENTS.md. Keep the AGENTS.md summary
intact; this file holds the full procedure for each pattern.

---

## Adding a New Provider

0. Check `docs/reference/REMOVED_PROVIDERS.md` — providers removed at operator's request
   must never be reintroduced (guarded by `tests/unit/removed-providers-blocklist.test.ts`).
1. Register in `src/shared/constants/providers.ts` (Zod-validated at load).
2. Add executor in `open-sse/executors/` if custom logic needed (extend `BaseExecutor`).
3. Add translator in `open-sse/translator/` if non-OpenAI format.
4. Add OAuth config in `src/lib/oauth/constants/oauth.ts` if OAuth-based. If the
   upstream CLI ships a public client_id/secret, embed via `resolvePublicCred()`
   (`open-sse/utils/publicCreds.ts`) — never as a string literal (Hard Rule #11).
5. Register models in `open-sse/config/providerRegistry.ts`.
6. Write tests in `tests/unit/` (assert the publicCreds shape if you added a new
   embedded default).

## Adding a New API Route

1. Create directory under `src/app/api/v1/your-route/`.
2. Create `route.ts` with `GET`/`POST` handlers.
3. Pattern: CORS → Zod body validation → optional auth → API key policy enforcement →
   handler delegation (open-sse). **No global Next.js middleware**.
4. Handler goes in `open-sse/handlers/` (import from there, not inline).
5. Error responses via `buildErrorBody()` / `errorResponse()`
   (`open-sse/utils/error.ts`) — never raw `err.stack`/`err.message` in body
   (Hard Rule #12).
6. Tests, including at least one assertion that error responses do not leak stack
   traces (`!body.error.message.includes("at /")`).

## Adding a New DB Module

1. Create `src/lib/db/yourModule.ts` — import `getDbInstance` from `./core.ts`.
2. Export CRUD functions for your domain table(s).
3. Add migration in `src/lib/db/migrations/` if new tables needed.
4. Write tests.

## Adding a New MCP Tool

1. Add tool definition in `open-sse/mcp-server/tools/` with Zod input schema +
   async handler.
2. Register in tool set (wired by `createMcpServer()`).
3. Assign to appropriate scope(s).
4. Write tests (tool invocation logged to `mcp_tool_audit` table).

## Adding a New A2A Skill

Six exist: smart-routing, quota-management, provider-discovery, cost-analysis,
health-report, list-capabilities.

1. Create skill in `src/lib/a2a/skills/`.
2. Skill receives task context (messages, metadata) → returns structured result.
3. Register in `A2A_SKILL_HANDLERS` in `src/lib/a2a/taskExecution.ts`.
4. Expose in `src/app/.well-known/agent.json/route.ts` (Agent Card).
5. Write tests in `tests/unit/`.
6. Document in `docs/frameworks/A2A-SERVER.md` skill table.

## Adding a New Cloud Agent

Four exist: codex-cloud, devin, jules, cursor-cloud.

1. Create agent class in `src/lib/cloudAgent/agents/` extending `CloudAgentBase`.
2. Implement `createTask`, `getStatus`, `approvePlan`, `sendMessage`, `listSources`.
3. Register in `src/lib/cloudAgent/registry.ts`.
4. Add OAuth/credentials handling if needed (`src/lib/oauth/providers/`).
5. Tests + document in `docs/frameworks/CLOUD_AGENT.md`.

## Adding a New Embedded Service

Full guide: `docs/frameworks/EMBEDDED-SERVICES.md`.

1. Installer in `src/lib/services/installers/{name}.ts` modeled on `ninerouter.ts`
   (use `runNpm` from `installers/utils.ts` — no shell interpolation, Hard Rule #13).
2. Register in `src/lib/services/bootstrap.ts` (`SERVICES[]` array +
   `buildSpawnArgsFactory()`).
3. DB seed row: `version_manager` table (`status='not_installed'`, `auto_start=0`).
4. 8 API endpoints under `src/app/api/services/{name}/`:
   `_lib.ts`, `install`, `start`, `stop`, `restart`, `update`, `status`,
   `auto-start`, `auto-restart-adopted`. Shared `logs` via `[name]/logs/route.ts`.
   All errors via `createErrorResponse()`.
5. Verify `/api/services/` is in `LOCAL_ONLY_API_PREFIXES` in
   `src/server/authz/routeGuard.ts`; add test asserting `isLocalOnlyPath()` returns
   `true` for new prefix (Hard Rule #17).
6. UI tab in `src/app/(dashboard)/dashboard/providers/services/tabs/` reusing
   `ServiceStatusCard`, `ServiceLifecycleButtons`, `ServiceLogsPanel`.
7. Document in `docs/frameworks/EMBEDDED-SERVICES.md` (§1 service table + §4 API)
   and `docs/openapi.yaml`.
8. Tests: unit (`tests/unit/services/`), integration (`tests/integration/services/`,
   gated by `RUN_SERVICES_INT=1`), update `docs/ops/RELEASE_CHECKLIST.md` smoke.

## Adding a Guardrail / Eval / Skill / Webhook / Log-export Destination

| What              | Code location                                           | Docs                              |
| ----------------- | ------------------------------------------------------- | --------------------------------- |
| Guardrail         | `src/lib/guardrails/`                                  | `docs/security/GUARDRAILS.md`     |
| Eval suite        | `src/lib/evals/`                                       | `docs/frameworks/EVALS.md`        |
| Skill (sandbox)   | `src/lib/skills/`                                      | `docs/frameworks/SKILLS.md`       |
| Webhook event     | `src/lib/webhookDispatcher.ts`                          | `docs/frameworks/WEBHOOKS.md`     |
| Log-export dest.  | `src/lib/logExport/destinations/<name>.ts` + registry line | `docs/frameworks/LOG-EXPORT.md` |

For log-export: runner, REST layer and dashboard form all read the registry — nothing
else changes.
