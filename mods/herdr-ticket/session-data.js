// Native Agents title rules; branches deliberately use the linked terminal, not the tab lead.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function label(agent, snapshot) {
  const tab = snapshot.spaces.flatMap(s => s.tabs).find(tab => tab.id === agent.tab);
  if (!tab) return agent.title || agent.program?.name || "";
  const mine = snapshot.panes.filter(p => p.tab === tab.id && p.terminal);
  const lead = mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
  const prog = lead?.program?.name;
  const live = clean(lead?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

export function sessionEntry(snapshot, address, sort) {
  const terminal = snapshot.terminals.find(t => t.address === address && t.state === "live");
  const agent = snapshot.agents.find(a => a.address === address);
  if (!terminal || !agent) return null;
  const ownLabel = label(agent, snapshot);
  let detail = /^\d+$/.test(ownLabel) ? null : ownLabel;
  if (detail == null) {
    const duplicates = snapshot.agents.filter(a => {
      const value = label(a, snapshot);
      return a.space_name === agent.space_name && (!value || /^\d+$/.test(value));
    });
    if (duplicates.length > 1) detail = ownLabel;
  }
  const full = sort !== "grouped" || agent.pinned;
  const name = full ? agent.space_name || ownLabel : detail ?? (/^\d+$/.test(ownLabel) ? agent.program?.name || ownLabel : ownLabel);
  const pane = snapshot.panes.find(p => p.terminal === address);
  return { agent, name, detail, full, branch: pane?.branch || null };
}
