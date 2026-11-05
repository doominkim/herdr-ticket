# herdr-ticket

A panel on the right of the window with the tickets of the repository the focused pane is in, in four fixed groups. Each ticket shows its latest handoff and, under it, the agent session that last worked on it, drawn like a row of the Agents sidebar; clicking it goes to that agent.

## What you see

- A 380px block on the right (`place: right`), surface background, 12px padding.
- Header: the repository's slug (14px, semibold), its main worktree path (11px, dim, truncated), and a **+ New ticket** button.
- Four groups, always present, always in this order: **Todo**, **In progress**, **In review**, **Done**, each a dim 11.5px label with its count; an empty group says "No tickets". Canceled tickets are not shown.
- A ticket: a raised card with a 1px border (accent when expanded): its ref (`APP-3`, dim), its title (semibold, truncated), its latest handoff summary (dim, one line), and its session row.
- Session row, 26px: the agent's program icon (14px), the terminal's title, the time since the session was attached, and the sidebar's status mark: a spinning `mods/workspace-chrome/spinner.svg` while working, a "Needs you" chip when blocked, a filled dot when done, a ring when idle. An ended session is a dim ring with "Session ended · t12".
- Expanded ticket: its body, the latest handoff's author, branch and summary, and buttons **Start agent** / **Go to agent**, **→ next status**, and **Delete** on the right.

## How it behaves

- The panel follows the focused pane's folder. When that folder is outside any git repository, it shows the repository of the ticket the focused terminal works on; otherwise "Not in a git repository".
- Every 2 s it reads `tk rev` and reloads only when that number or the focus changed, so tickets written by agents from other terminals appear within 2 s.
- Clicking a ticket's title expands or folds it. The status button moves todo → in_progress → in_review → done.
- **Start agent** runs Claude Code in a new tab of the focused space, in the repository folder, with the first message "Continue ticket APP-3. First read it and its latest handoff with `tk show APP-3`.", links that terminal to the ticket and names the tab after the ticket. When the ticket's session is live the button reads **Go to agent** and focuses it.
- **Delete** asks inline ("Delete APP-3 with its handoffs? Cancel / Delete") before running `tk delete --yes`.
- **+ New ticket** opens a title field and a body area; empty body gets the `## Goal` / `## Done when` template.

## Built from

- One mod, `mods/herdr-ticket/` (`main.js`, `mod.json`). No layout of its own.
- Data from the `tk` CLI at `~/.local/bin/tk` through `exec`: `rev`, `repo`, `brief`, `ls --status done`, `ls --all-repos --terminal`, `new`, `status`, `delete --yes`, `link`.
- `herdr` functions: `focused()` (folder, space, terminal), `terminals()` (live state, status, title and program of a session), `hc(["run", …])` with `herdr.space`/`herdr.tab` labels to open the agent in a new tab, `run("tab.rename" | "agent.focus" | "pane.focus")`, `theme()`, `home()`.
- `gpui-base` `Input` and `Textarea` for the new-ticket form (IME input works).
- The status marks and icons copy the shipped Agents sidebar; the spinner is the shipped `mods/workspace-chrome/spinner.svg`.

## Watch out

- The mod runs `~/.local/bin/tk`; install the CLI there first.
- A terminal's reported folder is where it started; an agent started in a parent folder and `cd`-ing into a repo is found through its linked ticket, not its folder.
- Sessions attach when `tk` runs inside a Herdr terminal (`HC_TERMINAL_ID`); agents started elsewhere show no session until linked.
- **Start agent** always starts `claude`.
- Only local machines: remote spaces are not handled.

## Done when

- The four groups show in order with counts even when empty.
- A ticket issued with `tk new` in another terminal of the same repository appears within 2 s.
- Starting an agent from a ticket opens a named tab, and the ticket shows that session with its live status; clicking it goes there; after the agent exits the row says "Session ended".
- Delete asks once more and removes the ticket.
- `herdr-app check mods/herdr-ticket` passes.
