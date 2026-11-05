<div align="center">
  <h1>herdr-ticket</h1>
  <p><b>Tickets and session handoffs for the agents you run in Herdr.</b><br>
  Agents issue tickets, leave handoffs and pick up where the last session stopped; you see every ticket of the repository you are in, with the agent working on it, in a Herdr app panel.</p>

  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" alt="Version 0.1.0">
    <img src="https://img.shields.io/badge/status-in%20development-orange?style=flat-square" alt="In development">
    <img src="https://img.shields.io/badge/Herdr%20app-supported-8a2be2?style=flat-square" alt="Herdr app supported">
    <img src="https://img.shields.io/badge/macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="macOS and Linux">
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT license">
  </p>
</div>

<p align="center"><img src="preview.png" width="380" alt="Earlier herdr-ticket panel, before the readability redesign"></p>
<p align="center"><small>The screenshot shows the earlier panel. The redesigned interface is described below; its native screenshot has not been refreshed yet.</small></p>

> **In development.** Expect rough edges and breaking changes before 1.0.

## One list per repository, from any worktree.

A ticket belongs to the repository's original main worktree. Issue it from `app.feat-login`, read it from `app` or `app.fix-build`: every worktree of a repository shares the same tickets, numbered `APP-1`, `APP-2`, …

New tickets snapshot their creation branch and absolute worktree path as `created_branch` and `created_worktree`. Later edits, status changes and handoffs do not move that origin. Detached HEAD has a null creation branch; tickets from before this feature keep both fields null. These fields appear on full ticket JSON (`new`, `show`, `brief`), not summary lists; the panel shows them inside **Goal & done when**. A handoff's own `branch`/`worktree` still describes where that handoff was written.

## Agents and people use the same CLI.

`tk` is a small CLI with one SQLite file behind it. Agents boot with `tk brief`, issue tickets with `tk new`, move them with `tk status` and end a session with `tk handoff`. Every agent write names its provider and model, so you always know who wrote what; inside an agent a write without them is refused.

## Classify the work with tags.

Use tags such as `fix`, `feat` and `bug` to describe a ticket's nature without changing its workflow status. Names are free, not a fixed enum: each ticket accepts zero through eight unique names of 1–32 ASCII letters, digits or hyphens. Input is trimmed, lowercased and deduplicated in first-occurrence order. `Ticket.tags` stays a string array, with `[]` for an untagged ticket.

```sh
tk tags                            # reusable names and their colors in this repository
tk new "저장 오류 수정" --tags "bug,fix"
tk edit APP-12 --tags "feat,ui"
tk edit APP-12 --tags ""       # remove all tags
tk edit APP-12 --tags=--test   # equals syntax for a name beginning with --
```

`--tags` replaces the entire set on edit; omitting it preserves the set, and `--tags ""` clears it. New names register automatically in the same successful ticket write. Invalid saves leave no catalog entries behind. `tk tags --json` returns `{ repo, tags: [{ name, color }] }` in creation order.

The catalog belongs to the repository, shared across its worktrees. Definitions survive untagging and ticket deletion, so unused tags remain selectable. The first ten definitions get different colors; subsequent definitions cycle through the same fixed palette. Adding or removing tags from a ticket never recolors an existing definition.

New ticket and **More → Edit tags…** share a searchable, Notion-style multi-select: select/deselect existing names, remove selected chips, or type a new name and choose **Create**. Enter prefers an exact existing name over a partial match. New drafts preview the next palette color; saving persists ticket and catalog atomically, while cancel writes nothing. Removing all chips clears the ticket's tags. Draft colors use the currently loaded catalog; the saved catalog remains authoritative if another writer creates tags meanwhile.

Cards, selected chips and options use the same colored pills. Selected-chip and option lists are height-bounded and scrollable. Tag-name/color editing, deleting catalog definitions and ticket-list tag filters are not included.

## Split work into child tickets.

```sh
tk new "결제 오류 처리" --parent APP-12 --tags fix
tk ls --parent APP-12
tk ls --parent APP-12 --status in_progress --terminal t7
```

A child is an independent ticket with its own ID, status, body, tags, session and handoffs. Parent and child must belong to the same repository; only one level is allowed, so a child cannot itself have children. Status changes do not propagate in either direction. Deleting a parent is refused while any child remains, including done or canceled children; nothing is cascade-deleted. This feature does not move existing tickets between parents.

Full tickets and summaries expose `parent_ref` (`null` for root and older tickets). `show` also returns `children`, a summary array across all statuses, including `[]` for a leaf. `--parent` combines with status/session filters but not `--all-repos`. The panel has **+ Add subtask** on root tickets and parent/child links that open repository-pinned details, including completed and canceled children.


## Handoffs that the next session can use.

A handoff has a one-line summary (200 characters at most) and four sections in a fixed order: `## Done`, `## In progress`, `## Blocked`, `## Next`. `tk` refuses anything else, so every handoff reads the same way. The branch and worktree it was written from are recorded with it.

## The agent on the ticket, one click away.

When an agent writes to a ticket from a Herdr terminal, that terminal is attached as its session. The panel mirrors a single native **Agents** entry instead of summarizing it as “Working · Oh My Pi”: the same program icon, space/tab/live-title rules, hover/focus, pin/fold controls, and status graphics. Working uses the app's spinning glyph; idle uses its gray ring. The same glyph also appears immediately left of the ticket ID. These are agent states, not ticket workflow transitions.

The linked session's current pane branch appears below its row. `Branch unavailable` means the live pane has no branch information; the panel never substitutes ticket creation or handoff metadata. An ended session is identified explicitly; a live terminal missing from Agents is identified as unlisted and can still be focused. State age is observed by this panel rather than copied from another mod's private history or the ticket attachment time.

**Go / Start agent…** opens a destination chooser: an existing live local agent in this repository (including its linked worktrees), a new Herdr tab in the original main worktree, or a new worktree and tab. A valid attached session is selected by default. Existing agents receive no prompt; linking or launching does not infer ticket status.

New sessions use Claude Code. New worktrees follow Herdr's `~/.herdr/worktrees/<repo>/<branch-slug>` convention: an existing local branch uses its own commit; a new branch starts at the original main worktree's committed HEAD. Uncommitted changes are not copied. Errors retain the dialog and identify any created worktree/session; a known session whose link failed can be linked again without launching a duplicate. Agents without a verifiable live pane folder and remote spaces are not offered.


## In the Herdr app

The 380px panel follows the focused pane's repository. **Open** contains **In progress → Todo** only; **In review** and **Done** are separate filters. Search matches ticket titles or IDs, ignoring case; filter counts remain repository-wide rather than changing with the search. The CLI's `brief` still includes review work.

Ticket IDs are larger and bold, with wrapping tag badges beside them; the title is a bold two-line preview that expands in full. The card's upper right shows its creation age (`just now`, `1 minute ago`, `2 hours ago`, `3 days ago`), refreshed every 30 seconds, with the exact local timestamp in a tooltip. This uses `created_at`, not the last edit or session time.

Expanding a ticket reveals its subtasks and newest handoff summary. **Goal & done when** and **Handoff details & session** expand to readable Markdown, with branch and author/model metadata after the handoff. Existing ticket bodies remain unchanged.

**More → Copy full context (Markdown)** copies the current ID/title, status, tags, parent/children, body and newest handoff, without older history; **Copy ID** copies only the ref. You can advance status or edit tags as before. **More → Delete ticket…** opens a confirmation naming the ticket and warning that its handoffs and history are permanently removed; parents with children are blocked. Controls use native keyboard-focusable buttons and the app's theme.

## Install

Requires [Bun](https://bun.sh) 1.1 or later and git.

```sh
git clone https://github.com/doominkim/herdr-ticket
cd herdr-ticket
bun install
bun run build && cp dist/tk ~/.local/bin/tk
```

### The Herdr app panel

Ask the agent in your Herdr window to *add the mod at github.com/doominkim/herdr-ticket/tree/main/mods/herdr-ticket*, or run `./install-mod.sh` from the clone. The panel appears on the right the first time. It runs `~/.local/bin/tk`.

The CLI upgrades the database when it is opened, including by read commands. Schema 8 adds nullable parent references; schema 9 adds the repository tag catalog and backfills existing names in first-ticket/array order without rewriting tickets or history. Back up `tickets.db` before replacing an installed CLI, and apply CLI/mod upgrades together.


To show and hide it with a key, give its layout block an id (`"id": "ticket"`) in `~/.config/herdr-app/layouts/<your layout>.json` and bind the toggle in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "f6": "layout.toggle:ticket" } }
```

### Teach your agents

`skill/using-herdr-ticket/SKILL.md` is an agent skill: when to issue a ticket, the status rules, and the handoff format. Copy it into your agent's skills folder (for Claude Code, `~/.claude/skills/using-herdr-ticket/`).

## Commands

| Command | Does |
|---|---|
| `tk brief` | Open tickets of this repository, each with its latest handoff |
| `tk tags` | Reusable tag names and their stable colors for this repository |
| `tk new <title> [--body -] [--tags bug,fix] [--parent REF]` | Issue an independent ticket (todo), optionally under a root parent |
| `tk ls [--status S] [--terminal T] [--parent REF] [--all-repos]` | List summaries; parent combines with status/session, not all-repos |
| `tk show <ref> [--latest-handoff]` | Ticket body/current state and newest handoff in text; JSON includes all events/handoffs unless `--latest-handoff` is set |
| `tk status <ref> <status>` | `todo`, `in_progress`, `in_review`, `done` or `canceled` |
| `tk edit <ref> [--title T] [--body -] [--tags bug,fix]` | Change the title, body or tags |
| `tk handoff <ref> --summary S --body -` | Leave a handoff |
| `tk link <ref> --terminal T` | Attach a Herdr terminal as the ticket's session |
| `tk delete <ref> --yes` | Remove a ticket with its handoffs/history; blocked while children exist; numbers are not reused |
| `tk repo [slug NEW]` | This repository's slug (2–10 uppercase letters or digits) |

`<ref>` is `APP-12`, or `12` for the repository you are in. `--body -` reads standard input, `--json` prints compact JSON, `--pretty` prints indented JSON (and implies `--json`), and `--cwd DIR` acts as if run in `DIR`. Agents add `--provider P --model M [--session S]` to every write. `tk help` has the full list.

### Reading tickets efficiently

- `tk ls --json` keeps the `{ repo, tickets }` wrapper. Each ticket is a summary with `ref`, `parent_ref`, `repo_root`, `number`, `title`, `status`, `tags`, `session` (or `null`), `created_at` and `updated_at`; bodies, author/model metadata and history are omitted. `--all-repos` makes `repo` null while each summary keeps its own `repo_root`.
- `tk show APP-12` already shows only the newest handoff in text. Default `tk show APP-12 --json` still returns the full ticket, all `events` and all `handoffs` (newest first).
- `tk show APP-12 --latest-handoff --pretty` returns the full current ticket/body, `children` summaries and a `handoffs` array containing only the newest handoff, or `[]` if none exists. The `events` field is omitted. Older handoffs and event history are not fetched.
- `tk brief --json` keeps full open tickets, including creation origin and `parent_ref`, and `latest_handoff` (or `null`). The panel reads `show --latest-handoff` only for the expanded ticket to obtain children; collapsed cards remain lightweight. Repository-pinned details also read that one ticket.

```sh
tk ls --status in_progress --pretty
tk show APP-12 --latest-handoff --pretty
tk show APP-12 --json  # full events and handoff history
```

Everything lives in `~/.local/share/herdr-ticket/tickets.db` (or `$HERDR_TICKET_DB`).

## Develop

```sh
bun test
bun run build
```

## License

MIT
