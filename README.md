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

<p align="center"><img src="preview.png" width="380" alt="The herdr-ticket panel: Todo, In progress, In review and Done groups; an in-progress ticket shows its live Claude Code session, its latest handoff and Go to agent, In review and Delete buttons; a ticket in review shows an ended session"></p>

> **In development.** Expect rough edges and breaking changes before 1.0.

## One list per repository, from any worktree.

A ticket belongs to the repository's original main worktree. Issue it from `app.feat-login`, read it from `app` or `app.fix-build`: every worktree of a repository shares the same tickets, numbered `APP-1`, `APP-2`, …

## Agents and people use the same CLI.

`tk` is a small CLI with one SQLite file behind it. Agents boot with `tk brief`, issue tickets with `tk new`, move them with `tk status` and end a session with `tk handoff`. Every agent write names its provider and model, so you always know who wrote what; inside an agent a write without them is refused.

## Handoffs that the next session can use.

A handoff has a one-line summary (200 characters at most) and four sections in a fixed order: `## Done`, `## In progress`, `## Blocked`, `## Next`. `tk` refuses anything else, so every handoff reads the same way. The branch and worktree it was written from are recorded with it.

## The agent on the ticket, one click away.

When an agent writes to a ticket from a Herdr terminal, that terminal is attached to the ticket as its session. The panel shows it under the ticket the way the Agents sidebar does (the agent's icon, its title, how long ago, working / needs you / done) and takes you there on click. The last session stays on the ticket after it ends.

## In the Herdr app

The panel sits on the right of the window and follows the focused pane: it shows the repository that pane is in, grouped as **Todo · In progress · In review · Done**. From the panel you can issue a ticket, move it to the next status, delete it, and start a Claude Code agent on it in a new tab; the agent is told to read the ticket and its latest handoff first.

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
| `tk new <title> [--body -]` | Issue a ticket (todo); an empty body gets a `## Goal` / `## Done when` template |
| `tk ls [--status S] [--terminal T] [--all-repos]` | List tickets |
| `tk show <ref>` | Body, status history and handoffs, newest first |
| `tk status <ref> <status>` | `todo`, `in_progress`, `in_review`, `done` or `canceled` |
| `tk edit <ref> [--title T] [--body -]` | Change the title or body |
| `tk handoff <ref> --summary S --body -` | Leave a handoff |
| `tk link <ref> --terminal T` | Attach a Herdr terminal as the ticket's session |
| `tk delete <ref> --yes` | Remove a ticket with its handoffs and history; numbers are not reused |
| `tk repo [slug NEW]` | This repository's slug (2–10 uppercase letters or digits) |

`<ref>` is `APP-12`, or `12` for the repository you are in. `--body -` reads standard input, `--json` prints JSON, `--cwd DIR` acts as if run in `DIR`. Agents add `--provider P --model M [--session S]` to every write. `tk help` has the full list.

Everything lives in `~/.local/share/herdr-ticket/tickets.db` (or `$HERDR_TICKET_DB`).

## Develop

```sh
bun test
bun run build
```

## License

MIT
