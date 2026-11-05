export function createdAge(createdAt, now = Date.now()) {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 60_000) return "just now";
  const [count, unit] = elapsed < 3_600_000 ? [Math.floor(elapsed / 60_000), "minute"]
    : elapsed < 86_400_000 ? [Math.floor(elapsed / 3_600_000), "hour"]
      : [Math.floor(elapsed / 86_400_000), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
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
