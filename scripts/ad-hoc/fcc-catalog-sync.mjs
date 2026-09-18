#!/usr/bin/env node
/**
 * O9-F3.3P1-D3 — FCC upstream provider-catalog importer.
 *
 * Reads a LOCAL, already-checked-out copy of
 * https://github.com/Alishahryar1/free-claude-code (never fetched by this
 * script — no network calls happen here) and extracts the static
 * `PROVIDER_CATALOG` dict from
 * `src/free_claude_code/config/provider_catalog.py` into a normalized Jarvis
 * snapshot data file.
 *
 * Safety contract (O9-F3.3P1-D3 Schritt 10):
 *   - No network access in this script.
 *   - No execution of any FCC code: the `.py` file is read and parsed as
 *     plain text only — no `eval`, no `child_process` invoking python, no
 *     dynamic `import()` of the FCC checkout.
 *   - A narrow, purpose-built parser for the DOCUMENTED `ProviderDescriptor`
 *     dataclass shape — not a generic Python expression evaluator. Any
 *     field value this parser does not recognize aborts the whole import
 *     (fail-closed) rather than silently emitting wrong data.
 *   - Non-zero exit on any parse failure; the existing committed snapshot
 *     file is left untouched on failure (last-known-good) — parsing and
 *     validation complete fully in-memory BEFORE any write is attempted.
 *   - The final write is atomic (write to a sibling temp file, then
 *     `renameSync` over the target — atomic on POSIX filesystems): a crash
 *     mid-write can only leave a stray temp file, never a truncated target.
 *   - Reproducible: the same --source tree + same --revision produce
 *     byte-identical output. If the freshly-parsed content is identical to
 *     what is already committed (ignoring the generatedAt timestamp), the
 *     existing generatedAt is reused and the file is not rewritten at all —
 *     a true no-op re-run, not just "same provider facts, different bytes".
 *   - No credential VALUES are ever read or written — only credential ENV
 *     VAR NAMES (e.g. "GROQ_API_KEY") and public credential-signup URLs are
 *     treated as informative metadata.
 *
 * Usage:
 *   node scripts/ad-hoc/fcc-catalog-sync.mjs --source <path-to-fcc-checkout> [--revision <sha>]
 *
 * `--source` must be a local directory containing the FCC checkout (already
 * cloned and checked out to the desired commit by the caller — this script
 * does not clone or fetch). `--revision` is optional; when given, it is
 * cross-checked against `git -C <source> rev-parse HEAD` and the import
 * aborts on any mismatch.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

const RELATIVE_CATALOG_PATH = "src/free_claude_code/config/provider_catalog.py";
const OUTPUT_PATH = resolve("open-sse/config/providers/fccProviderSnapshot.data.ts");
const SCHEMA_VERSION = "1.0.0";
const SOURCE_REPO = "Alishahryar1/free-claude-code";

/** dataclass field defaults from `ProviderDescriptor` (provider_catalog.py). */
const FIELD_DEFAULTS = {
  auth_kind: "CONFIGURATION",
  local: false,
  credential_env: null,
  credential_url: null,
  credential_attr: null,
  static_credential: null,
  default_base_url: null,
  base_url_attr: null,
  proxy_attr: null,
  required_settings_attrs: [],
};

const KNOWN_FIELDS = new Set([
  "provider_id",
  "display_name",
  "auth_kind",
  "local",
  "credential_env",
  "credential_url",
  "credential_attr",
  "static_credential",
  "default_base_url",
  "base_url_attr",
  "proxy_attr",
  "required_settings_attrs",
]);

class ImportError extends Error {}

function parseArgs(argv) {
  const args = { source: null, revision: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--revision") args.revision = argv[++i];
  }
  if (!args.source) {
    throw new ImportError("--source <path-to-fcc-checkout> is required");
  }
  return args;
}

function resolveRevision(sourceDir, requestedRevision) {
  let headRevision;
  try {
    headRevision = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    throw new ImportError(`could not read git HEAD of --source (${sourceDir}): ${err.message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(headRevision)) {
    throw new ImportError(`--source HEAD is not a full git SHA: ${headRevision}`);
  }
  if (requestedRevision && requestedRevision !== headRevision) {
    throw new ImportError(
      `--revision ${requestedRevision} does not match --source HEAD ${headRevision} — ` +
        "checkout the pinned revision before importing"
    );
  }
  return headRevision;
}

/** Extract top-level `NAME = "value"` / `NAME = (\n "value"\n)` constants. */
function extractConstants(text) {
  const constants = new Map();
  const singleLine = /^([A-Z][A-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm;
  for (const match of text.matchAll(singleLine)) {
    constants.set(match[1], unescapeString(match[2]));
  }
  const multiLine = /^([A-Z][A-Z0-9_]*)\s*=\s*\(\s*\n\s*"((?:[^"\\]|\\.)*)"\s*\n\s*\)\s*$/gm;
  for (const match of text.matchAll(multiLine)) {
    constants.set(match[1], unescapeString(match[2]));
  }
  return constants;
}

function unescapeString(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => (ch === "n" ? "\n" : ch));
}

/** Find the matching closing bracket for `openChar`/`closeChar`, honoring string quoting. */
function findMatchingBracket(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split top-level `key=value` args on commas, honoring string/tuple nesting. */
function splitTopLevelArgs(text) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += text[++i] ?? "";
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseValue(rawValue, constants, fieldName) {
  const value = rawValue.trim();
  const stringMatch = value.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (stringMatch) return unescapeString(stringMatch[1]);
  if (value === "True") return true;
  if (value === "False") return false;
  const authKindMatch = value.match(/^ProviderAuthKind\.([A-Z_]+)$/);
  if (authKindMatch) return authKindMatch[1];
  const parenMatch = value.match(/^\(([\s\S]*)\)$/);
  if (parenMatch) {
    const inner = parenMatch[1].trim();
    if (inner === "") return [];
    if (!inner.includes(",")) {
      // Python implicit adjacent-string-literal concatenation, e.g.
      //   credential_url=(
      //       "https://.../"
      //       "more-path"
      //   )
      // — parens used only for line continuation, not a tuple (no comma).
      const literalRe = /"((?:[^"\\]|\\.)*)"/g;
      const literals = [...inner.matchAll(literalRe)];
      const reconstructed = literals.map((m) => m[0]).join("");
      if (literals.length > 0 && reconstructed.replace(/\s+/g, "") === inner.replace(/\s+/g, "")) {
        return literals.map((m) => unescapeString(m[1])).join("");
      }
    }
    const items = splitTopLevelArgs(inner).map((item) => item.trim());
    const strings = items.map((item) => {
      const m = item.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!m) {
        throw new ImportError(
          `field ${fieldName}: unrecognized tuple item ${JSON.stringify(item)}`
        );
      }
      return unescapeString(m[1]);
    });
    return strings;
  }
  const identMatch = value.match(/^([A-Z][A-Z0-9_]*)$/);
  if (identMatch) {
    if (!constants.has(identMatch[1])) {
      throw new ImportError(`field ${fieldName}: reference to unknown constant ${identMatch[1]}`);
    }
    return constants.get(identMatch[1]);
  }
  throw new ImportError(
    `field ${fieldName}: unrecognized value shape ${JSON.stringify(value)} — ` +
      "refusing to guess; parser needs an explicit rule for this shape"
  );
}

function parseProviderCatalog(text, constants) {
  const declMatch = text.match(/PROVIDER_CATALOG\s*:\s*dict\[str,\s*ProviderDescriptor\]\s*=\s*\{/);
  if (!declMatch) {
    throw new ImportError("could not locate the PROVIDER_CATALOG dict declaration");
  }
  const openBraceIndex = declMatch.index + declMatch[0].length - 1;
  const closeBraceIndex = findMatchingBracket(text, openBraceIndex, "{", "}");
  if (closeBraceIndex === -1) {
    throw new ImportError("could not find the matching closing brace for PROVIDER_CATALOG");
  }
  const body = text.slice(openBraceIndex + 1, closeBraceIndex);

  const entryHeader = /"([a-z0-9_]+)"\s*:\s*ProviderDescriptor\(/g;
  const rawEntryCount = (body.match(/ProviderDescriptor\(/g) ?? []).length;

  const providers = [];
  let match;
  while ((match = entryHeader.exec(body)) !== null) {
    const key = match[1];
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findMatchingBracket(body, openParenIndex, "(", ")");
    if (closeParenIndex === -1) {
      throw new ImportError(`provider ${key}: could not find matching ')' for ProviderDescriptor(`);
    }
    const argsText = body.slice(openParenIndex + 1, closeParenIndex);
    const fields = { ...FIELD_DEFAULTS };
    for (const argPart of splitTopLevelArgs(argsText)) {
      const eqIndex = argPart.indexOf("=");
      if (eqIndex === -1) {
        throw new ImportError(
          `provider ${key}: expected key=value, got ${JSON.stringify(argPart)}`
        );
      }
      const fieldName = argPart.slice(0, eqIndex).trim();
      if (!KNOWN_FIELDS.has(fieldName)) {
        throw new ImportError(
          `provider ${key}: unknown ProviderDescriptor field ${fieldName} — ` +
            "the upstream dataclass shape may have changed; update the parser deliberately, not silently"
        );
      }
      fields[fieldName] = parseValue(argPart.slice(eqIndex + 1), constants, `${key}.${fieldName}`);
    }
    if (fields.provider_id !== key) {
      throw new ImportError(
        `provider ${key}: dict key does not match provider_id=${fields.provider_id}`
      );
    }
    providers.push({
      fccProviderId: fields.provider_id,
      displayName: fields.display_name,
      authKind: fields.auth_kind === "CONNECTED_ACCOUNT" ? "connected_account" : "configuration",
      local: fields.local,
      defaultBaseUrl: fields.default_base_url,
      credentialEnv: fields.credential_env,
      credentialUrl: fields.credential_url,
    });
    entryHeader.lastIndex = closeParenIndex + 1;
  }

  if (providers.length !== rawEntryCount) {
    throw new ImportError(
      `parsed ${providers.length} providers but found ${rawEntryCount} ` +
        "'ProviderDescriptor(' occurrences — the parser missed or double-counted an entry"
    );
  }
  const ids = new Set(providers.map((p) => p.fccProviderId));
  if (ids.size !== providers.length) {
    throw new ImportError(
      "duplicate fccProviderId values parsed — refusing to emit an ambiguous snapshot"
    );
  }
  return providers;
}

function renderSnapshotFile({ sourceRevision, generatedAt, providers }) {
  const header = `// AUTO-GENERATED — DO NOT EDIT.
//
// Generated by scripts/ad-hoc/fcc-catalog-sync.mjs from a local, pinned
// checkout of https://github.com/${SOURCE_REPO} — this file contains ONLY
// normalized provider-descriptor DATA parsed as text from
// \`${RELATIVE_CATALOG_PATH}\`. No FCC code was executed, imported, or copied.
//
// This is the FCC static PROVIDER catalog (connection metadata: id, display
// name, auth kind, default base URL, credential env-var NAME + signup URL).
// It is NOT a model catalog — see docs/architecture/PROVIDER_RUNTIME_STATE.md
// -> "D3 FCC Upstream Catalog Snapshot" for why FCC's actual model lists are
// discovered dynamically at FCC's own runtime, not embedded here.
//
// No credential VALUES were read or stored — credentialEnv is the upstream
// env-var NAME only (e.g. "GROQ_API_KEY"); Jarvis uses its own credential
// infrastructure regardless of this field.
//
// To refresh: check out the desired FCC revision locally, then run
//   npm run o9:fcc:sync -- --source <path> --revision <sha>
// A parse failure leaves this file untouched (last-known-good).

export interface FccProviderSnapshotEntry {
  fccProviderId: string;
  displayName: string;
  authKind: "configuration" | "connected_account";
  local: boolean;
  defaultBaseUrl: string | null;
  /** Upstream credential env-var NAME only — never a value. */
  credentialEnv: string | null;
  credentialUrl: string | null;
}

export const FCC_SNAPSHOT_SCHEMA_VERSION = "${SCHEMA_VERSION}";
export const FCC_SNAPSHOT_SOURCE_REPO = "${SOURCE_REPO}";
export const FCC_SNAPSHOT_SOURCE_REVISION = "${sourceRevision}";
export const FCC_SNAPSHOT_GENERATED_AT = "${generatedAt}";

export const FCC_PROVIDER_SNAPSHOT: readonly FccProviderSnapshotEntry[] = ${JSON.stringify(
    providers,
    null,
    2
  )};
`;
  return header;
}

const GENERATED_AT_LINE_RE = /^export const FCC_SNAPSHOT_GENERATED_AT = ".*";$/m;

/** Strip the (intentionally wall-clock, non-deterministic) timestamp line so
 * two renders can be compared on their DETERMINISTIC content only. */
function withoutGeneratedAtLine(rendered) {
  return rendered.replace(GENERATED_AT_LINE_RE, "");
}

/**
 * Reproducibility (Schritt 3): same --source tree + same --revision must
 * produce a byte-identical snapshot file, not just byte-identical provider
 * data. If a snapshot already exists at `outputPath` whose content is
 * identical to `candidateOutput` in every respect EXCEPT the generatedAt
 * timestamp, this is a true no-op re-run — reuse the EXISTING generatedAt
 * (and, by extension, skip writing entirely) instead of manufacturing a new
 * timestamp for identical content on every invocation.
 */
function reuseGeneratedAtIfUnchanged(outputPath, candidateOutput) {
  if (!existsSync(outputPath)) return null;
  const existing = readFileSync(outputPath, "utf8");
  if (withoutGeneratedAtLine(existing) !== withoutGeneratedAtLine(candidateOutput)) return null;
  const match = existing.match(GENERATED_AT_LINE_RE);
  return match ? match[0].match(/"(.*)"/)[1] : null;
}

/**
 * Atomic replace (Schritt 4): write to a sibling temp file first, then
 * `renameSync` over the final path. `rename` is atomic on POSIX filesystems,
 * so a crash mid-write can only ever leave a stray temp file — the target
 * path is either the fully-old content or the fully-new content, never a
 * truncated/partial file.
 */
function writeFileAtomic(outputPath, content) {
  const tempPath = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tempPath, content, "utf8");
  try {
    renameSync(tempPath, outputPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(args.source);
  if (!existsSync(sourceDir)) {
    throw new ImportError(`--source directory does not exist: ${sourceDir}`);
  }
  const sourceRevision = resolveRevision(sourceDir, args.revision);

  const catalogPath = join(sourceDir, RELATIVE_CATALOG_PATH);
  if (!existsSync(catalogPath)) {
    throw new ImportError(`expected file not found: ${RELATIVE_CATALOG_PATH}`);
  }
  const text = readFileSync(catalogPath, "utf8");

  const constants = extractConstants(text);
  const providers = parseProviderCatalog(text, constants);
  if (providers.length === 0) {
    throw new ImportError("parsed zero providers — refusing to emit an empty catalog as success");
  }

  const provisionalGeneratedAt = new Date().toISOString();
  const candidateOutput = renderSnapshotFile({
    sourceRevision,
    generatedAt: provisionalGeneratedAt,
    providers,
  });

  const reusableGeneratedAt = reuseGeneratedAtIfUnchanged(OUTPUT_PATH, candidateOutput);
  if (reusableGeneratedAt) {
    console.log(
      `[fcc-catalog-sync] no-op: ${providers.length} providers from ${SOURCE_REPO}@${sourceRevision} already match the committed snapshot byte-for-byte (generatedAt preserved: ${reusableGeneratedAt})`
    );
    return;
  }

  const output = renderSnapshotFile({
    sourceRevision,
    generatedAt: provisionalGeneratedAt,
    providers,
  });
  writeFileAtomic(OUTPUT_PATH, output);
  console.log(
    `[fcc-catalog-sync] wrote ${providers.length} providers from ${SOURCE_REPO}@${sourceRevision} -> ${OUTPUT_PATH}`
  );
}

// Only run when invoked directly (CLI / npm script) — importing this module
// from a test must NOT trigger main() (argv parsing + process.exit would
// abort the test process). `export`s below are for that test seam.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    main();
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(`[fcc-catalog-sync] FAILED (existing snapshot left untouched): ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export {
  ImportError,
  extractConstants,
  parseProviderCatalog,
  parseValue,
  renderSnapshotFile,
  resolveRevision,
  withoutGeneratedAtLine,
  reuseGeneratedAtIfUnchanged,
  writeFileAtomic,
  RELATIVE_CATALOG_PATH,
  SOURCE_REPO,
  SCHEMA_VERSION,
};
