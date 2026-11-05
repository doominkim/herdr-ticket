// herdr-ticket panel: the tickets of the focused pane's repository (its original main worktree),
// read through the `tk` CLI. Agents write through the same CLI, so the panel polls `tk rev` and
// reloads only when something changed. Each ticket shows the Herdr session that last worked on it
// (a write from inside a Herdr terminal attaches it), drawn like a row of the Agents sidebar.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, focused, terminals, hc, run, theme, home } from "herdr";

const TK = () => `${home()}/.local/bin/tk`;
const POLL_MS = 2000;
const GROUPS = [
  { status: "todo", name: "Todo" },
  { status: "in_progress", name: "In progress" },
  { status: "in_review", name: "In review" },
  { status: "done", name: "Done" },
];
const NEXT = { todo: "in_progress", in_progress: "in_review", in_review: "done" };

async function tk(args, cwd) {
  const r = await exec(TK(), [...args, "--json"], cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "tk failed").trim().replace(/^tk: /, ""));
  return JSON.parse(r.stdout);
}

const tabId = () => {
  let hex = "";
  while (hex.length < 32) hex += Math.floor(Math.random() * 16).toString(16);
  return `tb${hex}`;
};

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The same marks and icon as the Agents sidebar (mods/my-agents).
function mark(t, status) {
  const color = t[status] ?? t.dim;
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).bg(status === "done" ? color : t.dim + "00");
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export default class TicketPanel extends View {
  init(_props, cx) {
    this.cwd = null; // the repository folder the data was loaded for
    this.key = null; // focused folder + terminal it was loaded for
    this.repo = null;
    this.tickets = [];
    this.rev = -1;
    this.error = null;
    this.open = null; // ref of the expanded ticket
    this.confirmDelete = null; // ref waiting for a second click
    this.form = null;
    this.msg = null;
    this.loading = false;
    cx.timer.every(POLL_MS, (acx) => this.poll(acx));
    cx.timer.every(30000, (acx) => acx.notify()); // session times
    this.poll(cx);
  }

  // ---- data

  poll(cx) {
    const f = focused();
    const cwd = f?.cwd ?? null;
    const key = `${cwd}\u0000${f?.terminal ?? ""}`;
    if (!cwd || this.loading) return;
    cx.spawn(async (acx) => {
      try {
        const { rev } = await tk(["rev"]);
        if (key === this.key && rev === this.rev) return;
        this.loading = true;
        const root = await this.repoRoot(cwd, f?.terminal);
        const [brief, done] = await Promise.all([tk(["brief", "--cwd", root]), tk(["ls", "--status", "done", "--cwd", root])]);
        this.repo = brief.repo;
        this.tickets = [...brief.tickets, ...done.tickets];
        this.cwd = root;
        this.error = null;
      } catch (e) {
        this.cwd = cwd;
        this.repo = null;
        this.tickets = [];
        this.error = String(e?.message ?? e);
      } finally {
        this.key = key;
        this.rev = (await tk(["rev"]).catch(() => ({ rev: -1 }))).rev;
        this.loading = false;
        acx.notify();
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

  /** The live core terminal behind a ticket's session, or null when it has ended. */
  terminal(ticket) {
    const addr = ticket.session?.terminal;
    return addr ? terminals().find((x) => x.address === addr && x.state === "live") ?? null : null;
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

  goTo(term) {
    if (term.status) run("agent.focus", { terminal: term.address });
    else run("pane.focus", { terminal: term.address });
  }

  startAgent(cx, x) {
    const f = focused();
    if (!f?.space || !this.cwd) return;
    const tab = tabId();
    const prompt = `Continue ticket ${x.ref}. First read it and its latest handoff with \`tk show ${x.ref}\`.`;
    this.msg = `Starting an agent for ${x.ref}…`;
    cx.notify();
    cx.spawn(async (acx) => {
      try {
        const r = await hc([
          "run", "--bg", "--json", "--no-parent", "--keep", "--cwd", this.cwd,
          "--label", `herdr.space=${f.space}`, "--label", `herdr.tab=${tab}`, "--", "claude", prompt,
        ]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc run failed").trim().split("\n")[0]);
        const addr = JSON.parse(r.stdout).address;
        await tk(["link", x.ref, "--terminal", addr], this.cwd);
        this.msg = null;
        await acx.sleep(800); // the app adopts the terminal into the new tab a moment later
        run("tab.rename", { id: tab, name: `${x.ref} ${x.title}`.slice(0, 40) });
      } catch (e) {
        this.msg = `Start failed: ${String(e?.message ?? e)}`;
      }
      this.reload(acx);
    });
  }

  openForm(cx) {
    const title = InputState.new({ placeholder: "Title" });
    const body = TextareaState.new({ placeholder: "## Goal / ## Done when (empty: template)", rows: 5 });
    title.on("submit", () => body.focus());
    this.form = { title, body };
    title.focus();
    cx.notify();
  }

  closeForm(cx) {
    this.form?.title.release();
    this.form?.body.release();
    this.form = null;
    cx.notify();
  }

  submitForm(cx) {
    const title = this.form.title.value().trim();
    const body = this.form.body.value();
    if (!title) {
      this.msg = "A ticket needs a title";
      cx.notify();
      return;
    }
    this.closeForm(cx);
    cx.spawn(async (acx) => this.act(acx, "Issue", ["new", title, ...(body.trim() ? ["--body", body] : [])]));
  }

  // ---- view

  render(_cx) {
    const t = theme();
    const root = v_flex().id("herdr-ticket").size_full().p(12).gap(10).bg(t.surface ?? t.background).text_color(t.foreground).text_size(12.5);
    const head = h_flex()
      .items_center()
      .gap(8)
      .child(div().text_size(14).font_semibold().child(this.repo ? this.repo.slug : "Tickets"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repo ? this.repo.root.replace(home(), "~") : ""))
      .when(Boolean(this.repo) && !this.form, (el) => el.child(this.button(t, "tk-new", "+ New ticket", false, (_e, cx) => this.openForm(cx))));
    root.child(head);
    if (this.msg) root.child(div().text_size(11.5).text_color(t.dim).child(this.msg));
    if (this.error) return root.child(div().text_color(t.dim).child(this.error.includes("not a git repository") ? "Not in a git repository" : this.error));
    if (!this.repo) return root.child(div().text_color(t.dim).child("Loading…"));
    if (this.form) root.child(this.formView(t));
    const list = v_flex().id("tk-list").flex_1().min_h(0).gap(14).overflow_y_scroll();
    for (const g of GROUPS) {
      const items = this.tickets.filter((x) => x.status === g.status).sort((a, b) => a.number - b.number);
      list.child(
        v_flex()
          .gap(6)
          .child(h_flex().gap(6).text_size(11.5).text_color(t.dim).child(div().font_semibold().child(g.name)).child(div().child(String(items.length))))
          .when(items.length === 0, (el) => el.child(div().pl(2).text_size(11).text_color(t.muted ?? t.dim).child("No tickets")))
          .children(items.map((x) => this.ticketView(t, x))),
      );
    }
    return root.child(list);
  }

  sessionView(t, x) {
    const term = this.terminal(x);
    if (!term) {
      return h_flex().px(6).h(26).gap(8).items_center().rounded(6).text_size(11.5).text_color(t.dim)
        .child(div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(`Session ended · ${x.session.terminal}`))
        .child(div().flex_none().text_size(11).child(duration(Date.now() - x.session.at)));
    }
    const pic = icon(term.program, 14, t.foreground);
    const name = clean(term.title) || term.program?.name || term.address;
    return h_flex()
      .id(`tk-session-${x.ref}`)
      .px(6)
      .h(26)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.goTo(term);
      })
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(duration(Date.now() - x.session.at)))
      .when(Boolean(term.status), (el) => el.child(mark(t, term.status)));
  }

  ticketView(t, x) {
    const isOpen = this.open === x.ref;
    const h = x.latest_handoff;
    const term = this.terminal(x);
    const card = v_flex()
      .id(`tk-${x.ref}`)
      .p(8)
      .gap(4)
      .rounded(6)
      .bg(t.raised)
      .border_1()
      .border_color(isOpen ? t.accent : t.border)
      .child(
        h_flex()
          .id(`tk-head-${x.ref}`)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.open = isOpen ? null : x.ref;
            this.confirmDelete = null;
            cx.notify();
          })
          .child(div().flex_none().text_size(11).text_color(t.dim).child(x.ref))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(x.title)),
      )
      .when(Boolean(h) && !isOpen, (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(h.summary)))
      .when(Boolean(x.session), (el) => el.child(this.sessionView(t, x)));
    if (!isOpen) return card;
    const next = NEXT[x.status];
    const confirming = this.confirmDelete === x.ref;
    return card
      .child(div().text_size(11.5).text_color(t.muted ?? t.dim).child(x.body.trim() || "(no body)"))
      .when(Boolean(h), (el) =>
        el.child(
          v_flex()
            .gap(2)
            .pt(4)
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`Latest handoff · ${h.provider ? `${h.provider}/${h.model}` : "human"}${h.branch ? ` · ${h.branch}` : ""}`))
            .child(div().text_size(11.5).child(h.summary)),
        ),
      )
      .child(
        confirming
          ? h_flex()
              .gap(6)
              .pt(4)
              .items_center()
              .child(div().flex_1().text_size(11.5).child(`Delete ${x.ref} with its handoffs?`))
              .child(this.button(t, `tk-del-no-${x.ref}`, "Cancel", false, (_e, cx) => { this.confirmDelete = null; cx.notify(); }))
              .child(this.button(t, `tk-del-yes-${x.ref}`, "Delete", true, (_e, cx) => {
                this.confirmDelete = null;
                this.open = null;
                cx.spawn(async (acx) => this.act(acx, "Delete", ["delete", x.ref, "--yes"]));
              }))
          : h_flex()
              .gap(6)
              .pt(4)
              .child(this.button(t, `tk-agent-${x.ref}`, term ? "Go to agent" : "Start agent", true, (_e, cx) => (term ? this.goTo(term) : this.startAgent(cx, x))))
              .when(Boolean(next), (el) =>
                el.child(this.button(t, `tk-next-${x.ref}`, `→ ${GROUPS.find((g) => g.status === next).name}`, false, (_e, cx) =>
                  cx.spawn(async (acx) => this.act(acx, "Move", ["status", x.ref, next])))),
              )
              .child(div().flex_1())
              .child(this.button(t, `tk-del-${x.ref}`, "Delete", false, (_e, cx) => { this.confirmDelete = x.ref; cx.notify(); })),
      );
  }

  formView(t) {
    return v_flex()
      .gap(6)
      .p(8)
      .rounded(6)
      .border_1()
      .border_color(t.accent)
      .child(Input.new(this.form.title).h(30).px(8).rounded(5).border_1().border_color(t.input).bg(t.background))
      .child(Textarea.new(this.form.body).h(110).px(8).py(4).rounded(5).border_1().border_color(t.input).bg(t.background))
      .child(
        h_flex()
          .gap(6)
          .justify_end()
          .child(this.button(t, "tk-form-cancel", "Cancel", false, (_e, cx) => this.closeForm(cx)))
          .child(this.button(t, "tk-form-save", "Issue", true, (_e, cx) => this.submitForm(cx))),
      );
  }

  button(t, id, text, primary, action) {
    return h_flex()
      .id(id)
      .h(26)
      .px(10)
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(primary ? t.solid ?? t.accent : t.input)
      .bg(primary ? t.solid ?? t.accent : t.raised)
      .text_color(primary ? t.solid_foreground ?? t.background : t.foreground)
      .text_size(11.5)
      .cursor_pointer()
      .on_click(action)
      .child(text);
  }
}
