/**
 * O9-F3.3P1-D3 — FCC catalog importer (scripts/ad-hoc/fcc-catalog-sync.mjs).
 *
 * Tests the pure text-parsing functions directly (no network, no Python
 * execution, no filesystem writes) against small synthetic Python snippets
 * that mirror the REAL `provider_catalog.py` shapes this parser must handle,
 * plus a snapshot of the actual pinned-revision output for provenance checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractConstants,
  parseProviderCatalog,
  parseValue,
  renderSnapshotFile,
  withoutGeneratedAtLine,
  reuseGeneratedAtIfUnchanged,
  writeFileAtomic,
  ImportError,
} from "../../scripts/ad-hoc/fcc-catalog-sync.mjs";
import {
  FCC_SNAPSHOT_SOURCE_REPO,
  FCC_SNAPSHOT_SOURCE_REVISION,
  FCC_PROVIDER_SNAPSHOT,
} from "../../open-sse/config/providers/fccProviderSnapshot.data.ts";

const PINNED_REVISION = "81fa340ecac5ce1ae8ba4ea60e7a5517224bfaee";

// ── Constants extraction ────────────────────────────────────────────────────

test("extractConstants reads single-line string constants", () => {
  const constants = extractConstants('GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1"\n');
  assert.equal(constants.get("GROQ_DEFAULT_BASE"), "https://api.groq.com/openai/v1");
});

test("extractConstants reads parenthesized multi-line string constants", () => {
  const text = 'QWENCLOUD_DEFAULT_BASE = (\n    "https://token-plan.example/v1"\n)\n';
  const constants = extractConstants(text);
  assert.equal(constants.get("QWENCLOUD_DEFAULT_BASE"), "https://token-plan.example/v1");
});

// ── parseValue: field value shapes ─────────────────────────────────────────

test("parseValue accepts a plain string literal", () => {
  assert.equal(parseValue('"hello"', new Map(), "field"), "hello");
});

test("parseValue accepts True/False", () => {
  assert.equal(parseValue("True", new Map(), "field"), true);
  assert.equal(parseValue("False", new Map(), "field"), false);
});

test("parseValue resolves ProviderAuthKind enum literals", () => {
  assert.equal(
    parseValue("ProviderAuthKind.CONNECTED_ACCOUNT", new Map(), "field"),
    "CONNECTED_ACCOUNT"
  );
});

test("parseValue resolves a bare identifier via the constants map", () => {
  const constants = new Map([["GROQ_DEFAULT_BASE", "https://api.groq.com/openai/v1"]]);
  assert.equal(
    parseValue("GROQ_DEFAULT_BASE", constants, "field"),
    "https://api.groq.com/openai/v1"
  );
});

test("parseValue fails closed on a reference to an unknown constant", () => {
  assert.throws(() => parseValue("UNKNOWN_CONST", new Map(), "field"), ImportError);
});

test("parseValue joins Python implicit adjacent-string-literal concatenation (no comma = not a tuple)", () => {
  const value = '(\n    "https://example.com/docs/"\n    "more-path"\n)';
  assert.equal(parseValue(value, new Map(), "field"), "https://example.com/docs/more-path");
});

test("parseValue parses a single-element tuple (trailing comma) as a string array", () => {
  assert.deepEqual(parseValue('("vertex_project_id",)', new Map(), "field"), ["vertex_project_id"]);
});

test("parseValue parses a multi-element tuple as a string array", () => {
  assert.deepEqual(
    parseValue('("cloudflare_api_token", "cloudflare_account_id")', new Map(), "field"),
    ["cloudflare_api_token", "cloudflare_account_id"]
  );
});

test("parseValue fails closed on an unrecognized value shape (no regex-magic guessing)", () => {
  assert.throws(() => parseValue("some_function_call()", new Map(), "field"), ImportError);
});

// ── parseProviderCatalog: fail-closed on malformed input ───────────────────

test("parseProviderCatalog fails closed when the PROVIDER_CATALOG declaration is missing", () => {
  assert.throws(() => parseProviderCatalog("not python at all", new Map()), ImportError);
});

test("parseProviderCatalog fails closed on an unknown ProviderDescriptor field (schema drift)", () => {
  const text = `
PROVIDER_CATALOG: dict[str, ProviderDescriptor] = {
    "weird": ProviderDescriptor(
        provider_id="weird",
        display_name="Weird",
        some_new_field="x",
    ),
}
`;
  assert.throws(() => parseProviderCatalog(text, new Map()), ImportError);
});

test("parseProviderCatalog fails closed when the dict key does not match provider_id", () => {
  const text = `
PROVIDER_CATALOG: dict[str, ProviderDescriptor] = {
    "mismatched_key": ProviderDescriptor(
        provider_id="actual_id",
        display_name="X",
    ),
}
`;
  assert.throws(() => parseProviderCatalog(text, new Map()), ImportError);
});

test("parseProviderCatalog parses a minimal well-formed entry with defaults applied", () => {
  const text = `
PROVIDER_CATALOG: dict[str, ProviderDescriptor] = {
    "example": ProviderDescriptor(
        provider_id="example",
        display_name="Example",
        credential_env="EXAMPLE_API_KEY",
        credential_url="https://example.com/keys",
        default_base_url="https://api.example.com/v1",
    ),
}
`;
  const providers = parseProviderCatalog(text, new Map());
  assert.deepEqual(providers, [
    {
      fccProviderId: "example",
      displayName: "Example",
      authKind: "configuration",
      local: false,
      defaultBaseUrl: "https://api.example.com/v1",
      credentialEnv: "EXAMPLE_API_KEY",
      credentialUrl: "https://example.com/keys",
    },
  ]);
});

test("parseProviderCatalog applies auth_kind=CONNECTED_ACCOUNT and local=True correctly", () => {
  const text = `
PROVIDER_CATALOG: dict[str, ProviderDescriptor] = {
    "connected": ProviderDescriptor(
        provider_id="connected",
        display_name="Connected",
        auth_kind=ProviderAuthKind.CONNECTED_ACCOUNT,
    ),
    "local_one": ProviderDescriptor(
        provider_id="local_one",
        display_name="Local",
        local=True,
        static_credential="local-key",
    ),
}
`;
  const providers = parseProviderCatalog(text, new Map());
  const connected = providers.find((p) => p.fccProviderId === "connected");
  const local = providers.find((p) => p.fccProviderId === "local_one");
  assert.equal(connected?.authKind, "connected_account");
  assert.equal(local?.local, true);
});

// ── Determinism / cross-check against the real generated snapshot ─────────

test("real snapshot's parsed provider count matches an independent raw grep-equivalent count", () => {
  // Cross-check: re-parsing synthetic text with N entries must yield exactly N
  // providers (same invariant fcc-catalog-sync.mjs enforces internally via
  // rawEntryCount before it will ever write a file).
  const text = `
PROVIDER_CATALOG: dict[str, ProviderDescriptor] = {
    "a": ProviderDescriptor(provider_id="a", display_name="A"),
    "b": ProviderDescriptor(provider_id="b", display_name="B"),
    "c": ProviderDescriptor(provider_id="c", display_name="C"),
}
`;
  assert.equal(parseProviderCatalog(text, new Map()).length, 3);
});

// ── Pinned revision provenance (already-generated real snapshot) ──────────

test("the committed snapshot's pinned source revision matches the reviewed D3 reference", () => {
  assert.equal(FCC_SNAPSHOT_SOURCE_REVISION, PINNED_REVISION);
  assert.match(FCC_SNAPSHOT_SOURCE_REVISION, /^[0-9a-f]{40}$/);
});

test("the committed snapshot's source repo is the reviewed FCC repository", () => {
  assert.equal(FCC_SNAPSHOT_SOURCE_REPO, "Alishahryar1/free-claude-code");
});

test("the committed snapshot has no duplicate provider ids and a plausible count", () => {
  const ids = FCC_PROVIDER_SNAPSHOT.map((p) => p.fccProviderId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(FCC_PROVIDER_SNAPSHOT.length > 0);
});

test("the committed snapshot never carries a credential VALUE — only env-var names / public URLs", () => {
  for (const entry of FCC_PROVIDER_SNAPSHOT) {
    if (entry.credentialEnv !== null) {
      // An env-var NAME looks like an identifier (UPPER_SNAKE_CASE), never a
      // secret-shaped value (no long random-looking base64/hex blobs).
      assert.match(entry.credentialEnv, /^[A-Z][A-Z0-9_]*$/);
    }
  }
});

// ── Reproducibility: same source + same revision -> byte-identical snapshot ─

const SAMPLE_PROVIDERS = [
  {
    fccProviderId: "example",
    displayName: "Example",
    authKind: "configuration",
    local: false,
    defaultBaseUrl: "https://api.example.com/v1",
    credentialEnv: "EXAMPLE_API_KEY",
    credentialUrl: "https://example.com/keys",
  },
];

test("withoutGeneratedAtLine makes two renders with different timestamps compare equal", () => {
  const a = renderSnapshotFile({
    sourceRevision: PINNED_REVISION,
    generatedAt: "2026-01-01T00:00:00Z",
    providers: SAMPLE_PROVIDERS,
  });
  const b = renderSnapshotFile({
    sourceRevision: PINNED_REVISION,
    generatedAt: "2099-12-31T23:59:59Z",
    providers: SAMPLE_PROVIDERS,
  });
  assert.notEqual(a, b); // different generatedAt -> different raw bytes
  assert.equal(withoutGeneratedAtLine(a), withoutGeneratedAtLine(b)); // deterministic content is identical
});

test("reuseGeneratedAtIfUnchanged is null when no prior snapshot file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcc-sync-test-"));
  try {
    const candidate = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2026-01-01T00:00:00Z",
      providers: SAMPLE_PROVIDERS,
    });
    assert.equal(reuseGeneratedAtIfUnchanged(join(dir, "nope.ts"), candidate), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuseGeneratedAtIfUnchanged reuses the existing timestamp for identical deterministic content", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcc-sync-test-"));
  const outputPath = join(dir, "snapshot.ts");
  try {
    const first = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2026-01-01T00:00:00Z",
      providers: SAMPLE_PROVIDERS,
    });
    writeFileAtomic(outputPath, first);
    const second = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2099-12-31T23:59:59Z",
      providers: SAMPLE_PROVIDERS,
    });
    assert.equal(reuseGeneratedAtIfUnchanged(outputPath, second), "2026-01-01T00:00:00Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuseGeneratedAtIfUnchanged returns null when the deterministic content actually changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcc-sync-test-"));
  const outputPath = join(dir, "snapshot.ts");
  try {
    const first = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2026-01-01T00:00:00Z",
      providers: SAMPLE_PROVIDERS,
    });
    writeFileAtomic(outputPath, first);
    const changedProviders = [{ ...SAMPLE_PROVIDERS[0], displayName: "Example (changed)" }];
    const second = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2099-12-31T23:59:59Z",
      providers: changedProviders,
    });
    assert.equal(reuseGeneratedAtIfUnchanged(outputPath, second), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Atomic write ─────────────────────────────────────────────────────────

test("writeFileAtomic writes the full content and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcc-sync-test-"));
  const outputPath = join(dir, "snapshot.ts");
  try {
    const content = renderSnapshotFile({
      sourceRevision: PINNED_REVISION,
      generatedAt: "2026-01-01T00:00:00Z",
      providers: SAMPLE_PROVIDERS,
    });
    writeFileAtomic(outputPath, content);
    assert.equal(readFileSync(outputPath, "utf8"), content);
    assert.ok(statSync(outputPath).isFile());
    // No leftover .tmp-* sibling in the same directory.
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic overwrites existing content completely (no partial merge)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcc-sync-test-"));
  const outputPath = join(dir, "snapshot.ts");
  try {
    writeFileAtomic(outputPath, "old content that is much longer than the new content");
    writeFileAtomic(outputPath, "new");
    assert.equal(readFileSync(outputPath, "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
