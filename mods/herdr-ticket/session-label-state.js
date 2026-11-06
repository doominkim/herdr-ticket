import { planTicketTabNames } from "./session-ticket-names.js";

const RETRY_MS = 2000;
const LEASE_MS = 6000;

/** @typedef {{base: string, applied: string, baseNamed: boolean}} Ownership */
/** @typedef {{from: string, fromNamed: boolean, name: string, next: Ownership | null, requestedAt: number, obsolete: string[], guard: boolean}} Pending */

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value @returns {Pending | null} */
function pendingRequest(value) {
  const p = record(value), n = record(p.next);
  if (typeof p.from !== "string" || typeof p.fromNamed !== "boolean" || typeof p.name !== "string"
    || typeof p.requestedAt !== "number" || !Number.isFinite(p.requestedAt) || typeof p.guard !== "boolean") return null;
  const next = p.next === null ? null : typeof n.base === "string" && typeof n.applied === "string" && typeof n.baseNamed === "boolean"
    ? { base: n.base, applied: n.applied, baseNamed: n.baseNamed } : null;
  if (p.next !== null && !next) return null;
  return { from: p.from, fromNamed: p.fromNamed, name: p.name, next, requestedAt: p.requestedAt, guard: p.guard,
    obsolete: Array.isArray(p.obsolete) ? p.obsolete.filter(name => typeof name === "string") : [] };
}

/** @param {Pending | null | undefined} earlier */
function obsoleteTargets(earlier) {
  return earlier ? [...new Set(earlier.guard ? earlier.obsolete : [earlier.name, ...earlier.obsolete])] : [];
}

/** @param {string} target @param {{name: string, named: boolean}} tab */
function matchesTarget(target, tab) {
  return target === "" ? !tab.named : tab.named && tab.name === target;
}

/**
 * Native run() queues a command; only a later tab snapshot acknowledges it.
 * Shared state must be published before issuing returned commands. No I/O here.
 * @param {readonly {ref: string, status: string, session?: {terminal?: string} | null}[]} tickets
 * @param {readonly {terminal: string, tab: string}[]} panes
 * @param {readonly {id: string, name: string, named: boolean}[]} tabs
 * @param {unknown} previous
 * @param {{owner: string, now: number}} clock
 * @returns {{renames: {id: string, name: string}[], state: unknown}}
 */
export function planSessionLabels(tickets, panes, tabs, previous, { owner, now }) {
  const before = record(previous), rawLease = record(before.lease);
  const lease = typeof rawLease.owner === "string" && typeof rawLease.until === "number" && Number.isFinite(rawLease.until)
    ? { owner: rawLease.owner, until: rawLease.until } : null;
  if (lease && lease.owner !== owner && lease.until > now && lease.until - now <= LEASE_MS) {
    return { renames: [], state: previous };
  }
  const ownership = new Map(Object.entries(record(before.ownership)));
  const pending = new Map(Object.entries(record(before.pending)));
  const ids = new Set(tabs.map(tab => tab.id));
  for (const id of ownership.keys()) if (!ids.has(id)) ownership.delete(id);
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
  /** @type {{id: string, name: string}[]} */
  const renames = [];
  /** @type {Set<string>} */
  const blocked = new Set();
  /** @type {Map<string, Pending>} */
  const superseded = new Map();

  for (const tab of tabs) {
    const p = pendingRequest(pending.get(tab.id));
    if (!p) { pending.delete(tab.id); continue; }
    const acknowledged = matchesTarget(p.name, tab);
    if (acknowledged) {
      if (!p.guard) {
        if (p.next) ownership.set(tab.id, p.next);
        else ownership.delete(tab.id);
        pending.delete(tab.id);
      }
    } else if ((tab.name === p.from && tab.named === p.fromNamed)
      || tab.name === record(ownership.get(tab.id)).applied || p.obsolete.some(target => matchesTarget(target, tab))) {
      blocked.add(tab.id);
      if (p.guard || now < p.requestedAt || now - p.requestedAt >= RETRY_MS) {
        pending.set(tab.id, { ...p, requestedAt: now, guard: false });
        renames.push({ id: tab.id, name: p.name });
      }
    } else {
      // Preserve a new manual base, while recognizing older commands still in the native queue.
      superseded.set(tab.id, p);
      pending.delete(tab.id);
    }
  }

  const desired = planTicketTabNames(tickets, panes, tabs, Object.fromEntries(ownership));
  const changes = new Map(desired.renames.map(rename => [rename.id, rename.name]));
  for (const tab of tabs) {
    if (blocked.has(tab.id)) continue;
    const old = record(ownership.get(tab.id));
    const nextName = Object.hasOwn(desired.ownership, tab.id) ? desired.ownership[tab.id] : null;
    const stillOwned = nextName && old.applied === tab.name && old.base === nextName.base && nextName.base !== tab.name;
    const next = nextName ? { ...nextName,
      baseNamed: stillOwned && typeof old.baseNamed === "boolean" ? old.baseNamed : tab.named } : null;
    const changedName = changes.get(tab.id);
    if (changedName !== undefined) {
      const name = !next && old.baseNamed === false ? "" : changedName;
      const earlier = superseded.get(tab.id) ?? pendingRequest(pending.get(tab.id));
      const obsolete = obsoleteTargets(earlier);
      pending.set(tab.id, { from: tab.name, fromNamed: tab.named, name, next, requestedAt: now, obsolete, guard: false });
      renames.push({ id: tab.id, name });
      // Keep the last observed ownership until this new request is actually observed.
    } else {
      const earlier = superseded.get(tab.id);
      if (earlier) {
        // No new prefix is needed, but an older queued command can still overwrite this manual name.
        // Keep a guard until that result is corrected and the correction is observed, or the tab closes.
        pending.set(tab.id, { from: tab.name, fromNamed: tab.named, name: tab.named ? tab.name : "", next,
          requestedAt: now, obsolete: obsoleteTargets(earlier), guard: true });
      }
      if (next) ownership.set(tab.id, next);
      else ownership.delete(tab.id);
    }
  }
  const core = { ownership: Object.fromEntries(ownership), pending: Object.fromEntries(pending) };
  const changed = JSON.stringify(core) !== JSON.stringify({ ownership: record(before.ownership), pending: record(before.pending) });
  return { renames, state: { ...core, lease: changed ? { owner, until: now + LEASE_MS } : lease } };
}
