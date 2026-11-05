# herdr-ticket

A 380px repository ticket panel beside the focused terminal. Scan two-line titles and explicit session states, read the latest handoff before expanding details, and keep completed work behind a separate filter.

![Earlier herdr-ticket panel](preview.png)

The screenshot predates the readability redesign; the native screenshot has not been refreshed yet. `ui-readability-proposal.html` is the approved standalone design reference, not a live product screenshot.

## What you see

- A 380px block on the right (`place: right`), surface background, 12px padding.
- Header: the repository slug (15px, semibold), **+ New ticket**, then its main worktree path on a separate 10px monospace line with a full-path tooltip.
- Search: a native input matching title or ticket ID, ignoring case and surrounding whitespace.
- Filters: **Open**, **In review**, **Done**, each with its unsearched repository-wide count. Open shows **In progress → Todo** only; within each group ticket numbers ascend. Review is separate; canceled tickets stay out of the main lists but remain readable through child links.
- A ticket: a surface card with a 1px border (accent when expanded), the linked agent's native status glyph immediately left of its 14.5px bold monospace ref, and wrapping colored tags beside it, above a 15px bold title. Collapsed titles show at most two lines; a tooltip and the expanded title expose the full text.
- The upper-right creation age uses `created_at`, with singular/plural minutes, hours and days and an exact local timestamp tooltip. Less than one minute (or a future clock skew) is `just now`; a 30-second timer refreshes it. Tags remain independent of workflow status.
- Session row: mirrors the native Agents item (16px program icon, 30px row, 8px horizontal padding, 9px gaps, 8px radius, 13px text), using its space/tab/live-title rules rather than “Working · program name”. Working uses the original `spinner.svg`, `t.working`, and 900ms spin; idle uses the original 7px/1.5px ring, with native done/blocked graphics. Hover pin, child fold/peek and focused styling match Agents. The current branch of that exact session's pane sits below the row; missing information is `Branch unavailable`, never inferred from another pane or creation/handoff metadata. Ended and live-unlisted sessions are explicit; live-unlisted terminals remain focusable. Age tracks this panel's observation of state changes, not attachment age or another mod's private cache.
- Expanded ticket: the latest handoff summary first, then **Goal & done when** and **Handoff details & session** disclosures. Both render native Markdown, preserving arbitrary body sections and handoff checklists. Branch and provider/model metadata follow the handoff body. Details start folded when a different ticket opens.
- Inside **Goal & done when**, **Created in** shows the ticket's immutable creation branch and worktree path, with full-value tooltips. Detached creation shows `(detached HEAD)`; older tickets show `Unknown` rather than inferring their origin from a later handoff. This metadata stays out of collapsed cards.
- Actions: **Go / Start agent…**, **→ next status**, and **More**. More contains **Copy full context (Markdown)**, **Copy ID**, **Edit tags…** and **Delete ticket…**. Root tickets additionally expose **+ Add subtask** and child summaries; child tickets expose a parent link. Native buttons are keyboard-focusable and show focus styling.
- Empty repository and no search results have distinct messages; Clear search and New ticket remain actionable. The footer says **Shared across worktrees**.

## How it behaves

- The panel follows the focused pane's folder. When that folder is outside any git repository, it shows the repository of the ticket the focused terminal works on; otherwise "Not in a git repository".
- Every 2 s it reads `tk rev` and reloads when that number or focus changes, or a catalog load needs recovery. A temporary tag-catalog failure is retried by the existing poll even without a new revision. Agent/pane snapshots are read once per render and remain independent of ticket writes.
- Clicking a ticket's title expands or folds it. The status button moves todo → in_progress → in_review → done.
- **Go / Start agent…** opens a destination chooser. It verifies Git common-directory identity against live local agent pane folders, includes linked worktrees and selects a valid attached session by default. Existing agents are linked and focused without sending input. A new Claude Code session starts in a new tab of the captured space, from the original main worktree or a new worktree; changing focus while the operation runs cannot retarget it. Launching/linking does not change workflow status.
- New worktrees use `~/.herdr/worktrees/<repo>/<branch-slug>`. An existing local branch retains its commit; a new branch starts at the original main worktree's HEAD. The dialog previews the path and warns that uncommitted changes are not copied. Failures preserve created resource information; retrying a known session link does not duplicate the launch. Uncertain launch/worktree results require inspection rather than blind repetition.
- **More → Copy full context (Markdown)** reads fresh `show --latest-handoff` and copies ID/title, status, tags, parent/children, body and the newest handoff only. **Copy ID** copies the ref. Both use the native context's clipboard API and report failures rather than claiming success.
- **+ Add subtask** opens New ticket with a fixed parent. A subtask has its own ID/state/tags/session/body/handoffs; there is only one child level and no automatic parent/child state propagation. Parent and child links open a detail dialog pinned to the original repository, including done/canceled children. Parents with any children cannot be deleted.
- **More → Delete ticket…** opens a 420×260 modal naming the ticket and warning that its handoffs and history cannot be recovered. Cancel is initially focused; Escape cancels before submission. Confirm runs `tk delete --yes`; while pending, repeat submission and cancel are disabled. Errors stay in the dialog; the CLI rechecks the child-deletion guard atomically.
- **More → Edit tags…** opens a 520×520 repository-pinned multi-select dialog, with the ticket's names selected. Search existing definitions, toggle options, remove chips, or create an unknown valid name. Enter resolves an exact existing match before an earlier partial match. Save replaces tags; removing all clears them. Errors retain the draft; cancel does not register anything; pending saves cannot submit twice.
- **+ New ticket** opens a centered dialog (640×720, modal): slug/path, title, the same optional tag picker and a description prefilled with `## Goal` / `## Done when`. Esc/Cancel closes it before submission; ⌘Enter/Issue issues the ticket. The untouched body template is left to `tk`.
- Names retain the CLI's 0–8 unique / 1–32 ASCII letters-digits-hyphens rules. Catalog entries and their colors persist after untagging or ticket deletion. Ten colors cycle in definition-creation order; drafts preview from the loaded catalog, and the successful server save establishes the final color. Chip and option lists scroll within bounded heights; all three pill surfaces share the same styling.
- Search/filter/draft changes are local UI state. Switching repositories clears search, filters and disclosures. Other UI colors follow the app theme; tag pills intentionally use a fixed readable pastel palette, with no separate theme setting.

## Built from

- One mod, `mods/herdr-ticket/`, with panel (default), new-ticket (`new`), tag editor (`tags`), delete confirmation (`delete`), agent chooser (`agent`) and pinned detail (`detail`) roles. `list.js`, `presentation.js`, `commands.js` and `agent.js` retain list/context/CLI/launch responsibilities. `tag-picker.js` owns draft selection/input precedence, `tag-style.js` pills, and `tag-colors.js` the allocation order shared with the compiled CLI. `sessions.js` and `session-data.js` mirror native agent row behavior and name/branch projection. The installer copies all mod JavaScript modules. No layout of its own.
- Data comes from `~/.local/bin/tk`. Main-panel reads include `rev`, `repo`, `brief`, `ls --status done`, one expanded `show --latest-handoff`, and `tags` once per repository/revision. Each tag modal separately reads its pinned catalog once. Failed catalog reads do not become successful cache entries. `new/edit --tags` registers unknown names atomically; `show` carries children and `new/ls --parent` preserve child workflows. Read commands can trigger schema upgrades.
- `herdr` functions include `focused`, `agents`, `panes`, `spaces`, `terminals`, `exec`, `hc`, overlay functions and explicit `run` focus/rename commands. New sessions use core labels to join the captured space/tab; existing session selection validates live repository identity before linking and focusing.
- `gpui-base` native `Button`, `InputState` + `Input`, `TextareaState` + `Textarea`, and `TextView.markdown`. Session program icons follow the app's program table. The panel releases its retained search input when closed.

## Watch out

- The mod runs `~/.local/bin/tk`; install the CLI there first.
- A terminal's reported folder is where it started; an agent started in a parent folder and `cd`-ing into a repo is found through its linked ticket, not its folder.
- Sessions attach when `tk` runs inside a Herdr terminal (`HC_TERMINAL_ID`); agents started elsewhere show no session until linked.
- **Start agent** always starts `claude`.
- Only local machines: remote spaces are not handled.

## Done when

- Open shows active and todo groups in order; In review and Done are separate. Search matches title/ID and leaves counts unchanged. Empty and unmatched searches show their own recovery actions.
- Larger bold IDs, adjacent wrapping tags and top-right creation ages fit the 380px panel. Titles wrap to two lines when collapsed and show fully when expanded; full timestamps remain available in tooltips.
- Copy ID and fresh Markdown context work; the latter includes the newest handoff and excludes old history. Clipboard/read failures do not display success.
- A ticket issued with `tk new` in another terminal of the same repository appears within 2 s. One-level child creation, parent links and all-state child summaries work; root/child state changes remain independent and any child blocks parent deletion.
- Existing-agent selection excludes foreign/nested repositories, remote and ended agents; a new tab or worktree uses the captured repository/space. Uncommitted changes stay out of a new worktree, launch/link failures retain resource information, and duplicate submissions do not create extra agents.
- Delete is behind More and a confirmation dialog. Cancel/Escape do not delete; a failed confirmation remains retryable and a pending one cannot submit twice.
- Tags retain catalog colors across cards, selection and options. Existing names are searchable, new drafts preview color immediately, exact-name Enter works, and cancel creates no definition. Clearing/deleting tickets leaves reusable definitions intact. Invalid saves preserve prior data, transient catalog failures recover, and concurrent writers do not allocate conflicting slots.
- `herdr-app check mods/herdr-ticket` passes.
