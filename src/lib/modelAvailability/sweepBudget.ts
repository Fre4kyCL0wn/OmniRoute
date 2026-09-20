/**
 * Availability sweep budgeting — how one run's probe allowance is split
 * between re-probing known-blocked models and discovering never-probed ones.
 *
 * `maxPerRun` is a promise to the operator about how much upstream traffic one
 * tick of the background job may generate. Running two independent selections
 * of `maxPerRun` each silently doubles it, and concatenating them puts every
 * due target ahead of every discovery target — so on an instance with more
 * blocked models than budget, discovery never runs at all and the provider
 * page keeps showing UNTESTED forever.
 *
 * This module is the single arbiter instead:
 *
 *   - one shared cap, never exceeded, counting BOTH kinds of probe;
 *   - a reserved half for each kind so neither can starve the other, with
 *     unused capacity flowing to whichever side can still use it;
 *   - the final order round-robins across connections, so a connection that
 *     answers 429 and gets short-circuited for the rest of the run costs the
 *     other connections at most one probe slot instead of the whole budget;
 *   - exact (provider, connection, model) duplicates are collapsed, with the
 *     due entry winning — a model with persisted evidence is by definition not
 *     a discovery target, and probing it twice in one tick is pure waste.
 *
 * Pure and dependency-free by design: the budget invariant is the thing most
 * worth testing and least worth mocking a database for.
 */

export interface AvailabilitySweepCandidate {
  providerId: string;
  connectionId: string;
  modelId: string;
}

export type AvailabilitySweepSource = "reprobe" | "batch_test";

export interface AvailabilitySweepTarget extends AvailabilitySweepCandidate {
  source: AvailabilitySweepSource;
}

export interface SelectAvailabilitySweepTargetsInput {
  /** Hard cap for the whole run, across both sources. */
  maxPerRun: number;
  /** Models with persisted evidence whose retry time has come. */
  due: AvailabilitySweepCandidate[];
  /** Never-probed, provably zero-cost models from the discovery sweep. */
  discovery: AvailabilitySweepCandidate[];
}

function candidateKey(candidate: AvailabilitySweepCandidate): string {
  return `${candidate.providerId}\u0000${candidate.connectionId}\u0000${candidate.modelId}`;
}

/** Round-robin across connections, preserving each connection's own order. */
function interleaveByConnection(targets: AvailabilitySweepTarget[]): AvailabilitySweepTarget[] {
  const queues = new Map<string, AvailabilitySweepTarget[]>();
  for (const target of targets) {
    const queue = queues.get(target.connectionId);
    if (queue) queue.push(target);
    else queues.set(target.connectionId, [target]);
  }
  if (queues.size <= 1) return targets;

  const ordered: AvailabilitySweepTarget[] = [];
  const lists = [...queues.values()];
  let remaining = targets.length;
  while (remaining > 0) {
    for (const list of lists) {
      const next = list.shift();
      if (!next) continue;
      ordered.push(next);
      remaining -= 1;
    }
  }
  return ordered;
}

/**
 * Allocate one run's probe budget. Returns at most `maxPerRun` targets in the
 * order the job should execute them.
 */
export function selectAvailabilitySweepTargets(
  input: SelectAvailabilitySweepTargetsInput
): AvailabilitySweepTarget[] {
  const cap = Math.max(0, Math.floor(input.maxPerRun));
  if (cap === 0) return [];

  const seen = new Set<string>();
  const due: AvailabilitySweepTarget[] = [];
  for (const candidate of input.due) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    due.push({ ...candidate, source: "reprobe" });
  }
  const discovery: AvailabilitySweepTarget[] = [];
  for (const candidate of input.discovery) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    discovery.push({ ...candidate, source: "batch_test" });
  }

  // Half each, then hand the unclaimed remainder back to whichever side still
  // has candidates — so a quiet instance with nothing due still discovers at
  // full budget, and vice versa.
  let dueQuota = Math.min(due.length, Math.ceil(cap / 2));
  const discoveryQuota = Math.min(discovery.length, cap - dueQuota);
  dueQuota = Math.min(due.length, dueQuota + (cap - dueQuota - discoveryQuota));

  return interleaveByConnection([...due.slice(0, dueQuota), ...discovery.slice(0, discoveryQuota)]);
}
