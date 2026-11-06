/** Match the resolved app surface; shell appearance can differ from layout themes. */
export function isDarkBackground(background) {
  const short = background.length === 4 || background.length === 5;
  const rgb = Number.parseInt(background.slice(1, short ? 4 : 7), 16);
  const r = short ? ((rgb >> 8) & 15) * 17 : (rgb >> 16) & 255;
  const g = short ? ((rgb >> 4) & 15) * 17 : (rgb >> 8) & 255;
  const b = short ? (rgb & 15) * 17 : rgb & 255;
  return 299 * r + 587 * g + 114 * b < 128_000;
}

export function createdAge(createdAt, now = Date.now()) {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 60_000) return "<1m";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

/** Fresh show --latest-handoff output, without the ticket's history. */
export function ticketMarkdown(ticket) {
  const lines = [
    `# ${ticket.ref} · ${ticket.title}`,
    "",
    `- ID: ${ticket.ref}`,
    `- Status: ${ticket.status}`,
    `- Tags: ${(ticket.tags ?? []).join(", ") || "(none)"}`,
  ];
  if (ticket.priority) lines.push(`- Priority: ${ticket.priority}`);
  if (ticket.parent_ref) lines.push(`- Parent: ${ticket.parent_ref}`);
  if (ticket.children?.length) {
    lines.push("", "## Subtasks", "", ...ticket.children.map(child => `- ${child.ref} · ${child.title} (${child.status})`));
  }
  lines.push("", "## Description", "", ticket.body ?? "");
  const handoff = ticket.handoffs[0];
  if (handoff) {
    lines.push("", "## Latest handoff", "", handoff.summary, "", handoff.body ?? "");
    if (handoff.branch) lines.push("", `- Branch: ${handoff.branch}`);
    if (handoff.provider) lines.push(`- Agent: ${handoff.provider}/${handoff.model ?? ""}`);
  }
  return lines.join("\n");
}
