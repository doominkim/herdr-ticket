---
name: using-herdr-ticket
description: Use when work spans sessions — booting a session in a repo, issuing or closing a ticket, changing its status, or writing a session handoff. Tickets live per repository (its original main worktree) in the `tk` CLI.
---

# Using herdr-ticket

`tk` holds what the **next session or another worktree** must read: work that spans sessions and where it stands. A ticket belongs to the repository's original main worktree, so every worktree of a repo sees the same tickets. Everything else stays in chat. Commands and flags: `tk help`.

Every write you make carries `--provider <provider> --model <exact model ID you run as> --session <session id, when you have one>`. Inside an agent `tk` refuses a write without provider and model. Inside a Herdr terminal each write also attaches your terminal to the ticket as its session, so the ticket points at you in the Herdr panel.

## Workflow

1. **Boot**: `tk brief`: the repo's open tickets, each with its latest handoff. Resuming a ticket: `tk show <ref>`; its body is the goal, its newest handoff is where the last session stopped.
2. **Ticket only for multi-session work**: work that starts and finishes in this session gets no ticket. Otherwise check `tk ls` for one already open, then `tk new "<title>" --body -` with the body below.
3. **Status** at each transition in Status Rules.
4. **Handoff**: one `tk handoff` when a session that touched a ticket ends. It is the only record a session writes besides status.

When the user asks to note something for later, issue a ticket and report its ref.

## Ticket body

Fixed-size; progress goes to the handoff.

```md
## Goal
What is different once this is done.

## Done when
- [ ] A result the user can check
```

Destructive steps (migration, deploy, data deletion, force push) appear in `Done when` with a `user approval gate` line. `tk edit <ref> --body -` replaces the body whole: read it with `tk show`, send the complete text.

## Status Rules

- `in_progress` when you start working on it.
- `in_review` when the work is done and needs the user's confirmation.
- `done` after verification or when the user says to complete it.
- `canceled` with the reason in the handoff.
- `tk delete <ref> --yes` only when the user asks for that ticket to be deleted.

## Handoff

`tk handoff <ref> --summary "<ref> <one factual line>" --body - --provider … --model … --session …`, the body on standard input. Branch and worktree are recorded from where you run it. The summary is at most 200 characters; the body has these four headings in this order (`tk` refuses anything else):

```md
## Done
- Finished and verified

## In progress
- Started and where it stands

## Blocked
- Where it is stuck and why ("None" when nothing is)

## Next
- A unit the next session can pick up at once
```

## Common Mistakes

| Mistake | Correct approach |
|---|---|
| Issuing a ticket for work finished in the same session | Report in chat |
| Moving to `done` because the AI finished | `in_review` unless verified or told to complete |
| Writing progress into the ticket body | Progress goes to the handoff |
| A write without `--provider`/`--model` | Add both on every write |
