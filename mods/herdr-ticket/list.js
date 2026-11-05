export const GROUPS = [
  { status: "in_progress", name: "In progress", symbol: "◔" },
  { status: "in_review", name: "In review", symbol: "◇" },
  { status: "todo", name: "Todo", symbol: "○" },
  { status: "done", name: "Done", symbol: "✓" },
];

/**
 * The panel's display order, without changing the CLI's status or ordering contracts.
 * @template {{ref: string, title: string, number: number, status: string}} T
 * @param {T[]} tickets
 * @param {string} filter
 * @param {string} query
 */
export function selectTickets(tickets, filter, query) {
  const counts = { open: 0, in_review: 0, done: 0 };
  for (const ticket of tickets) {
    if (ticket.status === "done") counts.done++;
    else if (ticket.status === "todo" || ticket.status === "in_progress") counts.open++;
    if (ticket.status === "in_review") counts.in_review++;
  }
  const needle = query.trim().toLowerCase();
  const groups = GROUPS
    .filter(g => filter === "open" ? g.status === "todo" || g.status === "in_progress" : g.status === filter)
    .map(g => ({
      ...g,
      items: tickets.filter(t => t.status === g.status && (!needle || t.title.toLowerCase().includes(needle) || t.ref.toLowerCase().includes(needle)))
        .sort((a, b) => a.number - b.number),
    }))
    .filter(g => g.items.length > 0);
  return { groups, counts };
}
