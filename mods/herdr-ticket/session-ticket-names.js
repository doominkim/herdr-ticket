const refPattern = /^[A-Z0-9]+-(?:0|[1-9]\d*)$/;
const separator = " · ";

/** @param {string} left @param {string} right */
function compareRefs(left, right) {
  const leftDash = left.indexOf("-");
  const rightDash = right.indexOf("-");
  const leftSlug = left.slice(0, leftDash);
  const rightSlug = right.slice(0, rightDash);
  if (leftSlug !== rightSlug) return leftSlug < rightSlug ? -1 : 1;
  const leftNumber = left.slice(leftDash + 1);
  const rightNumber = right.slice(rightDash + 1);
  return leftNumber.length - rightNumber.length || (leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0);
}

/** @typedef {{base: string, applied: string}} Ownership */

/**
 * Only names produced by this planner can authorize restoring a saved base.
 * @param {unknown} value
 * @returns {Ownership | null}
 */
function ownedName(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (!Object.hasOwn(entry, "base") || !Object.hasOwn(entry, "applied")) return null;
  const { base, applied } = entry;
  if (typeof base !== "string" || typeof applied !== "string") return null;
  const suffix = separator + base;
  if (!applied.endsWith(suffix)) return null;
  const prefix = applied.slice(0, -suffix.length);
  const refs = prefix.split(", ");
  if (refs.some(ref => !refPattern.test(ref)) || new Set(refs).size !== refs.length) return null;
  if (refs.sort(compareRefs).join(", ") !== prefix) return null;
  return { base, applied };
}

/**
 * Plan local tab labels without reading native state or performing renames.
 * The caller supplies only local tabs; terminal addresses are matched exactly.
 * @param {readonly {ref: string, status: string, session?: {terminal?: string} | null}[]} tickets
 * @param {readonly {terminal: string, tab: string}[]} panes
 * @param {readonly {id: string, name: string}[]} tabs
 * @param {unknown} previousOwnership
 * @returns {{renames: {id: string, name: string}[], ownership: Record<string, Ownership>}}
 */
export function planTicketTabNames(tickets, panes, tabs, previousOwnership) {
  const localTabs = new Set(tabs.map(tab => tab.id));
  const tabByTerminal = new Map();
  for (const pane of panes) {
    if (typeof pane.terminal === "string" && pane.terminal && localTabs.has(pane.tab)) {
      tabByTerminal.set(pane.terminal, pane.tab);
    }
  }

  /** @type {Map<string, Set<string>>} */
  const refsByTab = new Map();
  for (const ticket of tickets) {
    if (ticket.status !== "in_progress" || !refPattern.test(ticket.ref)) continue;
    const tab = tabByTerminal.get(ticket.session?.terminal);
    if (tab === undefined) continue;
    let refs = refsByTab.get(tab);
    if (!refs) refsByTab.set(tab, refs = new Set());
    refs.add(ticket.ref);
  }

  const previous = previousOwnership && typeof previousOwnership === "object" && !Array.isArray(previousOwnership)
    ? /** @type {Record<string, unknown>} */ (previousOwnership) : {};
  /** @type {{id: string, name: string}[]} */
  const renames = [];
  /** @type {[string, Ownership][]} */
  const entries = [];
  for (const tab of tabs) {
    const owned = Object.hasOwn(previous, tab.id) ? ownedName(previous[tab.id]) : null;
    const stillOwned = owned && tab.name === owned.applied;
    const refs = refsByTab.get(tab.id);
    if (!refs?.size) {
      if (stillOwned) renames.push({ id: tab.id, name: owned.base });
      continue;
    }
    // A manual rename is a new base. Never strip ticket-like text from user names.
    const base = stillOwned ? owned.base : tab.name;
    const applied = [...refs].sort(compareRefs).join(", ") + separator + base;
    if (tab.name !== applied) renames.push({ id: tab.id, name: applied });
    entries.push([tab.id, { base, applied }]);
  }
  return { renames, ownership: Object.fromEntries(entries) };
}
