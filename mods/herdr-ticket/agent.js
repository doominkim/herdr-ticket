import { div } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input } from "gpui-base";
import { agents, terminals, panes, spaces, focused, exec, hc, run, home, theme, props, closeOverlay } from "herdr";
import { tk } from "./commands.js";

const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const message = (error) => String(error?.message ?? error);
const tabId = () => {
  let hex = "";
  while (hex.length < 32) hex += Math.floor(Math.random() * 16).toString(16);
  return `tb${hex}`;
};

async function git(cwd, args) {
  const result = await exec("git", args, { cwd });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git failed").trim());
  return result.stdout.trim();
}

async function repository(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const common = await git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { top, common };
}

function button(t, id, label, action, selected = false) {
  return Button.new(id).tab_index(0).px(10).py(8).rounded(6).border_1()
    .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.raised)
    .text_color(t.foreground).text_size(12).cursor_pointer()
    .hover(el => el.border_color(t.accent)).focus(el => el.border_color(t.accent))
    .on_click(action).child(label);
}

/** A captured ticket/repository destination; focus changes never change the operation's target. */
export class AgentPicker {
  init(input, cx) {
    const p = input ?? props() ?? {};
    this.root = p.root;
    this.ref = p.ref;
    this.title = p.title;
    this.attached = p.session?.terminal ?? null;
    this.overlay = p.overlay ?? props()?.overlay;
    this.space = focused()?.space ?? null;
    this.mode = "new";
    this.selected = null;
    this.repo = null;
    this.list = [];
    this.loading = true;
    this.busy = false;
    this.disposed = false;
    this.error = null;
    this.created = null;
    this.worktreeAttempt = null;
    this.pending = null;
    this.branch = InputState.new({ value: `ticket/${String(this.ref ?? "").toLowerCase()}`, placeholder: "ticket/my-branch" });
    this.branch.on("change", (_e, acx) => { if (!this.busy) this.error = null; acx.notify(); });
    this.branch.on("submit", (_e, acx) => this.submit(acx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async acx => {
      try {
        this.localSpace();
        if (!this.root || !this.ref) throw new Error("A repository and ticket are required.");
        const repo = await repository(this.root);
        if (this.disposed) return;
        this.root = repo.top;
        this.repo = repo;
        const list = [];
        // PaneInfo.cwd is the SDK's documented live folder, not a terminal's launch directory.
        for (const candidate of this.candidates()) {
          try {
            if ((await repository(candidate.cwd)).common === repo.common) list.push(candidate);
          } catch { /* Folders outside Git are not destinations for this repository. */ }
          if (this.disposed) return;
        }
        this.list = list.sort((a, b) => Number(b.address === this.attached) - Number(a.address === this.attached));
        if (this.list.some(candidate => candidate.address === this.attached)) {
          this.mode = "existing";
          this.selected = this.attached;
        }
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  localSpace() {
    if (this.disposed) throw new Error("The agent picker was closed.");
    const space = spaces().find(item => item.id === this.space);
    if (!space) throw new Error("The original Herdr space is no longer available. Reopen this dialog.");
    if (space.machine || space.id.includes("/")) throw new Error("Remote agent destinations are not supported by the local tk CLI.");
    return space;
  }

  candidates() {
    const live = new Set(terminals().filter(item => item.state === "live").map(item => item.address));
    const allPanes = panes();
    const local = new Set(spaces().filter(item => !item.machine && !item.id.includes("/")).map(item => item.id));
    return agents().filter(agent => local.has(agent.space) && !agent.address.includes("/") && live.has(agent.address))
      .flatMap(agent => {
        const pane = allPanes.find(item => item.terminal === agent.address);
        return pane?.cwd ? [{ address: agent.address, cwd: pane.cwd, status: agent.status,
          name: agent.tab_name || agent.title || agent.program.name, space: agent.space }] : [];
      });
  }

  async source() {
    this.localSpace();
    const repo = await repository(this.root);
    this.localSpace();
    if (repo.common !== this.repo.common || repo.top !== this.root) throw new Error("The original repository changed. Reopen this dialog.");
    return repo;
  }

  async existing(address) {
    const candidate = this.candidates().find(item => item.address === address);
    if (!candidate) throw new Error("That agent is no longer live in a known local folder. Choose another destination.");
    const repo = await repository(candidate.cwd);
    this.localSpace();
    const current = this.candidates().find(item => item.address === address);
    if (!current || current.cwd !== candidate.cwd || repo.common !== this.repo.common) {
      throw new Error("That agent moved or no longer belongs to this repository. Choose another destination.");
    }
    return current;
  }

  path(branch = this.branch.value().trim()) {
    const name = this.repo?.top.split("/").pop() ?? "repository";
    return `${home()}/.herdr/worktrees/${name}/${slug(branch)}`;
  }

  choose(mode, address, cx) {
    if (this.busy || this.pending || this.worktreeAttempt) return;
    this.mode = mode;
    this.selected = address ?? null;
    this.error = null;
    if (mode === "worktree") this.branch.focus();
    cx.notify();
  }

  async worktree(branch) {
    if (this.created) {
      const repo = await repository(this.created.path);
      if (repo.common !== this.repo.common || repo.top !== this.created.path) throw new Error("The created worktree changed; inspect it before continuing.");
      return this.created.path;
    }
    if (this.worktreeAttempt) throw new Error("Worktree creation was already attempted. Inspect the reported path before starting again.");
    if (!branch || !slug(branch)) throw new Error("Enter a branch name with a usable path slug.");
    const valid = await git(this.root, ["check-ref-format", "--branch", branch]);
    if (valid !== branch) throw new Error("Use a literal branch name, not a previous-checkout expression.");
    await git(this.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const exists = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.root });
    if (exists.code !== 0 && exists.code !== 1) throw new Error((exists.stderr || "Could not check the local branch.").trim());
    this.localSpace();
    const path = this.path(branch);
    this.worktreeAttempt = path;
    const args = exists.code === 0 ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "-b", branch, "--", path, "HEAD"];
    await git(this.root, args);
    this.created = { path, branch };
    this.localSpace();
    return path;
  }

  async launch(cwd) {
    this.localSpace();
    if (!this.pending) this.pending = { cwd, tab: tabId(), address: null, attempted: false, linked: false };
    const pending = this.pending;
    if (pending.cwd !== cwd) throw new Error("Continue with the already-created destination.");
    if (pending.address) return pending;
    if (pending.attempted) throw new Error("The launch result is unknown. Inspect the reported tab before starting another agent.");
    pending.attempted = true;
    const prompt = `Continue ticket ${this.ref}. First read it and its latest handoff with \`tk show ${this.ref} --latest-handoff\`.`;
    const result = await hc([
      "run", "--bg", "--json", "--no-parent", "--keep", "--cwd", cwd,
      "--label", `herdr.space=${this.space}`, "--label", `herdr.tab=${pending.tab}`, "--", "claude", prompt,
    ]);
    try {
      const address = JSON.parse(result.stdout).address;
      if (typeof address === "string" && address && !address.includes("/")) pending.address = address;
    } catch { /* Keep the tab id for inspection; never repeat an ambiguous launch. */ }
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "hc run failed").trim().split("\n")[0]);
    if (!pending.address) throw new Error("The agent launch returned no local terminal address; it will not be repeated.");
    return pending;
  }

  submit(cx) {
    if (this.busy || this.loading || !this.repo || this.disposed) return;
    const mode = this.mode, selected = this.selected, branch = this.branch.value().trim();
    if (mode === "existing" && !selected) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async acx => {
      try {
        await this.source();
        if (mode === "existing") {
          const target = await this.existing(selected);
          await tk(["link", this.ref, "--terminal", target.address], this.root);
          await this.existing(target.address);
          // Linking/focusing never sends input, including to working or blocked agents.
          run("agent.focus", { terminal: target.address });
        } else {
          const cwd = mode === "worktree" ? await this.worktree(branch) : this.root;
          const pending = await this.launch(cwd);
          this.localSpace();
          if (!pending.linked) {
            await tk(["link", this.ref, "--terminal", pending.address], this.root);
            pending.linked = true;
          }
          await acx.sleep(800); // The app adopts the labeled core terminal into its new tab.
          this.localSpace();
          run("tab.rename", { id: pending.tab, name: `${this.ref} ${this.title}`.slice(0, 40) });
          run("pane.focus", { terminal: pending.address });
        }
        this.close();
      } catch (error) {
        this.error = message(error);
      } finally {
        this.busy = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  close() {
    if (!this.disposed) closeOverlay(this.overlay);
  }

  dispose() {
    this.disposed = true;
    this.branch.release();
    this.handle.release();
  }

  render() {
    const t = theme(), muted = t.muted ?? t.foreground;
    const locked = this.busy || Boolean(this.pending || this.worktreeAttempt);
    const uncertain = this.pending?.attempted && !this.pending.address;
    const failedWorktree = this.worktreeAttempt && !this.created;
    const root = v_flex().id("tk-agent-picker").size_full().min_h(0).p(20).gap(12)
      .bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) this.close(); cx.stop_propagation(); }
        else if (event.key === "enter" && event.modifiers.platform) { this.submit(cx); cx.stop_propagation(); }
      })
      .child(div().font_semibold().text_size(17).child(`Agent destination · ${this.ref}`))
      .child(div().text_size(13).truncate().tooltip(this.title).child(this.title))
      .child(div().text_size(11).text_color(muted).truncate().tooltip(this.root).child(this.root ?? ""));
    const body = v_flex().id("tk-agent-destinations").flex_1().min_h(0).gap(8).overflow_y_scrollbar();
    body.child(div().font_semibold().child("Existing agents · this repository"));
    if (this.loading) body.child(div().text_color(muted).child("Checking repository and live agents…"));
    else if (!this.list.length) body.child(div().text_color(muted).child("No live local agents with a known repository folder."));
    for (const candidate of this.list) {
      const attached = candidate.address === this.attached;
      body.child(button(t, `tk-agent-${candidate.address}`, `${attached ? "Attached · " : ""}${candidate.name} · ${candidate.address} · ${candidate.status}`,
        (_event, cx) => this.choose("existing", candidate.address, cx), this.mode === "existing" && this.selected === candidate.address)
        .disabled(locked).tooltip(candidate.cwd));
    }
    body.child(div().pt(8).font_semibold().child("Start Claude Code"));
    body.child(button(t, "tk-agent-new-tab", "New Herdr tab · original repository", (_event, cx) => this.choose("new", null, cx), this.mode === "new").disabled(locked));
    body.child(button(t, "tk-agent-new-worktree", "New worktree + Herdr tab", (_event, cx) => this.choose("worktree", null, cx), this.mode === "worktree").disabled(locked));
    if (this.mode === "worktree") {
      body.child(div().pt(5).child("Branch"));
      body.child(Input.new(this.branch).h(34).px(10).rounded(6).border_1().border_color(t.input).bg(t.background)
        .disabled(locked).accessibility_label("Worktree branch"));
      body.child(div().text_size(11).text_color(muted).whitespace_normal().child(this.path()));
      body.child(div().text_size(11).text_color(muted).whitespace_normal()
        .child("Only committed content is copied; uncommitted changes stay here. A new branch starts at HEAD; an existing local branch uses its own commit."));
    }
    root.child(body);
    if (this.worktreeAttempt) root.child(div().text_size(11).whitespace_normal().child(`${this.created ? "Created worktree" : "Worktree creation attempted"}: ${this.worktreeAttempt}`));
    if (this.pending) root.child(div().text_size(11).whitespace_normal()
      .child(`${this.pending.address ? `Created session: ${this.pending.address}` : "Launch attempted; result may be unknown"} · tab ${this.pending.tab}`));
    if (this.error) root.child(div().role("alert").text_size(12).whitespace_normal().child(this.error));
    root.child(div().text_size(11).text_color(muted).whitespace_normal().child("Existing agents receive no prompt. Linking or launching does not change ticket status."));
    return root.child(h_flex().gap(8).justify_end()
      .child(button(t, "tk-agent-cancel", "Cancel", () => this.close()).disabled(this.busy))
      .child(button(t, "tk-agent-go", this.busy ? "Opening…" : this.pending?.address || this.created ? "Continue" : "Go", (_event, cx) => this.submit(cx), true)
        .disabled(this.busy || this.loading || !this.repo || Boolean(uncertain || failedWorktree))));
  }
}
