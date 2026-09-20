/**
 * O9-F3.5 A7.1 "R2.2" — passive-discovery authorization-namespace fix.
 *
 * R2.1's live proof against Shadow got `403 AUTH_SCOPE` on
 * `POST /api/providers/passive-model-discovery`: `/api/providers/*` is in
 * `ADMIN_MUTATION_PREFIXES` (`src/server/authz/accessScopes.ts`), so every
 * mutating verb under it — including this non-mutating catalog read — is
 * classified `admin`, which Jarvis's `write`-scope management credential does
 * not hold. R2.2 moves the route to `/api/provider-observations/*`, a plain
 * MANAGEMENT surface outside that prefix, so the same credential works
 * without granting Jarvis (or anyone) admin.
 *
 * This file proves the authorization boundary only. Route behavior (catalog
 * parsing, zero-write, zero-inference, connection isolation, R1/R2 merge) is
 * proven in `passiveModelDiscoveryR2.test.ts` and
 * `shadowControlPlaneAdapterR2.test.ts`, both updated in R2.2 to import from
 * the new path and unchanged in substance.
 *
 * Integration: isolated DATA_DIR + real access-tokens DB, same pattern as
 * `require-management-auth-access-token.test.ts`. DB handle closed in
 * `test.after`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-obs-auth-boundary-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "test-pass";

const core = await import("../../src/lib/db/core.ts");
const at = await import("../../src/lib/db/accessTokens.ts");
const { requireManagementAuth } = await import("../../src/lib/api/requireManagementAuth.ts");
const { inferRequiredScope, ADMIN_MUTATION_PREFIXES, ADMIN_SCOPE_PREFIXES } =
  await import("../../src/server/authz/accessScopes.ts");

const BASE = "http://localhost:20128";
const NEW_ROUTE = "/api/provider-observations/passive-model-discovery";
const OLD_ROUTE = "/api/providers/passive-model-discovery";

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
// A. old route no longer authoritative / O. adapter uses only the new route
// ---------------------------------------------------------------------------

test("A: the old /api/providers/passive-model-discovery route file no longer exists", () => {
  const oldRouteFile = path.join(
    process.cwd(),
    "src/app/api/providers/passive-model-discovery/route.ts"
  );
  const oldCoreFile = path.join(
    process.cwd(),
    "src/app/api/providers/passive-model-discovery/passiveModelDiscovery.ts"
  );
  assert.equal(fs.existsSync(oldRouteFile), false, "old route.ts must be removed, not shimmed");
  assert.equal(
    fs.existsSync(oldCoreFile),
    false,
    "old core module must be removed, not duplicated"
  );

  const newRouteFile = path.join(
    process.cwd(),
    "src/app/api/provider-observations/passive-model-discovery/route.ts"
  );
  const newCoreFile = path.join(
    process.cwd(),
    "src/app/api/provider-observations/passive-model-discovery/passiveModelDiscovery.ts"
  );
  assert.equal(fs.existsSync(newRouteFile), true, "new route.ts must exist");
  assert.equal(fs.existsSync(newCoreFile), true, "new core module must exist");
});

test("A: the new route module exports a POST handler", async () => {
  const routeModule =
    await import("../../src/app/api/provider-observations/passive-model-discovery/route.ts");
  assert.equal(typeof routeModule.POST, "function");
});

test("O: the Shadow adapter references only the new route, never the old one", () => {
  const adapterSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/failover/shadowControlPlaneAdapter.ts"),
    "utf8"
  );
  assert.equal(
    adapterSource.includes(OLD_ROUTE),
    false,
    "adapter must not reference the old provider-admin passive-discovery path"
  );
  assert.ok(
    adapterSource.includes(NEW_ROUTE),
    "adapter must call the new provider-observations passive-discovery path"
  );
});

// ---------------------------------------------------------------------------
// G. ADMIN_MUTATION_PREFIXES / ADMIN_SCOPE_PREFIXES remain unchanged
// ---------------------------------------------------------------------------

test("G: ADMIN_MUTATION_PREFIXES still governs only /api/providers and /api/cli-tools/apply", () => {
  assert.deepEqual([...ADMIN_MUTATION_PREFIXES], ["/api/providers", "/api/cli-tools/apply"]);
  assert.equal(
    ADMIN_MUTATION_PREFIXES.some((p: string) => NEW_ROUTE === p || NEW_ROUTE.startsWith(p + "/")),
    false,
    "the new observation route must not fall under the provider-admin mutation prefix"
  );
  assert.equal(
    ADMIN_SCOPE_PREFIXES.some((p: string) => NEW_ROUTE === p || NEW_ROUTE.startsWith(p + "/")),
    false,
    "the new observation route must not fall under any always-admin prefix"
  );
});

test("G: inferRequiredScope classifies the new route as a plain mutation (write), the old prefix stays admin", () => {
  assert.equal(inferRequiredScope("POST", NEW_ROUTE), "write");
  assert.equal(inferRequiredScope("GET", NEW_ROUTE), "read");
  // Unchanged pre-existing behavior for the /api/providers/* prefix itself.
  assert.equal(inferRequiredScope("POST", "/api/providers"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/providers/some-conn"), "admin");
  assert.equal(inferRequiredScope("GET", "/api/providers"), "read");
});

// ---------------------------------------------------------------------------
// B/E. unauthenticated denied
// ---------------------------------------------------------------------------

test("B/E: an unauthenticated POST to the new route is denied", async () => {
  const denied = await requireManagementAuth(req("POST", NEW_ROUTE));
  assert.ok(denied, "expected a rejection Response");
  assert.equal(denied?.status, 401);
});

// ---------------------------------------------------------------------------
// C/D. manage-scoped (write) machine credential allowed; admin not required
// ---------------------------------------------------------------------------

test("C/D: a write-scope access token (Jarvis's management credential) is allowed on the new route without admin", async () => {
  const { secret } = at.createAccessToken({ name: "jarvis-shadow-mgmt", scope: "write" });
  assert.equal(await requireManagementAuth(req("POST", NEW_ROUTE, secret)), null);
});

test("D: an admin-scope token is also allowed (superset), proving admin is sufficient but not exclusively required", async () => {
  const { secret } = at.createAccessToken({ name: "admin-tok", scope: "admin" });
  assert.equal(await requireManagementAuth(req("POST", NEW_ROUTE, secret)), null);
});

// ---------------------------------------------------------------------------
// F. client/inference-only (read-scope) credential denied
// ---------------------------------------------------------------------------

test("F: a read-scope (client/inspect-only) access token is denied on the new route", async () => {
  const { secret } = at.createAccessToken({ name: "read-only-client", scope: "read" });
  const denied = await requireManagementAuth(req("POST", NEW_ROUTE, secret));
  assert.ok(denied, "expected a rejection Response");
  assert.equal(denied?.status, 403);
});

test("F: no credential at all is denied (401), same as any other management route", async () => {
  const denied = await requireManagementAuth(req("POST", NEW_ROUTE));
  assert.equal(denied?.status, 401);
});

// ---------------------------------------------------------------------------
// H. provider-admin mutation routes remain admin-only (regression proof)
// ---------------------------------------------------------------------------

test("H: a write-scope token is still rejected on real /api/providers/* mutations (unchanged)", async () => {
  const { secret } = at.createAccessToken({ name: "write-tok-2", scope: "write" });
  assert.equal((await requireManagementAuth(req("POST", "/api/providers", secret)))?.status, 403);
  assert.equal(
    (await requireManagementAuth(req("DELETE", "/api/providers/some-conn", secret)))?.status,
    403
  );
});

test("H: only an admin-scope token can mutate /api/providers/* (unchanged)", async () => {
  const { secret } = at.createAccessToken({ name: "admin-tok-2", scope: "admin" });
  assert.equal(await requireManagementAuth(req("POST", "/api/providers", secret)), null);
  assert.equal(
    await requireManagementAuth(req("DELETE", "/api/providers/some-conn", secret)),
    null
  );
});

test("H: GET /api/providers (read) still only needs read scope, unaffected by the R2.2 move", async () => {
  const { secret } = at.createAccessToken({ name: "read-tok-2", scope: "read" });
  assert.equal(await requireManagementAuth(req("GET", "/api/providers", secret)), null);
});
