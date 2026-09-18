/**
 * Pure classifier over the curated connection-billing catalog
 * (`open-sse/config/connectionBillingCatalog.ts`).
 *
 * Kept dependency-light on purpose — the same constraint `paidModelFilter.ts`
 * and `strictZeroCostFilter.ts` state in their own headers — so subscription
 * routing is unit-testable without seeding the DB or the virtual factory. No
 * provider name appears in this file: a connection is classified purely from
 * the catalog plus the two facts the caller already has (`provider`,
 * `authType`), so curating a new provider needs no code change here.
 * `resolveConnectionZeroCostSafety` (O9-F3.4 P4-B) additionally reads the
 * connection's own `providerSpecificData.billingEvidence`.
 */
import {
  CONNECTION_BILLING_CATALOG,
  type ConnectionBillingClass,
  type ConnectionBillingEntry,
  type ConnectionOverageBehavior,
} from "@omniroute/open-sse/config/connectionBillingCatalog.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "./resilienceCandidateFilter";

/** The minimum a caller must know about a connection to classify it. */
export interface BillableConnection {
  provider: string;
  /** `provider_connections.auth_type` — `oauth` / `apikey` / `cookie` / … */
  authType?: string | null;
  /** Connection id; the synthetic no-auth sentinel classifies as `keyless`. */
  connectionId?: string | null;
  /** This connection's `provider_specific_data`; only `billingEvidence` is read. */
  providerSpecificData?: unknown;
}

export interface ConnectionBillingVerdict {
  billing: ConnectionBillingClass;
  overage: ConnectionOverageBehavior;
  reason: string;
}

const UNKNOWN_VERDICT: ConnectionBillingVerdict = {
  billing: "unknown",
  overage: "unknown",
  reason: "No curated billing entry for this provider/authType — assumed metered.",
};

const KEYLESS_VERDICT: ConnectionBillingVerdict = {
  billing: "keyless",
  overage: "hard-stop",
  reason:
    "Synthetic no-auth connection: no credential exists, so no request against it can be billed.",
};

/**
 * Classify one connection.
 *
 * Resolution order, first match wins:
 *   1. the synthetic no-auth sentinel → `keyless` (no credential can be billed);
 *   2. a catalog entry matching BOTH provider and `authType`;
 *   3. a provider-wide catalog entry (no `authType` declared);
 *   4. otherwise `unknown`.
 *
 * `unknown` is never treated as free by any caller — `isPlanIncluded()` below
 * returns false for it, so an uncurated provider stays outside the
 * subscription rung until someone curates it deliberately.
 */
export function classifyConnectionBilling(
  connection: BillableConnection,
  catalog: readonly ConnectionBillingEntry[] = CONNECTION_BILLING_CATALOG
): ConnectionBillingVerdict {
  if (connection.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID) return KEYLESS_VERDICT;

  const provider = connection.provider;
  if (!provider) return UNKNOWN_VERDICT;

  const providerEntries = catalog.filter((entry) => entry.provider === provider);
  if (providerEntries.length === 0) return UNKNOWN_VERDICT;

  const authType = typeof connection.authType === "string" ? connection.authType : null;
  const authMatch = authType
    ? providerEntries.find((entry) => entry.authType === authType)
    : undefined;
  const entry = authMatch ?? providerEntries.find((entry) => entry.authType === undefined);
  if (!entry) return UNKNOWN_VERDICT;

  return { billing: entry.billing, overage: entry.overage, reason: entry.reason };
}

/**
 * True when serving a request through this connection consumes an allowance
 * the operator already pays for, rather than adding incremental spend.
 * `keyless` qualifies: it costs nothing by construction.
 */
export function isPlanIncluded(verdict: ConnectionBillingVerdict): boolean {
  return verdict.billing === "subscription" || verdict.billing === "keyless";
}

/**
 * True when exhausting this connection's allowance cannot start costing money.
 * The strict `auto/subscription` grouping admits nothing else: an operator who
 * asked never to spend extra must not be surprised by a provider that meters
 * past the plan, nor by one whose terms simply are not established.
 */
export function isOverageSafe(verdict: ConnectionBillingVerdict): boolean {
  return verdict.overage === "hard-stop";
}

// ---------------------------------------------------------------------------
// Per-connection billing evidence (O9-F3.4 P4-B)
// ---------------------------------------------------------------------------

/**
 * Where a per-connection billing fact came from, kept on the fact so an
 * operator's assertion is never mistaken for something the provider reported.
 * The API write path (`validateProviderSpecificData`) accepts only
 * `operator-declared`; `provider-observed` is reserved for server-side
 * detection code.
 */
export type ConnectionBillingEvidenceOrigin = "provider-observed" | "operator-declared";

/**
 * Evidence about the ACCOUNT behind one connection, stored at
 * `provider_connections.provider_specific_data.billingEvidence`. The catalog
 * answers how a provider/authType bills in general; it cannot tell apart two
 * keys of the same provider that belong to a free-tier project without a
 * billing account and a paid-tier project with one.
 *
 * `billingLinked`: is a chargeable payment method or billing account attached
 * to the account that owns this credential? `null` means not known.
 */
export interface ConnectionBillingEvidence {
  billingLinked: boolean | null;
  origin: ConnectionBillingEvidenceOrigin;
  observedAt: string | null;
}

const EVIDENCE_ORIGINS: ReadonlySet<string> = new Set(["provider-observed", "operator-declared"]);

/** Read `billingEvidence` from providerSpecificData. Anything malformed is no evidence (`null`). */
export function parseConnectionBillingEvidence(
  providerSpecificData: unknown
): ConnectionBillingEvidence | null {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return null;
  const raw = (providerSpecificData as Record<string, unknown>).billingEvidence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { billingLinked, origin, observedAt } = raw as Record<string, unknown>;
  if (billingLinked !== null && typeof billingLinked !== "boolean") return null;
  if (typeof origin !== "string" || !EVIDENCE_ORIGINS.has(origin)) return null;
  if (observedAt !== undefined && observedAt !== null && typeof observedAt !== "string") {
    return null;
  }
  return {
    // Same reasoning as `observedAt` below: the guard above already proves
    // `billingLinked` is `boolean | null` at runtime, but TS does not narrow
    // a destructured `unknown` through an early-return `typeof` guard here —
    // an explicit re-check is required, not a cast.
    billingLinked: typeof billingLinked === "boolean" ? billingLinked : null,
    origin: origin as ConnectionBillingEvidenceOrigin,
    observedAt: typeof observedAt === "string" ? observedAt : null,
  };
}

export type ConnectionZeroCostBasis =
  | "keyless"
  | "contract-hard-stop"
  | "contract-meters-to-paid"
  | "billing-linked"
  | "billing-not-linked"
  | "unverified-not-linked"
  | "insufficient-evidence";

export interface ConnectionZeroCostSafety {
  /** `true`: no paid overage path. `false`: one exists. `null`: not established — fail closed. */
  safe: boolean | null;
  basis: ConnectionZeroCostBasis;
  /** `static` for catalog/sentinel facts, the evidence origin otherwise, `null` when nothing is known. */
  origin: "static" | ConnectionBillingEvidenceOrigin | null;
}

/**
 * Can a request through THIS connection ever cost incremental money?
 *
 * Most conservative first:
 *   1. synthetic no-auth sentinel → safe (no credential exists to bill);
 *   2. catalog overage `meters-to-paid` → unsafe, whatever the evidence says;
 *   3. catalog overage `hard-stop` → safe (published terms refuse rather than
 *      bill, even with a payment method on file);
 *   4. the connection's own evidence, trusted asymmetrically: billing linked
 *      (any origin) → unsafe, because weak evidence may safely prove UNSAFE;
 *      not linked → safe only when `provider-observed`. An operator
 *      declaration of "not linked" is stored and reported but stays `null`:
 *      weak evidence must never prove SAFE;
 *   5. otherwise `null`.
 *
 * Only the passed connection's own providerSpecificData is read, so evidence
 * never carries over to another connection of the same provider.
 */
export function resolveConnectionZeroCostSafety(
  connection: BillableConnection,
  catalog: readonly ConnectionBillingEntry[] = CONNECTION_BILLING_CATALOG
): ConnectionZeroCostSafety {
  if (connection.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID) {
    return { safe: true, basis: "keyless", origin: "static" };
  }
  const verdict = classifyConnectionBilling(connection, catalog);
  if (verdict.overage === "meters-to-paid") {
    return { safe: false, basis: "contract-meters-to-paid", origin: "static" };
  }
  if (verdict.overage === "hard-stop") {
    return { safe: true, basis: "contract-hard-stop", origin: "static" };
  }
  const evidence = parseConnectionBillingEvidence(connection.providerSpecificData);
  if (evidence?.billingLinked === true) {
    return { safe: false, basis: "billing-linked", origin: evidence.origin };
  }
  if (evidence?.billingLinked === false) {
    return evidence.origin === "provider-observed"
      ? { safe: true, basis: "billing-not-linked", origin: evidence.origin }
      : { safe: null, basis: "unverified-not-linked", origin: evidence.origin };
  }
  return { safe: null, basis: "insufficient-evidence", origin: null };
}
