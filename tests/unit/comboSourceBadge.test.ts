import test from "node:test";
import assert from "node:assert/strict";

import { resolveComboConfig, resolveComboSource } from "../../src/lib/combos/comboSourceBadge.ts";

test("combo source: a Jarvis-owned combo is labelled owned, object or string", () => {
  const owned = { jarvisManaged: { ownerJobId: "free-coding" }, modelSort: { method: "cost" } };
  assert.equal(resolveComboSource(owned), "JARVIS_MANAGED");
  // Restored backups and older import paths hand us the config already
  // serialized; `("…" as string).jarvisManaged` is undefined, which would
  // label a reconciled combo as safe to hand-edit.
  assert.equal(resolveComboSource(JSON.stringify(owned)), "JARVIS_MANAGED");
  assert.equal(resolveComboSource({ jarvisAuto: true }), "JARVIS_MANAGED");
  assert.equal(resolveComboSource(JSON.stringify({ jarvisAuto: true })), "JARVIS_MANAGED");
});

test("combo source: a duplicated auto route is a frozen snapshot", () => {
  const snapshot = { sourceAutoCombo: "auto/chat:free" };
  assert.equal(resolveComboSource(snapshot), "STATIC_SNAPSHOT");
  assert.equal(resolveComboSource(JSON.stringify(snapshot)), "STATIC_SNAPSHOT");
});

test("combo source: ownership outranks provenance", () => {
  // A snapshot that Jarvis later adopted carries both markers. The stronger
  // warning — "the reconciler will overwrite your edit" — is the accurate one.
  assert.equal(
    resolveComboSource({ sourceAutoCombo: "auto/best-free", jarvisManaged: true }),
    "JARVIS_MANAGED"
  );
});

test("combo source: everything else is manual/legacy", () => {
  assert.equal(resolveComboSource({ modelSort: { method: "cost" } }), "MANUAL_LEGACY");
  assert.equal(resolveComboSource({}), "MANUAL_LEGACY");
  assert.equal(resolveComboSource(undefined), "MANUAL_LEGACY");
  assert.equal(resolveComboSource(null), "MANUAL_LEGACY");
  assert.equal(resolveComboSource(""), "MANUAL_LEGACY");
  assert.equal(resolveComboSource("   "), "MANUAL_LEGACY");
  assert.equal(resolveComboSource("not json at all"), "MANUAL_LEGACY");
  // Falsy markers are not ownership.
  assert.equal(resolveComboSource({ jarvisManaged: false, sourceAutoCombo: "" }), "MANUAL_LEGACY");
});

test("combo config: a serialized config is readable, not silently dropped", () => {
  // The edit form writes back whatever this returns; dropping a string config
  // to `{}` would wipe the stored runtime settings on the next save.
  assert.deepEqual(resolveComboConfig('{"modelSort":{"method":"cost"},"maxDepth":3}'), {
    modelSort: { method: "cost" },
    maxDepth: 3,
  });
  const live = { maxDepth: 3 };
  assert.equal(resolveComboConfig(live), live, "an object config is passed through as-is");
});

test("combo config: a JSON scalar or array is not a config bag", () => {
  for (const value of ["null", "42", '"text"', "[]", "[1,2]", "true"]) {
    assert.equal(resolveComboConfig(value), null, `${value} must not parse into a config`);
  }
  assert.equal(resolveComboConfig([1, 2, 3]), null);
  assert.equal(resolveComboConfig(7), null);
  assert.equal(resolveComboConfig("{broken"), null);
});
