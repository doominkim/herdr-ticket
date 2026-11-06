export const GROUPS = [
  { status: "todo", name: "Open", symbol: "○" },
  { status: "in_progress", name: "In Progress", symbol: "◔" },
  { status: "in_review", name: "In review", symbol: "◇" },
  { status: "done", name: "Done", symbol: "✓" },
];

/**
 * The panel's display order, without changing the CLI's status or ordering contracts.
 * @template {{ref: string, title: string, number: number, status: string, parent_ref?: string | null}} T
 * @param {T[]} tickets
 * @param {string} filter
 * @param {string} query
 */
export function selectTickets(tickets, filter, query) {
  const counts = { open: 0, in_progress: 0, in_review: 0, done: 0 };
  const byRef = new Map();
  for (const ticket of tickets) {
    byRef.set(ticket.ref, ticket);
    if (ticket.status === "done") counts.done++;
    else if (ticket.status === "todo") counts.open++;
    else if (ticket.status === "in_progress") counts.in_progress++;
    if (ticket.status === "in_review") counts.in_review++;
  }
  const needle = query.trim().toLowerCase();
  const groups = GROUPS
    .filter(g => g.status === (filter === "open" ? "todo" : filter))
    .map(g => {
      const items = tickets.filter(t => t.status === g.status && (!needle || t.title.toLowerCase().includes(needle) || t.ref.toLowerCase().includes(needle)))
        .sort((a, b) => a.number - b.number);
      /** @type {Map<string, {ref: string, parent: T | null, items: T[]}>} */
      const families = new Map();
      for (const ticket of items) {
        const ref = ticket.parent_ref ?? ticket.ref;
        let family = families.get(ref);
        if (!family) {
          family = { ref, parent: byRef.get(ref) ?? null, items: [] };
          families.set(ref, family);
        }
        if (ticket.ref === ref) family.items.unshift(ticket);
        else family.items.push(ticket);
      }
      return { ...g, items, families: [...families.values()] };
    })
    .filter(g => g.items.length > 0);
  return { groups, counts };
}
