/**
 * db/providerActivationApprovals.ts — Routing Activation Gate (O9-F3.5 A3) persistence.
 *
 * Stores the activation policy mode per connection and explicit per-model
 * approval/revocation records for `evaluateActivationDecision`
 * (`src/lib/providerOnboarding/activationPolicy.ts`) to read. Deliberately
 * separate from `syncedAvailableModels` and `customModels`: nothing on the
 * routing path reads this namespace, and writing here never activates a
 * model by itself — it only records an operator decision.
 */

import type {
  ActivationApprovalRecord,
  ActivationPolicyMode,
} from "@/lib/providerOnboarding/activationPolicy";
import { DEFAULT_ACTIVATION_POLICY_MODE } from "@/lib/providerOnboarding/activationPolicy";

import { getDbInstance } from "./core";

const POLICY_MODE_NAMESPACE = "providerActivationPolicyMode";
const APPROVAL_NAMESPACE = "providerActivationApprovals";
const VALID_MODES: ReadonlySet<string> = new Set<ActivationPolicyMode>([
  "manual",
  "approved_ready",
  "strict_zero_cost",
]);

function isValidPolicyMode(value: string): value is ActivationPolicyMode {
  return VALID_MODES.has(value);
}

export function getActivationPolicyMode(connectionId: string): ActivationPolicyMode {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(POLICY_MODE_NAMESPACE, connectionId) as { value: string } | undefined;
  return row && isValidPolicyMode(row.value) ? row.value : DEFAULT_ACTIVATION_POLICY_MODE;
}

export function setActivationPolicyMode(connectionId: string, mode: ActivationPolicyMode): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    POLICY_MODE_NAMESPACE,
    connectionId,
    mode
  );
}

function approvalKey(connectionId: string, canonicalModelId: string): string {
  return `${connectionId}::${canonicalModelId}`;
}

function parseApproval(value: string): ActivationApprovalRecord | null {
  try {
    const parsed = JSON.parse(value) as ActivationApprovalRecord;
    return parsed && typeof parsed.canonicalModelId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function getActivationApproval(
  connectionId: string,
  canonicalModelId: string
): ActivationApprovalRecord | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(APPROVAL_NAMESPACE, approvalKey(connectionId, canonicalModelId)) as
    { value: string } | undefined;
  return row ? parseApproval(row.value) : null;
}

export function setActivationApproval(
  connectionId: string,
  record: ActivationApprovalRecord
): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    APPROVAL_NAMESPACE,
    approvalKey(connectionId, record.canonicalModelId),
    JSON.stringify(record)
  );
}

/** All approval/revocation records stored for one connection, for building an approval-lookup map. */
export function listActivationApprovals(connectionId: string): ActivationApprovalRecord[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key LIKE ? ESCAPE '\\'")
    .all(APPROVAL_NAMESPACE, `${connectionId.replace(/[\\%_]/g, "\\$&")}::%`) as Array<{
    value: string;
  }>;
  const out: ActivationApprovalRecord[] = [];
  for (const row of rows) {
    const parsed = parseApproval(row.value);
    if (parsed) out.push(parsed);
  }
  return out;
}
