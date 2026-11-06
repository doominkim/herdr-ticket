import { div, image, svg } from "gpui-kit";
import { Button, v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, shared, run, appHome, readTextFile, setShared, notify } from "herdr";
import { sessionEntry } from "./session-data.js";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const kidStatus = (kid, listed) => {
  const status = listed.get(kid.address) ?? kid.status;
  return status === "error" ? "blocked" : status === "done" ? "idle" : status;
};
const icon = (program, size, color) => !program?.icon ? null : program.tint
  ? svg(program.icon).size(size).flex_none().text_color(color)
  : image(program.icon).w(size).h(size).flex_none();
function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
function glyph(t, status, compact = false) {
  const color = t[status] ?? t.dim;
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).bg(status === "done" ? color : t.dim + "00");
}

export class LinkedSessions {
  init(_cx) {
    this.folded = new Set();
    this.changed = new Map();
    this.hovered = null;
    this.entries = new Map();
    this.prompting = new Set();
    this.disposed = false;
  }

  read() {
    this.snapshot = { agents: agents(), terminals: terminals(), panes: panes(), spaces: spaces() };
    this.sort = shared("agents.sort") === "grouped" ? "grouped" : "priority";
    this.shown = focused()?.agent;
    this.now = Date.now();
    this.entries.clear();
    this.listed = new Map(this.snapshot.agents.map(a => [a.address, a.status]));
    // Like Agents, viewing done as idle does not restart its observed state age.
    // These timestamps belong to this view, never to a ticket attachment or another mod.
    for (const a of this.snapshot.agents) {
      const status = a.status === "done" ? "idle" : a.status;
      if (this.changed.get(a.address)?.status !== status) this.changed.set(a.address, { status, at: this.now });
    }
    const listed = new Set(this.snapshot.agents.map(a => a.address));
    for (const [address, value] of this.changed) {
      if (!listed.has(address) && this.now - value.at > 30 * 86400000) this.changed.delete(address);
    }
  }

  entry(ticket) {
    const address = ticket.session?.terminal;
    if (!address || !this.snapshot) return null;
    if (!this.entries.has(address)) this.entries.set(address, sessionEntry(this.snapshot, address, this.sort));
    return this.entries.get(address);
  }

  status(t, ticket) {
    const entry = this.entry(ticket);
    return entry ? glyph(t, entry.agent.status, true) : null;
  }

  tree(address, lead = []) {
    const kids = this.snapshot.terminals.filter(k => k.parent === address && k.state === "live");
    return kids.flatMap((kid, i) => {
      const last = i === kids.length - 1;
      return [{ terminal: kid, lines: [...lead, last ? "└" : "├"] }, ...this.tree(kid.address, [...lead, last ? "" : "│"])];
    });
  }

  subRow(t, sub, key) {
    const k = sub.terminal;
    const status = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === this.shown;
    return h_flex().id(`${key}-sub-${k.address}`).pl(39).pr(8).rounded(8).h(26).flex_none().gap(0).items_center().text_size(12.5)
      .when(on, el => el.bg(t.raised)).hover(el => el.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: k.address }); })
      .children(sub.lines.map(line => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(line), el => el.border_l(1.5).border_color(t.input))
        .when(line === "└" || line === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(glyph(t, status, this.sort === "priority"));
  }

  fold(t, a, subs, key) {
    const statuses = subs.map(s => kidStatus(s.terminal, this.listed));
    const top = statuses.reduce((m, s) => (RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m, null);
    const open = !this.folded.has(a.address);
    return div().id(`${key}-fold`).h(18).px(3).gap(3).flex().items_center().rounded(4).text_size(11)
      .text_color(open ? t.dim : t[top] ?? t.dim).cursor_pointer()
      .hover(el => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        open ? this.folded.add(a.address) : this.folded.delete(a.address);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!open, el => el.child(String(subs.length)));
  }

  promptsButton(t, address, key) {
    return Button.new(`${key}-prompts`).tab_index(0).size(22).flex_none().rounded(4)
      .items_center().justify_center().text_color(t.dim).disabled(this.prompting.has(address))
      .tooltip("Prompts").accessibility_label(`Prompts for ${address}`)
      .hover(el => el.bg(t.hover).text_color(t.foreground)).focus(el => el.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.openPrompts(address, cx); })
      .child(svg("mods/workspace-chrome/file-text.svg").size(13));
  }

  openPrompts(address, cx) {
    if (this.disposed || this.prompting.has(address)) return;
    this.prompting.add(address);
    cx.notify();
    cx.spawn(async acx => {
      try {
        const installed = await readTextFile(`${appHome()}/mods/prompt-jump/mod.json`);
        if (this.disposed) return;
        if (installed === null) {
          notify({ title: "Prompts unavailable", body: "Install Prompt Jump to open this session's prompts.", level: "warning" });
        } else if (!terminals().some(terminal => terminal.address === address && terminal.state === "live")) {
          notify({ title: "Prompts unavailable", body: "This session has ended.", level: "warning" });
        } else {
          // The receiver owns agent support, panel visibility and pinning; never change pane focus.
          setShared("prompt-jump.open", { terminal: address, n: `${Date.now()}-${Math.random()}` });
        }
      } catch (error) {
        if (!this.disposed) notify({ title: "Prompts unavailable", body: String(error?.message ?? error), level: "warning" });
      } finally {
        this.prompting.delete(address);
        if (!this.disposed) acx.notify();
      }
    });
  }

  row(t, ticket) {
    if (!ticket.session) return null;
    const entry = this.entry(ticket);
    const key = `tk-session-${ticket.ref}`;
    if (!entry) {
      const live = this.snapshot?.terminals.some(term => term.address === ticket.session.terminal && term.state === "live");
      return h_flex().px(10).pb(10).gap(6).items_center().text_size(11).text_color(t.muted ?? t.foreground)
        .tooltip(ticket.session.terminal)
        .child(div().flex_1().child(live ? "Session not listed in Agents" : "Session ended"))
        .when(live, el => el.child(this.promptsButton(t, ticket.session.terminal, key)).cursor_pointer().hover(node => node.bg(t.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("pane.focus", { terminal: ticket.session.terminal });
          }));
    }
    const { agent: a, name, detail: more, full, branch } = entry;
    const promptAction = this.promptsButton(t, a.address, key);
    const pic = icon(a.program, 16, t.foreground);
    const subs = this.tree(a.address);
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const when = this.changed.get(a.address)?.at;
    const idle = a.status === "idle" && !a.focused;
    const isPinned = a.pinned;
    const pin = div().id(`${key}-pin`).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
      .hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip(isPinned ? "Unpin" : "Pin to the top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("terminal.pin", { terminal: a.address, pinned: !isPinned });
        this.hovered = null;
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
    const main = h_flex().id(key).px(8).h(30).flex_none().rounded(8).items_center().gap(9)
      .when(a.focused, el => el.bg(t.selected)).cursor_pointer().hover(el => el.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = key;
        else if (this.hovered === key) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
      .when(Boolean(pic), el => el.child(div().id(`${key}-agent-fold`)
        .when(subs.length > 0, el => el.on_click((_e, cx) => {
          cx.stop_propagation();
          this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
          cx.notify();
        })).child(pic)))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
        .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${more}`))))
      .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
      .when(subs.length > 0, el => el.child(this.fold(t, a, subs, key)))
      .when(this.hovered === key, el => el.child(promptAction))
      .when(this.hovered === key, el => el.child(pin))
      .when(this.hovered !== key && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(this.now - when))))
      .child(glyph(t, a.status, this.sort === "priority" && !isPinned));
    return v_flex().mx(2).mb(10).min_w(0).text_size(13).child(main)
      .child(div().pl(33).pr(8).pb(3).min_w(0).text_size(11).text_color(t.dim).truncate()
        .tooltip(branch ?? "Current branch is unavailable for this session.").child(branch ?? "Branch unavailable"))
      .when(!this.folded.has(a.address), el => el.children(subs.map(sub => this.subRow(t, sub, key))));
  }

  dispose() {
    this.disposed = true;
    this.prompting.clear();
    this.snapshot = null;
    this.entries.clear();
    this.changed.clear();
    this.folded.clear();
    this.hovered = null;
  }
}
