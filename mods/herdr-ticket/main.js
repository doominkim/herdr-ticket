// herdr-ticket panel: the tickets of the focused pane's repository (its original main worktree),
// read through the `tk` CLI. Agents write through the same CLI, so the panel polls `tk rev` and
// reloads only when something changed. Each ticket shows the Herdr session that last worked on it
// (a write from inside a Herdr terminal attaches it), drawn like a row of the Agents sidebar.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { focused, theme, home, settings, props, openOverlay, closeOverlay, shared } from "herdr";
import { GROUPS, selectTickets } from "./list.js";
import { tk } from "./commands.js";
import { AgentPicker } from "./agent.js";
import { createdAge, isDarkBackground, ticketMarkdown } from "./presentation.js";
import { LinkedSessions } from "./sessions.js";
import { TagSelection } from "./tag-picker.js";
import { tagPill } from "./tag-style.js";
import { SessionLabelRuntime, SESSION_LABEL_ERROR } from "./session-label-runtime.js";
import { PriorityEditor, priorityChoices, priorityColor, priorityMark } from "./priority.js";

const POLL_MS = 1000; // Leave CLI reload time inside the 2-second refresh target.
const NEXT = { todo: "in_progress", in_progress: "in_review", in_review: "done" };
let composerKeysBound = false;
function bindComposerKeys(cx) {
  if (composerKeysBound) return;
  // Textareas consume Input actions before an ancestor-only binding can run.
  cx.bind_keys([
    { keystroke: "cmd-enter", action: "herdr-ticket-submit", context: "HerdrTicketCompose" },
    { keystroke: "cmd-enter", action: "herdr-ticket-submit", context: "HerdrTicketCompose > Input" },
  ]);
  composerKeysBound = true;
}



class TicketPanel {
  init(input, cx) {
    const p = input ?? props() ?? {};
    this.pinnedRoot = p.root ?? null;
    this.pinnedRef = p.ref ?? null;
    this.handle = this.pinnedRef ? cx.focus_handle() : null;
    this.handle?.focus();
    this.cwd = this.pinnedRoot; // repository folder the data was loaded for
    this.key = null; // focused folder + terminal it was loaded for
    this.repo = null;
    this.tickets = [];
    this.rev = -1;
    this.error = null;
    this.catalog = [];
    this.catalogRoot = null;
    this.catalogRev = -1;
    this.catalogError = null;
    this.disposed = false;
    this.sessions = new LinkedSessions();
    this.sessions.init(cx);
    this.open = this.pinnedRef; // ref of the expanded ticket
    this.more = null;
    this.filter = "open";
    this.query = "";
    this.search = InputState.new({ placeholder: "Search title or ticket ID…" });
    this.search.on("change", () => { if (!this.disposed) { this.query = this.search.value(); cx.notify(); } });
    this.msg = null;
    this.loading = false;
    cx.timer.every(POLL_MS, (acx) => this.poll(acx));
    cx.timer.every(30000, (acx) => acx.notify()); // session times
    this.poll(cx);
  }

  // ---- data

  poll(cx) {
    const f = this.pinnedRoot ? null : focused();
    const cwd = this.pinnedRoot ?? f?.cwd ?? null;
    const key = `${cwd}\u0000${f?.terminal ?? ""}\u0000${this.open ?? ""}`;
    if (!cwd || this.loading || this.disposed) return;
    const current = () => !this.disposed && (this.pinnedRoot ?? focused()?.cwd ?? null) === cwd
      && (this.pinnedRoot || (focused()?.terminal ?? "") === (f?.terminal ?? ""));
    this.loading = true;
    cx.spawn(async (acx) => {
      try {
        const { rev } = await tk(["rev"]);
        if (key === this.key && rev === this.rev && !this.catalogError) return;
        if (!current()) return;
        const root = this.pinnedRoot ?? await this.repoRoot(cwd, f?.terminal);
        if (!current()) return;
        if (this.cwd !== root) {
          this.open = this.pinnedRef;
          this.more = null;
          this.filter = "open";
          this.query = "";
          this.search.set_value("");
        }
        const expandedRef = this.open;
        const catalogChanged = this.catalogRoot !== root || this.catalogRev !== rev || Boolean(this.catalogError);
        const [brief, done, expanded, catalog] = await Promise.all([
          tk(["brief", "--cwd", root]),
          this.pinnedRef ? Promise.resolve({ tickets: [] }) : tk(["ls", "--status", "done", "--cwd", root]),
          expandedRef ? tk(["show", expandedRef, "--latest-handoff", "--cwd", root]).catch(error => {
            if (!this.pinnedRef && error.message === `no such ticket: ${expandedRef}`) return null;
            throw error;
          }) : Promise.resolve(null),
          catalogChanged ? tk(["tags"], root).then(value => ({ value, error: null }))
            .catch(error => ({ value: null, error: `Tags unavailable: ${String(error?.message ?? error)}` })) : Promise.resolve(null),
        ]);
        if (!current()) return;
        if (catalogChanged) {
          if (this.catalogRoot !== root) this.catalog = [];
          this.catalogRoot = root;
          this.catalogError = catalog.error;
          if (catalog.value) {
            this.catalog = catalog.value.tags;
            this.catalogRev = rev;
          }
        }
        this.repo = brief.repo;
        let tickets = [...brief.tickets, ...done.tickets];
        if (expandedRef && !expanded && !this.pinnedRef) {
          tickets = tickets.filter(x => x.ref !== expandedRef);
          if (this.open === expandedRef) {
            this.open = null;
            this.more = null;
          }
        }
        this.tickets = this.pinnedRef ? (expanded ? [expanded] : []) : tickets.map(x => x.ref === expanded?.ref ? expanded : x);
        this.cwd = root;
        this.error = null;
        this.key = key;
        this.rev = rev;
      } catch (e) {
        if (!current()) return;
        this.cwd = cwd;
        this.repo = null;
        this.tickets = [];
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  /**
   * The focused folder's repository; when that folder is outside any repository (an agent started
   * in a parent folder), the repository of the ticket the focused terminal works on.
   */
  async repoRoot(cwd, terminal) {
    try {
      return (await tk(["repo", "--cwd", cwd])).root;
    } catch (e) {
      if (!terminal || !String(e?.message ?? e).includes("not a git repository")) throw e;
      const linked = await tk(["ls", "--all-repos", "--terminal", terminal]);
      if (!linked.tickets.length) throw e;
      return linked.tickets[0].repo_root;
    }
  }

  reload(cx) {
    this.key = null;
    this.poll(cx);
  }


  // ---- actions

  async act(cx, label, args) {
    this.msg = `${label}…`;
    cx.notify();
    try {
      await tk(args, this.cwd);
      this.msg = null;
    } catch (e) {
      this.msg = `${label} failed: ${String(e?.message ?? e)}`;
    }
    this.reload(cx);
  }


  openAgent(x) {
    if (!this.cwd) return;
    openOverlay({
      mod: "herdr-ticket", kind: "dialog", modal: true, width: 600, height: 750,
      props: { role: "agent", root: this.cwd, ref: x.ref, title: x.title, session: x.session },
    });
  }

  openTicket(ref) {
    if (!this.cwd) return;
    openOverlay({
      mod: "herdr-ticket", kind: "dialog", modal: true, width: 600, height: 720,
      props: { role: "detail", root: this.cwd, ref },
    });
  }

  copy(cx, x, full) {
    const root = this.cwd, ref = x.ref;
    this.more = null;
    cx.spawn(async acx => {
      try {
        const text = full ? ticketMarkdown(await tk(["show", ref, "--latest-handoff"], root)) : ref;
        await acx.write_to_clipboard(text);
        this.msg = full ? `Copied ${ref} context` : `Copied ${ref}`;
      } catch (e) {
        this.msg = `Copy failed: ${String(e?.message ?? e)}`;
      }
      acx.notify();
    });
  }

  openNewTicket(parent = null) {
    if (!this.repo) return;
    openOverlay({
      mod: "herdr-ticket",
      kind: "dialog",
      modal: true,
      width: 640,
      height: 720,
      props: { role: "new", root: this.cwd, slug: this.repo.slug, parent_ref: parent?.ref, parent_title: parent?.title },
    });
  }

  openDelete(x) {
    if (!this.repo) return;
    this.more = null;
    if (x.children?.length) {
      this.msg = `Cannot delete ${x.ref}: delete its ${x.children.length} subtask(s) first. Subtasks are never deleted automatically.`;
      return;
    }
    openOverlay({
      mod: "herdr-ticket",
      kind: "dialog",
      modal: true,
      width: 420,
      height: 260,
      props: { role: "delete", root: this.repo.root, ref: x.ref, title: x.title },
    });
  }

  openTags(x) {
    if (!this.repo) return;
    this.more = null;
    openOverlay({
      mod: "herdr-ticket", kind: "dialog", modal: true, width: 520, height: 520,
      props: { role: "tags", root: this.repo.root, ref: x.ref, title: x.title, tags: x.tags ?? [] },
    });
  }

  openPriority(x) {
    if (!this.repo) return;
    this.more = null;
    openOverlay({
      mod: "herdr-ticket", kind: "dialog", modal: true, width: 440, height: 300,
      props: { role: "priority", root: this.repo.root, ref: x.ref },
    });
  }

  openEdit(x) {
    if (!this.repo) return;
    this.more = null;
    openOverlay({
      mod: "herdr-ticket", kind: "dialog", modal: true, width: 640, height: 600,
      props: { role: "edit", root: this.repo.root, ref: x.ref },
    });
  }

  dispose() {
    this.disposed = true;
    this.sessions.dispose();
    this.search.release();
    this.handle?.release();
  }

  // ---- view

  render(_cx) {
    const t = theme(), secondary = t.dim ?? t.muted ?? t.foreground;
    this.dark = isDarkBackground(t.background);
    this.sessions.read();
    const root = v_flex().id("herdr-ticket").size_full().min_w(0).min_h(0).gap(8).p(8)
      .bg(t.chrome).text_color(t.foreground).text_size(13).line_height(1.5);
    if (this.handle) root.track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
    });
    root.child(v_flex().gap(4)
      .child(h_flex().h(31).pl(8).pr(2).items_center().gap(6).text_color(secondary)
        .child(div().flex_1().min_w(0).text_size(11.5).font_medium().child("Tickets"))
        .when(Boolean(this.repo), el => el.child(iconButton(t, "tk-new", "mods/herdr-ticket/ticket.svg",
          "New ticket", () => this.openNewTicket())))
        .when(Boolean(this.pinnedRef), el => el.child(iconButton(t, "tk-detail-close", "mods/workspace-chrome/x.svg",
          "Close ticket", () => closeOverlay(props()?.overlay)))))
      .when(Boolean(this.repo), el => el.child(div().px(8).text_size(10.5)
        .text_color(secondary).truncate().tooltip(this.repo.root).child(this.repo.root.replace(home(), "~")))));
    if (this.msg) root.child(div().role("status").text_size(11.5).text_color(secondary).child(this.msg));
    if (this.error) return root.child(div().role("alert").text_color(secondary)
      .child(this.error.includes("not a git repository") ? "Not in a git repository" : this.error));
    if (!this.repo) return root.child(div().text_color(secondary).child("Loading…"));
    if (this.catalogError) root.child(div().role("alert").text_size(11).text_color(secondary).child(this.catalogError));
    const labelError = shared(SESSION_LABEL_ERROR);
    if (typeof labelError === "string" && labelError) root.child(div().role("alert").text_size(11)
      .text_color(secondary).whitespace_normal().child(`Session label sync failed: ${labelError}`));
    const selection = selectTickets(this.tickets, this.filter, this.query);
    const counts = selection.counts;
    const groups = this.pinnedRef ? this.tickets.map(x => ({
      status: x.status, name: GROUPS.find(g => g.status === x.status)?.name ?? "Canceled",
      symbol: GROUPS.find(g => g.status === x.status)?.symbol ?? "×", items: [x],
      families: [{ ref: x.ref, parent: x, items: [x] }],
    })) : selection.groups;
    this.visibleRefs = new Set(groups.flatMap(g => g.items.map(x => x.ref)));
    if (!this.pinnedRef) {
      root.child(Input.new(this.search).h(32).px(10).rounded(6).border_1().border_color(t.border)
        .bg(t.raised).text_size(13).accessibility_label("Search tickets by title or ID"));
      root.child(h_flex().gap(4).border_b(1).border_color(t.border).children([
      ["open", "Open"], ["in_progress", "In Progress"], ["in_review", "In review"], ["done", "Done"],
    ].map(([value, label]) => Button.new(`tk-filter-${value}`).tab_index(0).selected(this.filter === value)
      .px(6).py(7).text_size(11.5).font_medium().border_b(2)
      .border_color(this.filter === value ? t.accent : t.border)
      .text_color(this.filter === value ? t.foreground : secondary)
      .focus(el => el.bg(t.hover)).hover(el => el.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { this.filter = value; this.more = null; cx.notify(); })
      .child(`${label}  ${counts[value]}`))));
    }
    const list = v_flex().id("tk-list").flex_1().min_h(0).min_w(0).gap(14).overflow_y_scrollbar();
    for (const g of groups) {
      const color = g.status === "in_progress" ? t.accent : g.status === "in_review" ? t.blocked ?? secondary : secondary;
      list.child(v_flex().gap(7)
        .child(h_flex().gap(7).items_center().text_size(11).text_color(secondary)
          .child(div().text_color(color).child(g.symbol))
          .child(div().flex_1().font_semibold().child(g.name))
          .child(div().font_family(settings().font_family ?? "Menlo").text_size(10).child(String(g.items.length))))
        .children(g.families.map(family => this.familyView(t, family, g.status))));
    }
    if (!groups.length) {
      const searching = Boolean(this.query.trim()), empty = counts.open + counts.in_progress + counts.in_review + counts.done === 0;
      list.child(v_flex().py(24).gap(10)
        .child(div().font_semibold().child(searching ? "No matching tickets" : empty ? "No tickets in this repository" : "No tickets here"))
        .child(div().text_size(12).text_color(secondary).child(searching ? "Try another title or ticket ID." : empty ? "Create a ticket to capture the next task." : "Choose another filter to see more tickets."))
        .when(searching, el => el.child(button(t, "tk-clear", "Clear search", false, (_e, cx) => {
          this.search.set_value(""); this.query = ""; this.search.focus(); cx.notify();
        })))
        .when(empty && !searching, el => el.child(iconButton(t, "tk-empty-new", "mods/herdr-ticket/ticket.svg", "New ticket", () => this.openNewTicket()))));
    }
    return root.child(list).child(div().border_t(1).border_color(t.border).pt(8)
      .text_size(10).text_color(secondary).child("Shared across worktrees"));
  }


  familyView(t, family, status) {
    const parent = family.items.find(x => x.ref === family.ref);
    const children = family.items.filter(x => x.ref !== family.ref);
    if (!children.length) return this.ticketView(t, parent);
    const secondary = t.muted ?? t.foreground;
    const group = v_flex().min_w(0).gap(8);
    if (parent) group.child(this.ticketView(t, parent));
    const nested = v_flex().min_w(0).ml(9).pl(9).border_l(2).border_color(t.border).gap(4);
    if (parent) nested.child(div().px(8).py(4).text_size(10.5).text_color(secondary)
      .child(`Subtasks · ${children.length}`));
    else nested.child(Button.new(`tk-family-${status}-${family.ref}`).tab_index(0).w_full().min_w(0).px(8).py(5)
      .text_size(11).text_color(secondary).cursor_pointer().hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
      .accessibility_label(`Open parent ${family.ref}`).tooltip(family.parent?.title ?? family.ref)
      .on_click(() => this.openTicket(family.ref))
      .child(div().min_w(0).whitespace_normal().max_h(36).overflow_hidden()
        .child(`↳ ${family.ref}${family.parent ? ` · ${family.parent.title}` : ""}`)));
    nested.children(children.map((child, i) => v_flex().min_w(0)
      .when(i > 0, el => el.border_t(1).border_color(t.border))
      .child(this.ticketView(t, child, true))));
    return group.child(nested);
  }

  ticketView(t, x, nested = false) {
    const isOpen = this.open === x.ref, secondary = t.dim ?? t.muted ?? t.foreground;
    const h = x.latest_handoff ?? x.handoffs?.[0] ?? null;
    const liveStatus = this.sessions.status(t, x);
    const card = v_flex().id(`tk-${x.ref}`).relative().min_w(0).bg(t.surface ?? t.background)
      .when(!nested, el => el.rounded(6).border_1().border_color(isOpen ? t.accent : t.border))
      .when(nested && isOpen, el => el.border_l(2).border_color(t.accent))
      .when(Boolean(x.priority), el => el.child(div().absolute().left(2).top(7).bottom(7).w(3).rounded(2)
        .bg(priorityColor(x.priority, this.dark))))
      .child(Button.new(`tk-head-${x.ref}`).tab_index(0).w_full().min_w(0).p(nested ? 8 : 10)
        .selected(isOpen).cursor_pointer().rounded(5).hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
        .accessibility_label(`${x.ref}: ${x.title}. ${isOpen ? "Collapse" : "Expand"} ticket`).tooltip(x.title)
        .on_click((_e, cx) => {
          if (this.pinnedRef) return;
          this.open = isOpen ? null : x.ref;
          this.more = null;
          cx.notify();
          if (!isOpen) this.reload(cx);
        })
        .child(v_flex().w_full().min_w(0).gap(4)
          .child(h_flex().items_start().gap(6).text_color(secondary)
            .child(h_flex().flex_1().min_w(0).gap(4).items_center().flex_wrap()
              .child(h_flex().gap(5).items_center().flex_none()
                .when(Boolean(liveStatus), el => el.child(liveStatus))
                .child(div().text_size(nested ? 13 : 14.5).font_bold().text_color(t.foreground).child(x.ref)))
              .when(Boolean(x.priority), el => el.child(priorityMark(t, x.priority, this.dark)))
              .children((x.tags ?? []).map(tag => tagPill(t, tag, this.catalog.find(entry => entry.name === tag)?.color))))
            .child(div().flex_none().text_size(10.5).tooltip(new Date(x.created_at).toLocaleString()).child(createdAge(x.created_at))))
          .child(div().w_full().min_w(0).text_size(nested ? 12.5 : 13).font_semibold().line_height(1.5).whitespace_normal()
            .when(!isOpen, el => el.max_h(nested ? 37.5 : 39).overflow_hidden()).child(x.title))))
      .when(Boolean(x.session), el => el.child(this.sessions.row(t, x)));
    if (!isOpen) return card;
    if (x.body === undefined) return card.child(div().px(10).pb(10).text_size(12).text_color(secondary).child("Loading…"));
    const detail = v_flex().px(10).pb(10).gap(10).min_w(0);
    const next = NEXT[x.status];
    detail.child(h_flex().gap(6).items_center()
      .child(iconButton(t, `tk-agent-${x.ref}`, "mods/workspace-chrome/terminal.svg", "Go / Start agent…", () => this.openAgent(x)))
      .when(Boolean(next), el => el.child(iconButton(t, `tk-next-${x.ref}`, `mods/workspace-chrome/${next === "done" ? "check" : "chevron-right"}.svg`,
        `Move to ${GROUPS.find(g => g.status === next).name}`,
        (_e, cx) => cx.spawn(async acx => this.act(acx, "Move", ["status", x.ref, next])))))
      .child(div().flex_1())
      .child(button(t, `tk-more-${x.ref}`, "•••", false, (_e, cx) => {
        this.more = this.more === x.ref ? null : x.ref; cx.notify();
      }).accessibility_label(`More actions for ${x.ref}`).selected(this.more === x.ref)));
    if (this.more === x.ref) detail.child(v_flex().p(8).gap(6).rounded(5).border_1().border_color(t.border)
      .child(button(t, `tk-copy-context-${x.ref}`, "Copy full context (Markdown)", false, (_e, cx) => this.copy(cx, x, true)))
      .child(button(t, `tk-copy-id-${x.ref}`, "Copy ID", false, (_e, cx) => this.copy(cx, x, false)))
      .child(button(t, `tk-edit-${x.ref}`, "Edit ticket…", false, (_e, cx) => { this.openEdit(x); cx.notify(); }))
      .child(button(t, `tk-tags-${x.ref}`, "Edit tags…", false, (_e, cx) => { this.openTags(x); cx.notify(); }))
      .child(button(t, `tk-priority-${x.ref}`, "Priority…", false, (_e, cx) => { this.openPriority(x); cx.notify(); }))
      .child(button(t, `tk-delete-${x.ref}`, "Delete ticket…", false, (_e, cx) => { this.openDelete(x); cx.notify(); })
        .text_color(t.blocked ?? t.foreground)));
    detail.child(TextView.markdown(`tk-body-${x.ref}`, x.body.trim() || "(no body)")
      .w_full().min_w(0).text_size(12).line_height(1.6).selectable(true));
    if (h) detail.child(v_flex().border_t(1).border_color(t.border).pt(10).gap(8).min_w(0)
      .child(div().text_size(11).font_semibold().text_color(secondary).child("Latest handoff"))
      .child(div().text_size(12).line_height(1.6).whitespace_normal().child(h.summary))
      .child(TextView.markdown(`tk-handoff-${x.ref}`, h.body).w_full().min_w(0).text_size(12).line_height(1.6).selectable(true))
      .child(div().text_size(10).text_color(secondary).truncate().tooltip(h.branch ?? "").child(h.branch || "(no branch)"))
      .child(div().text_size(10).text_color(secondary).truncate()
        .tooltip(h.provider ? `${h.provider}/${h.model}` : "human").child(h.provider ? `${h.provider}/${h.model}` : "human")));
    detail.child(v_flex().border_t(1).border_color(t.border).pt(8).gap(3).min_w(0).text_size(10).text_color(secondary)
      .child(div().child("Created in"))
      .child(div().truncate().tooltip(x.created_branch ?? "")
        .child(x.created_branch ?? (x.created_worktree ? "(detached HEAD)" : "Unknown")))
      .when(Boolean(x.created_worktree), el => el.child(div().truncate()
        .tooltip(x.created_worktree).child(x.created_worktree))));
    if (x.parent_ref) detail.child(button(t, `tk-parent-${x.ref}`, `↑ Parent · ${x.parent_ref}`, false, () => this.openTicket(x.parent_ref)));
    if (!x.parent_ref) {
      detail.child(h_flex().items_center().gap(6)
        .child(div().flex_1().text_size(11).text_color(secondary).child(`Subtasks · ${x.children?.length ?? 0}`))
        .child(button(t, `tk-child-new-${x.ref}`, "+ Add subtask", false, () => this.openNewTicket(x))));
      const outside = (x.children ?? []).filter(child => !this.visibleRefs.has(child.ref));
      if (!this.pinnedRef && outside.length) detail.child(div().text_size(10).text_color(secondary).child("Outside this list"));
      for (const child of outside) detail.child(
        Button.new(`tk-child-${child.ref}`).tab_index(0).relative().w_full().min_w(0).p(7).pl(10).rounded(4).border_t(1).border_color(t.border)
          .hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover)).cursor_pointer()
          .on_click(() => this.openTicket(child.ref))
          .when(Boolean(child.priority), el => el.child(div().absolute().left(2).top(7).bottom(7).w(3).rounded(2)
            .bg(priorityColor(child.priority, this.dark))))
          .child(v_flex().gap(3).min_w(0)
            .child(h_flex().gap(6).child(div().font_semibold().child(child.ref))
              .child(div().text_color(secondary).child(child.status.replace(/_/g, " ")))
              .when(Boolean(child.priority), el => el.child(priorityMark(t, child.priority, this.dark))))
            .child(div().whitespace_normal().child(child.title))));
    }
    return card.child(detail);
  }
}
function iconButton(t, id, asset, label, action) {
  return Button.new(id).tab_index(0).size(26).flex_none().items_center().justify_center().rounded(6)
    .text_color(t.dim ?? t.muted ?? t.foreground).cursor_pointer().tooltip(label).accessibility_label(label)
    .hover(el => el.bg(t.hover).text_color(t.foreground)).focus(el => el.bg(t.hover))
    .on_click(action).child(svg(asset).size(14));
}


function button(t, id, text, primary, action) {
  return Button.new(id).tab_index(0).h(32).px(9).items_center().rounded(5).border_1()
    .border_color(primary ? t.solid ?? t.accent : t.border)
    .bg(primary ? t.solid ?? t.accent : t.raised)
    .text_color(primary ? t.solid_foreground ?? t.background : t.foreground)
    .text_size(11).cursor_pointer()
    .hover(el => el.border_color(t.accent)).focus(el => el.border_color(t.accent))
    .on_click(action).child(text);
}

const BODY_TEMPLATE = "## Goal\n\n\n## Done when\n- [ ] \n";
/** Shared native picker; every instance owns one repository-pinned draft and catalog read. */
class TagPicker {
  init(root, selected, id, cx) {
    this.id = id;
    this.draft = new TagSelection(selected);
    this.query = "";
    this.loading = true;
    this.error = null;
    this.busy = false;
    this.disposed = false;
    this.search = InputState.new({ placeholder: "Search or create a tag…" });
    this.search.on("change", (_e, acx) => {
      this.query = this.search.value();
      this.draft.error = null;
      acx.notify();
    });
    this.search.on("submit", (_e, acx) => {
      if (this.busy || this.loading || this.error) return;
      const target = this.draft.target(this.query);
      if (target) this.choose(target, acx);
      else { this.draft.add(this.query); acx.notify(); }
    });
    cx.spawn(async acx => {
      try {
        const catalog = await tk(["tags"], root);
        if (this.disposed) return;
        this.draft.setCatalog(catalog.tags);
      } catch (error) {
        if (this.disposed) return;
        this.error = `Tags unavailable: ${String(error?.message ?? error)}`;
      } finally {
        this.loading = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  names() { return this.draft.names(); }
  focus() { if (!this.disposed) this.search.focus(); }
  dispose() { this.disposed = true; this.search.release(); }

  choose(name, cx) {
    if (this.busy) return;
    if (this.draft.names().includes(name)) this.draft.remove(name);
    else if (!this.draft.add(name)) { cx.notify(); return; }
    this.query = "";
    this.search.set_value("");
    this.search.focus();
    cx.notify();
  }

  render(t) {
    const selected = this.names(), secondary = t.muted ?? t.foreground;
    const color = name => this.loading || this.error ? null : this.draft.color(name);
    const box = v_flex().id(this.id).min_w(0).gap(6);
    if (selected.length) box.child(h_flex().gap(5).flex_wrap().max_h(100).min_h(0).overflow_y_scroll().children(selected.map(name =>
      Button.new(`${this.id}-remove-${name}`).tab_index(0).rounded(4).cursor_pointer().disabled(this.busy)
        .hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover)).accessibility_label(`Remove tag ${name}`)
        .on_click((_e, cx) => { if (!this.busy) { this.draft.remove(name); cx.notify(); } })
        .child(h_flex().items_center().gap(3).child(tagPill(t, name, color(name)))
          .child(div().text_size(11).text_color(secondary).child("×"))))));
    box.child(Input.new(this.search).id(`${this.id}-search`).h(32).px(10).rounded(6)
      .border_1().border_color(t.input).bg(t.background).text_size(12)
      .accessibility_label("Search existing tags or create a new tag"));
    if (this.loading) box.child(div().role("status").text_size(11).text_color(secondary).child("Loading tags…"));
    else if (this.error) box.child(div().role("alert").text_size(11).whitespace_normal().child(this.error));
    else {
      const options = this.draft.options(this.query);
      const list = v_flex().id(`${this.id}-options`).max_h(100).min_h(0).overflow_y_scroll().gap(2);
      for (const entry of options) {
        const chosen = selected.includes(entry.name), full = selected.length >= 8 && !chosen;
        list.child(Button.new(`${this.id}-option-${entry.name}`).tab_index(0).w_full().min_w(0).px(7).py(4)
          .rounded(4).cursor_pointer().selected(chosen).disabled(this.busy || full)
          .bg(chosen ? t.selected : t.background).hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
          .accessibility_label(`${chosen ? "Deselect" : "Select"} tag ${entry.name}`)
          .on_click((_e, cx) => this.choose(entry.name, cx))
          .child(h_flex().gap(7).items_center().child(div().text_color(secondary).child(chosen ? "✓" : "+"))
            .child(tagPill(t, entry.name, entry.color ?? color(entry.name)))));
      }
      const create = this.draft.createName(this.query);
      if (create) list.child(Button.new(`${this.id}-create`).tab_index(0).w_full().px(7).py(4).rounded(4)
        .cursor_pointer().disabled(this.busy || selected.length >= 8)
        .hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
        .accessibility_label(`Create tag ${create}`).on_click((_e, cx) => this.choose(create, cx))
        .child(h_flex().gap(7).items_center().child(div().text_color(secondary).child("Create"))
          .child(tagPill(t, create, color(create)))));
      if (!create && !options.length) list.child(div().text_size(11).text_color(secondary)
        .child(this.query.trim() ? "Use 1–32 letters, digits or hyphens." : "No tags yet. Type a name to create one."));
      box.child(list);
    }
    return box.child(div().role("status").text_size(11).text_color(secondary).whitespace_normal()
      .child(this.draft.error ?? (selected.length >= 8 ? "Up to 8 tags. Remove a selected tag to add another."
        : `${selected.length}/8 selected · Enter selects or creates · remove all to clear`)));
  }
}


/** "+ New ticket": a centered dialog with room for a real description. */
class NewTicket {
  init(input, cx) {
    const p = input ?? props() ?? {};
    bindComposerKeys(cx);
    this.root = p.root;
    this.slug = p.slug;
    this.parentRef = p.parent_ref ?? null;
    this.parentTitle = p.parent_title ?? null;
    this.msg = null;
    this.busy = false;
    this.priority = null;
    this.title = InputState.new({ placeholder: "What needs doing" });
    this.disposed = false;
    this.overlay = p.overlay ?? props()?.overlay;
    this.tags = new TagPicker();
    this.tags.init(this.root, [], "tk-new-tags", cx);
    this.body = TextareaState.new({ value: BODY_TEMPLATE, rows: 14 });
    this.title.on("submit", () => this.body.focus());
    this.title.focus();
    cx.timer.after(300, () => { if (!this.disposed) this.title.focus(); });
    this.handle = cx.focus_handle();
  }

  dispose() {
    this.disposed = true;
    this.title.release();
    this.body.release();
    this.tags.dispose();
    this.handle.release();
  }

  close() {
    closeOverlay(this.overlay);
  }

  submit(cx) {
    if (this.busy) return;
    const title = this.title.value().trim();
    if (!title) {
      this.msg = "A ticket needs a title";
      cx.notify();
      return;
    }
    const body = this.body.value();
    const tags = this.tags.names().join(",");
    const priority = this.priority;
    const isTemplate = body.replace(/\s+/g, " ").trim() === BODY_TEMPLATE.replace(/\s+/g, " ").trim();
    this.busy = true;
    this.tags.busy = true;
    this.msg = "Issuing…";
    cx.notify();
    cx.spawn(async (acx) => {
      try {
        await tk(["new", title, `--tags=${tags}`, `--priority=${priority ?? ""}`, ...(this.parentRef ? ["--parent", this.parentRef] : []), ...(isTemplate ? [] : [`--body=${body}`])], this.root);
        this.close();
      } catch (e) {
        this.busy = false;
        if (this.disposed) return;
        this.tags.busy = false;
        this.msg = `Issue failed: ${String(e?.message ?? e)}`;
        acx.notify();
      }
    });
  }

  key(e, cx) {
    if (e.key === "escape") { if (!this.busy) this.close(); }
    else return;
    cx.stop_propagation();
  }

  render(_cx) {
    const t = theme();
    const label = (text) => div().pt(10).pb(5).text_size(11.5).text_color(t.dim).child(text);
    return v_flex()
      .id("tk-new-ticket")
      .track_focus(this.handle)
      .key_context("HerdrTicketCompose")
      .on_action("herdr-ticket-submit", (_e, cx) => { this.submit(cx); cx.stop_propagation(); })
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().text_size(15).font_semibold().child(this.parentRef ? `New subtask · ${this.parentRef}` : "New ticket"))
          .child(div().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.dim).child(this.slug ?? ""))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child((this.root ?? "").replace(home(), "~")))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(Boolean(this.parentRef), el => el.child(div().pt(8).text_size(12).whitespace_normal()
        .child(`Parent: ${this.parentRef} · ${this.parentTitle ?? ""}`)))
      .child(label("Title"))
      .child(Input.new(this.title).h(34).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13))
      .child(label("Priority · optional"))
      .child(priorityChoices(t, "tk-new-priority", this.priority, this.busy, (value, cx) => {
        if (!this.busy) { this.priority = value; cx.notify(); }
      }, isDarkBackground(t.background)))
      .child(label("Tags · optional"))
      .child(this.tags.render(t))
      .child(label("Description"))
      .child(Textarea.new(this.body).flex_1().min_h(0).px(10).py(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
      .child(
        h_flex()
          .pt(14)
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.msg ? t.foreground : t.dim).child(this.msg ?? "⌘Enter to issue"))
          .child(button(t, "tk-new-cancel", "Cancel", false, () => this.close()).disabled(this.busy))
          .child(button(t, "tk-new-issue", this.busy ? "Issuing…" : "Issue", true, (_e, cx) => this.submit(cx)).disabled(this.busy)),
      );
  }
}

class EditTicket {
  init(input, cx) {
    const p = input ?? props() ?? {};
    bindComposerKeys(cx);
    this.root = p.root;
    this.ref = p.ref;
    this.overlay = p.overlay ?? props()?.overlay;
    this.loading = true;
    this.busy = false;
    this.disposed = false;
    this.original = null;
    this.error = null;
    this.title = InputState.new({ placeholder: "What needs doing" });
    this.body = TextareaState.new({ rows: 14 });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.title.on("submit", () => { if (!this.busy) this.body.focus(); });
    for (const field of [this.title, this.body]) field.on("change", (_e, acx) => {
      this.error = null;
      acx.notify();
    });
    cx.spawn(async acx => {
      try {
        const ticket = await tk(["show", this.ref, "--latest-handoff"], this.root);
        if (this.disposed) return;
        this.original = { title: ticket.title, body: ticket.body };
        this.title.set_value(ticket.title);
        this.body.set_value(ticket.body);
        this.title.focus();
        acx.timer.after(300, () => { if (!this.disposed) this.title.focus(); });
      } catch (error) {
        if (this.disposed) return;
        this.error = `Load failed: ${String(error?.message ?? error)}`;
      } finally {
        this.loading = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.title.release();
    this.body.release();
    this.handle.release();
  }

  close() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  submit(cx) {
    if (this.loading || this.busy || this.disposed || !this.original) return;
    const title = this.title.value().trim(), body = this.body.value();
    if (!title) {
      this.error = "A ticket needs a title";
      cx.notify();
      return;
    }
    const args = ["edit", this.ref];
    if (title !== this.original.title) args.push(`--title=${title}`);
    if (body !== this.original.body) args.push(`--body=${body}`);
    if (args.length === 2) { this.close(); return; }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async acx => {
      try {
        await tk(args, this.root, { attachSession: false });
        if (!this.disposed) closeOverlay(this.overlay);
      } catch (error) {
        if (this.disposed) return;
        this.busy = false;
        this.error = `Save failed: ${String(error?.message ?? error)}`;
        acx.notify();
      }
    });
  }

  render() {
    const t = theme(), secondary = t.muted ?? t.foreground;
    const root = v_flex().id("tk-edit-ticket").size_full().min_h(0).p(18).gap(10)
      .bg(t.popover).text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      .key_context("HerdrTicketCompose")
      .on_action("herdr-ticket-submit", (_e, cx) => { this.submit(cx); cx.stop_propagation(); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(17).font_semibold().child(`Edit ticket · ${this.ref}`))
      .child(div().text_size(10).text_color(secondary).truncate().tooltip(this.root).child((this.root ?? "").replace(home(), "~")));
    if (this.loading) root.child(div().role("status").child("Loading ticket…"));
    if (this.original) root
      .child(div().text_size(11.5).text_color(secondary).child("Title"))
      .child(Input.new(this.title).id("tk-edit-title").h(34).px(10).rounded(7).border_1()
        .border_color(t.input).bg(t.background).text_size(13).disabled(this.busy).accessibility_label("Ticket title"))
      .child(div().text_size(11.5).text_color(secondary).child("Description"))
      .child(Textarea.new(this.body).id("tk-edit-body").flex_1().min_h(0).px(10).py(8).rounded(7).border_1()
        .border_color(t.input).bg(t.background).text_size(12.5).disabled(this.busy).accessibility_label("Ticket description"));
    else root.child(div().flex_1());
    if (this.error) root.child(div().role("alert").text_size(12).whitespace_normal().child(this.error));
    return root.child(h_flex().gap(8).items_center().pt(4)
      .child(div().flex_1().min_w(0).text_size(11).text_color(secondary).child(this.busy ? "Saving…" : "⌘Enter to save · Esc to cancel"))
      .child(button(t, "tk-edit-cancel", "Cancel", false, () => this.close()).disabled(this.busy))
      .child(button(t, "tk-edit-save", this.busy ? "Saving…" : "Save", true, (_e, cx) => this.submit(cx))
        .disabled(this.busy || this.loading || !this.original)));
  }
}

class EditTags {
  init(input, cx) {
    const p = input ?? props() ?? {};
    this.root = p.root;
    this.ref = p.ref;
    this.title = p.title;
    this.disposed = false;
    this.overlay = p.overlay ?? props()?.overlay;
    this.tags = new TagPicker();
    this.tags.init(this.root, p.tags ?? [], "tk-edit-tags", cx);
    this.busy = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.tags.focus();
    cx.timer.after(300, () => this.tags.focus());
  }

  dispose() {
    this.disposed = true;
    this.tags.dispose();
    this.handle.release();
  }

  submit(cx) {
    if (this.busy) return;
    const value = this.tags.names().join(",");
    this.busy = true;
    this.tags.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async acx => {
      try {
        await tk(["edit", this.ref, `--tags=${value}`], this.root);
        closeOverlay(this.overlay);
      } catch (e) {
        this.busy = false;
        if (this.disposed) return;
        this.tags.busy = false;
        this.error = String(e?.message ?? e);
        acx.notify();
      }
    });
  }

  render() {
    const t = theme(), secondary = t.muted ?? t.foreground;
    return v_flex().id("tk-tags-dialog").size_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (e.key === "escape") { if (!this.busy) closeOverlay(this.overlay); cx.stop_propagation(); }
        else if (e.key === "enter" && e.modifiers.platform) { this.submit(cx); cx.stop_propagation(); }
      })
      .child(div().text_size(17).font_semibold().child(`Tags · ${this.ref}`))
      .child(div().text_size(12).text_color(secondary).truncate().tooltip(this.title).child(this.title))
      .child(this.tags.render(t))
      .when(Boolean(this.error), el => el.child(div().role("alert").text_size(12).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button(t, "tk-tags-cancel", "Cancel", false, () => closeOverlay(this.overlay)).disabled(this.busy))
        .child(button(t, "tk-tags-save", this.busy ? "Saving…" : "Save tags", true, (_e, cx) => this.submit(cx)).disabled(this.busy)));
  }
}

class DeleteTicket {
  init(input, cx) {
    const p = input ?? props() ?? {};
    this.root = p.root;
    this.ref = p.ref;
    this.title = p.title;
    this.busy = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.cancelFocus = cx.focus_handle();
    this.cancelFocus.focus();
    cx.timer.after(300, () => this.cancelFocus.focus());
  }

  submit(cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async acx => {
      try {
        await tk(["delete", this.ref, "--yes"], this.root);
        closeOverlay(props()?.overlay);
      } catch (e) {
        this.busy = false;
        this.error = `Delete failed: ${String(e?.message ?? e)}`;
        acx.notify();
      }
    });
  }

  dispose() {
    this.handle.release();
    this.cancelFocus.release();
  }

  render() {
    const t = theme(), secondary = t.muted ?? t.foreground;
    return v_flex().id("tk-delete-dialog").size_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (e.key === "escape" && !this.busy) { closeOverlay(props()?.overlay); cx.stop_propagation(); }
      })
      .child(div().text_size(17).font_semibold().child(`Delete ${this.ref}?`))
      .child(div().text_size(13).whitespace_normal().child(this.title))
      .child(div().text_size(12).text_color(secondary).whitespace_normal()
        .child("This permanently deletes the ticket, its handoffs and history. This cannot be undone."))
      .when(Boolean(this.error), el => el.child(div().role("alert").text_size(12).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button(t, "tk-delete-cancel", "Cancel", false, () => closeOverlay(props()?.overlay))
          .track_focus(this.cancelFocus).disabled(this.busy))
        .child(button(t, "tk-delete-confirm", this.busy ? "Deleting…" : "Delete ticket", true, (_e, cx) => this.submit(cx))
          .disabled(this.busy)));
  }
}

const ROLES = { new: NewTicket, edit: EditTicket, tags: EditTags, priority: PriorityEditor, delete: DeleteTicket, agent: AgentPicker, detail: TicketPanel, "label-runtime": SessionLabelRuntime };

/** One mod: the repository panel and its ticket dialogs. */
export default class HerdrTicket extends View {
  init(p, cx) {
    this.role?.dispose?.();
    const input = p ?? props() ?? {};
    const Role = ROLES[input.role] ?? TicketPanel;
    this.role = new Role();
    this.role.init(input, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  close() {
    this.role?.dispose?.();
    this.role = null;
  }
}
