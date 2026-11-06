---
name: using-herdr-ticket
description: "Use for ticket requests (including the typo tikcet), creation, lookup, work start/resume/review/completion, status and handoff; cross-session repository work; and tk doc specs, ADRs, notes, revisions and ticket links."
---

# Using herdr-ticket

`tk` is the source of truth for ticket workflows, work state, requirements, and repository documents that the **next session or another worktree** must read. Tickets and documents belong to the repository's original main worktree and are shared across its worktrees. Run creation/list commands from the intended repository/worktree. Ordinary single-session discussion stays in chat. Commands and flags: `tk help`.

Every write you make carries `--provider <provider> --model <exact model ID you run as> --session <session id, when you have one>`. Inside an agent `tk` refuses a write without provider and model. Inside a Herdr terminal (`HC_TERMINAL_ID`), ticket writes attach that terminal to the ticket; document writes capture it in the document's own `session`. A document link does not attach your terminal to its ticket. Author `session_id` and terminal `session` are separate metadata.

## Language

Keep product UI, public documentation, examples and this distributed skill in English. Ticket, document and handoff content follows the user's or repository's language preference; default to English when none is specified. Preserve identifiers, commands, fixed section headings and quoted errors. Do not bulk-translate existing user content without an explicit request.


## Workflow

1. **List or boot**: `tk ls` in text mode for ticket summaries; retain applicable repository/status filters. Read details only for the relevant ticket.
2. **Resume or look up**: `tk show <ref> --latest-handoff` in text mode gives the body/current state, linked document summaries and newest handoff without historical events. The body is the goal; the newest handoff is where the last session stopped. Read relevant linked documents with `tk doc show <doc-ref>`, adding `--history` only when prior versions matter. Use `tk show <ref> --pretty` when full structured history is explicitly needed.
3. **Create**: check `tk ls` for an existing ticket, then `tk new "Task title" --body -` for multi-session work. An explicit request to create a ticket or note something for later overrides the multi-session default: issue the ticket and report its ref. Lookup requests read existing tickets rather than creating one.
4. **Start or resume work**: apply the `in_progress` execution gate below before doing work on the linked ticket, including one just created for that work. Creation-only and lookup-only requests do not start work.
5. **Before reporting back**: classify the actual outcome using Status Rules, execute the required transition, and confirm its result before the final reply. Chat text and a checked local todo are not ticket-state updates.
6. **Handoff**: one `tk handoff` when a session that worked on a ticket ends, after resolving its status. Progress and blockers go here, not into a running history in the ticket body.

Use `--json` only for programmatic consumption; use `--pretty` when readable structured output is desired. Prefer the default text output for interactive listing and resuming.

## Ticket body

Keep the body focused on the goal and acceptance criteria; progress goes to the handoff. Feature requirements stay in `## Requirements`: describe who does what, with numeric/judgment boundaries and the last accepted/first rejected values. Save new expensive, cross-feature decisions and rationale in linked ADR documents after user confirmation in chat. Preserve existing ticket `Decisions` sections and history in place; do not bulk-convert them.

```md
## Goal
Describe the observable outcome.

## Done when
- [ ] A user-visible acceptance criterion
```

Before design or changes to data models, boundaries, protocols, dependencies, or conventions, inspect repository guidance, relevant linked documents and existing ticket decision records. Report when no relevant record is found. Destructive steps (migration, deploy, data deletion, force push) appear in `Done when` with a `user approval gate` line; recording a gate is not approval to execute. `tk edit <ref> --body -` replaces the body whole: read it with `tk show <ref> --latest-handoff`, then send the complete body.

## Repository documents

Use `spec` for a durable specification, `adr` for a decision and rationale, or `note` for durable reference prose. Work state and feature `Requirements` stay on the ticket. The Docs panel is outside this CLI feature.

- Find accepted decisions with `tk doc ls --kind adr --status accepted`; `--ticket REF` narrows linked documents. Read full content with `tk doc show REF`, and opt into prior snapshots with `--history`.
- Create with `tk doc new "Document title" --kind spec|adr|note --body - [--ticket REF]`. Refs are `SLUG-Dn`, or `Dn` in the current repository; document numbers are independent of tickets and never reused.
- Revise with `tk doc edit REF --title T --body -`. Equals-form text is literal: `--body=-` stores `-`, while separated `--body -` reads stdin and `--body=` clears.
- ADRs start `proposed`; only proposed advances to `accepted` or `rejected`. Decisions cannot be reversed. `tk doc supersede OLD --by NEW` requires two distinct accepted ADRs in the same repository and only supersedes OLD. Specs/notes have null status and reject these operations.
- Content/status changes snapshot the previous version, author and time. Creation author/origin stays immutable; `revision_author` describes current content. Link/unlink does not change the content version.
- `tk doc link/unlink REF --ticket TICKET` manages same-repository many-to-many links. Deleting a ticket removes its associations, not documents. There is no document deletion command.
- `show`/`brief` return lightweight `docs` summaries (`[]` when unlinked); `ls` remains a ticket-summary list. Read body/history only through `doc show`. All document writes follow the author/language contract above.

The CLI auto-migrates on open, including read commands. Before installing a schema-changing CLI against the real database, obtain explicit approval and a consistent backup. Until then run source CLI only with an isolated `HERDR_TICKET_DB`; calling real-DB `ls` or `show` is not a migration dry-run.


## Tags

When classifying work, read `tk tags` and reuse a fitting name from the current repository's catalog. Add names through `tk new/edit --tags "feat,ui"`; the same successful ticket write registers unknown names and assigns their colors. Untagging or deleting a ticket keeps its definitions reusable. Tag nature and ticket workflow state remain independent.

## Priority

Priority is opt-in: `high`/`medium`/`low` display as High/Medium/Low. Existing and newly unspecified tickets are null (None). Set with `new/edit --priority VALUE`, clear with `--priority=`, and omit the flag to preserve an existing value. Read it from full tickets or summaries. Do not infer priority from tags or agent/workflow state, and do not add sorting or filtering without agreement.


## Child tickets

When a root ticket needs an independently tracked task, issue it with `tk new "Subtask title" --parent <ref>`. Read its parent first: both must belong to the current repository and only one child level is supported. Use `tk ls --parent <ref>` or the `children` summaries in `tk show` to inspect all child states, including done/canceled.

Treat each child's state, session and handoff independently. Apply Status Rules only to the ticket being worked on; parent/child status never propagates automatically. A parent cannot be deleted while any child remains. Deletion still requires the user's explicit request; a parent deletion request does not authorize deleting its children.

## Status Rules

Operate only on the ticket linked to the work you are actually doing. Reuse the status returned by `show` or a successful write; skip a redundant transition when it is already at the required status.

| Work boundary | Required ticket state |
|---|---|
| Issue for later or read/list only | Preserve state (`new` starts at `todo`) |
| Start implementation/investigation/verification, or resume work after review feedback | Execute `in_progress` before working |
| Implementation is ready and the next action is the user's review/acceptance | Execute `in_review` before asking for review or reporting delivery |
| Work remains incomplete, interrupted, or blocked on input/approval | Keep `in_progress` after work has started; describe the blocker and next action in the handoff |
| Every acceptance criterion is actually verified with no remaining approval gate, or the user explicitly completes it | Execute `done` |
| User cancels the work | Execute `canceled` and record the reason in the handoff |

Use real CLI writes, with the author flags required above:

```sh
tk status <ref> in_progress --provider <provider> --model <exact-model>
tk status <ref> in_review --provider <provider> --model <exact-model>
```

The execution gate is satisfied only when the command succeeds and its output confirms the requested state. On failure, report the failure and actual known state rather than claiming the transition happened. Before the final reply, account for the linked ticket's current state, remaining acceptance criteria, and next actor.

`new`, `link`, `edit` and `handoff` do not infer workflow state. Agent/session Working, Idle, Needs you or Done labels and process exit are observations, not ticket transitions or proof of completed work. An incomplete handoff is not review readiness.

`tk delete <ref> --yes` only when the user asks for that ticket to be deleted.

## Handoff

`tk handoff <ref> --summary "<ref> concise checkpoint" --body - --provider … --model … --session …`, the body on standard input. Branch and worktree are recorded from where you run it. The summary is at most 200 characters; the body has these four headings in this order (`tk` refuses anything else):

```md
## Done
- Completed and verified work

## In progress
- Work in progress and its current state

## Blocked
- Blockers and their causes, or "None". Name related ticket refs.

## Next
- The next concrete action
```

## Common Mistakes

| Mistake | Correct approach |
|---|---|
| Issuing a ticket for ordinary work finished in the same session | Report in chat unless the user explicitly requests a ticket or a note for later |
| Moving to `done` because the AI finished | `in_review` unless verified or told to complete |
| Writing progress into the ticket body | Progress goes to the handoff |
| A write without `--provider`/`--model` | Add both on every write |
