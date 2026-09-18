/**
 * O9-F3.5 A7.1 "R4.2" — `/api/provider-observations/activate-model` auth boundary.
 *
 * Same reasoning and pattern as `observationAuthBoundaryR22.test.ts`: this
 * route lives under `/api/provider-observations/*`, not `/api/providers/*`,
 * so it is never classified by `ADMIN_MUTATION_PREFIXES`
 * (`src/server/authz/accessScopes.ts`) — a plain `write`-scope management
 * credential (Jarvis's own) is sufficient, admin is never required, and an
 * unauthenticated or read-scope (client/inference-only) credential is
 * denied. Route behavior (orchestration, approval gating, writer, rollback)
 * is proven in `activationOrchestratorR4_2.test.ts`; this file proves only
 * the authorization boundary.
 *
 * Integration: isolated DATA_DIR + real access-tokens DB, same pattern as
 * `observationAuthBoundaryR22.test.ts` / `require-management-auth-access-
 * token.test.ts`. DB handle closed in `test.after`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-activate-model-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "test-pass";

const core = await import("../../src/lib/db/core.ts");
const at = await import("../../src/lib/db/accessTokens.ts");
const { requireManagementAuth } = await import("../../src/lib/api/requireManagementAuth.ts");
const { inferRequiredScope, ADMIN_MUTATION_PREFIXES, ADMIN_SCOPE_PREFIXES } =
  await import("../../src/server/authz/accessScopes.ts");

const BASE = "http://localhost:20128";
const ROUTE = "/api/provider-observations/activate-model";

function req(method: string, pathname: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${BASE}${pathname}`, { method, headers });
}

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  delete process.env.INITIAL_PASSWORD;
});

// ---------------------------------------------------------------------------
// route exists and exports POST
// ---------------------------------------------------------------------------

test("the route file exists and exports a POST handler", async () => {
  const routeFile = path.join(
    process.cwd(),
    "src/app/api/provider-observations/activate-model/route.ts"
  );
  assert.equal(fs.existsSync(routeFile), true, "route.ts must exist");
  const routeModule =
    await import("../../src/app/api/provider-observations/activate-model/route.ts");
  assert.equal(typeof routeModule.POST, "function");
});

// ---------------------------------------------------------------------------
// namespace: never falls under /api/providers/* admin prefixes
// ---------------------------------------------------------------------------

test("the route must not fall under ADMIN_MUTATION_PREFIXES or ADMIN_SCOPE_PREFIXES", () => {
  assert.equal(
    ADMIN_MUTATION_PREFIXES.some((p: string) => ROUTE === p || ROUTE.startsWith(p + "/")),
    false,
    "must not fall under the provider-admin mutation prefix"
  );
  assert.equal(
    ADMIN_SCOPE_PREFIXES.some((p: string) => ROUTE === p || ROUTE.startsWith(p + "/")),
    false,
    "must not fall under any always-admin prefix"
  );
});

test("inferRequiredScope classifies POST as a plain mutation (write), not admin", () => {
  assert.equal(inferRequiredScope("POST", ROUTE), "write");
  assert.equal(inferRequiredScope("GET", ROUTE), "read");
});

// ---------------------------------------------------------------------------
// A. unauthenticated -> denied
// ---------------------------------------------------------------------------

test("A: an unauthenticated POST is denied (401)", async () => {
  const denied = await requireManagementAuth(req("POST", ROUTE));
  assert.ok(denied, "expected a rejection Response");
  assert.equal(denied?.status, 401);
});

// ---------------------------------------------------------------------------
// B. client/inference-only (read-scope) credential -> denied
// ---------------------------------------------------------------------------

test("B: a read-scope (client/inspect-only) access token is denied (403)", async () => {
  const { secret } = at.createAccessToken({ name: "read-only-client", scope: "read" });
  const denied = await requireManagementAuth(req("POST", ROUTE, secret));
  assert.ok(denied, "expected a rejection Response");
  assert.equal(denied?.status, 403);
});

// ---------------------------------------------------------------------------
// C. management (write-scope) credential -> allowed
// ---------------------------------------------------------------------------

test("C: a write-scope access token (Jarvis's management credential) is allowed", async () => {
  const { secret } = at.createAccessToken({ name: "jarvis-shadow-mgmt", scope: "write" });
  assert.equal(await requireManagementAuth(req("POST", ROUTE, secret)), null);
});

// ---------------------------------------------------------------------------
// D. admin not required (but an admin token is still a valid superset)
// ---------------------------------------------------------------------------

test("D: an admin-scope token is also allowed — admin is sufficient but never exclusively required", async () => {
  const { secret } = at.createAccessToken({ name: "admin-tok", scope: "admin" });
  assert.equal(await requireManagementAuth(req("POST", ROUTE, secret)), null);
});

// ---------------------------------------------------------------------------
// E. provider-admin namespace unchanged (regression proof)
// ---------------------------------------------------------------------------

test("E: /api/providers/* mutation still requires admin, unaffected by this route's existence", async () => {
  const { secret } = at.createAccessToken({ name: "write-tok-2", scope: "write" });
  assert.equal((await requireManagementAuth(req("POST", "/api/providers", secret)))?.status, 403);
  assert.equal(
    (await requireManagementAuth(req("DELETE", "/api/providers/some-conn", secret)))?.status,
    403
  );
  const { secret: adminSecret } = at.createAccessToken({ name: "admin-tok-2", scope: "admin" });
  assert.equal(await requireManagementAuth(req("POST", "/api/providers", adminSecret)), null);
});

// ---------------------------------------------------------------------------
// unauthenticated at the actual HTTP handler (not just requireManagementAuth
// in isolation) — proves the route itself enforces the guard, not merely
// that the shared helper does.
// ---------------------------------------------------------------------------

test("the POST handler itself returns 401 for an unauthenticated request", async () => {
  const { POST } = await import("../../src/app/api/provider-observations/activate-model/route.ts");
  const response = await POST(req("POST", ROUTE, undefined) as unknown as Request);
  assert.equal(response.status, 401);
});
