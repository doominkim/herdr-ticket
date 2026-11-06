import { div } from "gpui-kit";
import { panes, run, setShared, shared, spaces, terminals } from "herdr";
import { tk } from "./commands.js";
import { planSessionLabels } from "./session-label-state.js";

const STATE_KEY = "herdr-ticket.session-label-state";
export const SESSION_LABEL_ERROR = "herdr-ticket.session-label-error";

/** Always-shown, empty floating role: a hidden panel is not initialized on cold start. */
export class SessionLabelRuntime {
  /** @param {unknown} _input @param {import("gpui-kit").AsyncContext} cx */
  init(_input, cx) {
    this.disposed = false;
    this.loading = false;
    this.rev = null;
    this.owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    /** @type {{ref: string, status: string, session?: {terminal?: string} | null}[]} */
    this.tickets = [];
    cx.timer.every(2000, acx => this.poll(acx));
    this.poll(cx);
  }

  /** @param {string | null} value */
  error(value) {
    if (shared(SESSION_LABEL_ERROR) !== value) setShared(SESSION_LABEL_ERROR, value);
  }

  /** @param {import("gpui-kit").AsyncContext} cx */
  poll(cx) {
    if (this.disposed || this.loading) return;
    this.loading = true;
    cx.spawn(async () => {
      try {
        const { rev } = await tk(["rev"], undefined);
        if (this.disposed) return;
        if (this.rev !== rev) {
          const { tickets } = await tk(["ls", "--all-repos", "--status", "in_progress"], undefined);
          if (this.disposed) return;
          this.tickets = tickets;
          this.rev = rev;
        }
        const tabs = spaces().filter(space => !space.machine && !space.id.includes("/"))
          .flatMap(space => space.tabs);
        const live = new Set(terminals().filter(terminal => terminal.state === "live").map(terminal => terminal.address));
        const localPanes = panes().flatMap(pane => pane.terminal && live.has(pane.terminal)
          ? [{ terminal: pane.terminal, tab: pane.tab }] : []);
        const previous = shared(STATE_KEY);
        const plan = planSessionLabels(this.tickets, localPanes, tabs, previous, { owner: this.owner, now: Date.now() });
        // Publish the writer lease and pending targets before run() can enqueue any native request.
        if (JSON.stringify(previous ?? null) !== JSON.stringify(plan.state)) setShared(STATE_KEY, plan.state);
        for (const rename of plan.renames) run("tab.rename", rename);
        this.error(null);
      } catch (error) {
        if (!this.disposed) this.error(String(error instanceof Error ? error.message : error));
      } finally {
        this.loading = false;
      }
    });
  }

  render() { return div(); }
  dispose() { this.disposed = true; }
}
