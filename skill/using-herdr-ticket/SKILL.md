---
name: using-herdr-ticket
description: "Use for ticket, tikcet, 티켓, 티켓 발급해, 티켓 조회해 requests; ticket creation and lookup; starting/resuming ticket work and reporting completion or review readiness; status changes and handoff; and repository work spanning sessions. herdr-ticket owns these workflows through the repository-scoped tk CLI."
---

# Using herdr-ticket

`tk` is the source of truth for ticket workflows, work state, requirements, and durable decisions that the **next session or another worktree** must read. A ticket belongs to the repository's original main worktree, so every worktree of a repo sees the same tickets. Run commands from the intended repository/worktree; branch and worktree context belong to that scope. Ordinary single-session discussion stays in chat. Commands and flags: `tk help`.

Every write you make carries `--provider <provider> --model <exact model ID you run as> --session <session id, when you have one>`. Inside an agent `tk` refuses a write without provider and model. Inside a Herdr terminal each write also attaches your terminal to the ticket as its session, so the ticket points at you in the Herdr panel.

## 작성 언어

티켓에 새로 작성하거나 수정하는 모든 설명은 항상 한국어로 쓴다. 제목, 목표·완료 기준, 요구사항, 결정의 배경·대안·결과, handoff 요약·본문에 적용하며 저장소의 코드·문서·커밋 언어와 무관하다. `tk new`, `tk edit`, `tk handoff` 실행 전에 제목과 새로 쓴 서술·요약이 한국어인지 확인한다.

CLI와 지침이 사용하는 섹션 제목(`Goal`, `Done when`, `Requirements`, `Decisions`, handoff의 `Done`·`In progress`·`Blocked`·`Next`)은 그대로 유지하고 그 아래 내용을 한국어로 작성한다. 명령어·상태값·태그(`fix`, `feat`, `bug` 등)·티켓 ref·경로·provider/model 식별자·코드와 인용한 오류 원문은 번역하지 않는다. 언어 규칙 적용을 이유로 기존 티켓이나 과거 handoff를 일괄 번역하지 않는다.


## Workflow

1. **List or boot**: `tk ls` in text mode for ticket summaries; retain applicable repository/status filters. Read details only for the relevant ticket.
2. **Resume or look up**: `tk show <ref> --latest-handoff` in text mode gives the ticket body/current state and newest handoff without historical events. The body is the goal; the newest handoff is where the last session stopped. Use `tk show <ref> --pretty` when full structured history is explicitly needed; default text output shows only the newest handoff.
3. **Create**: check `tk ls` for an existing ticket, then `tk new "한국어 작업 제목" --body -` for multi-session work. An explicit request to create a ticket (including `ticket`, `tikcet`, `티켓`, or `티켓 발급해` in that context), or to note something for later, overrides the multi-session default: issue the ticket and report its ref. A lookup request such as `티켓 조회해` reads existing tickets rather than creating one.
4. **Start or resume work**: apply the `in_progress` execution gate below before doing work on the linked ticket, including one just created for that work. Creation-only and lookup-only requests do not start work.
5. **Before reporting back**: classify the actual outcome using Status Rules, execute the required transition, and confirm its result before the final reply. Chat text and a checked local todo are not ticket-state updates.
6. **Handoff**: one `tk handoff` when a session that worked on a ticket ends, after resolving its status. Progress and blockers go here, not into a running history in the ticket body.

Use `--json` only for programmatic consumption; use `--pretty` when readable structured output is desired. Prefer the default text output for interactive listing and resuming.

## Ticket body

Keep the body focused on the goal and acceptance criteria; progress goes to the handoff. When needed, add explicit `## Requirements` and `## Decisions` sections rather than inventing separate CLI entities. Requirements describe who does what; validation criteria include numeric/judgment boundaries and the last accepted/first rejected values. For expensive, cross-feature decisions, get user confirmation in chat before saving the decision and its rationale.

```md
## Goal
이 작업이 끝나면 무엇이 달라지는지 작성한다.

## Done when
- [ ] 사용자가 확인할 수 있는 완료 기준
```

Before design or changes to data models, boundaries, protocols, dependencies, or conventions, inspect repository guidance and linked ticket records for relevant decisions. Report when no relevant record is found. Destructive steps (migration, deploy, data deletion, force push) appear in `Done when` with a `user approval gate` line; recording a gate is not approval to execute. `tk edit <ref> --body -` replaces the body whole: read it with `tk show <ref> --latest-handoff`, then send the complete body.

## Tags

When classifying work, read `tk tags` and reuse a fitting name from the current repository's catalog. Add names through `tk new/edit --tags "feat,ui"`; the same successful ticket write registers unknown names and assigns their colors. Untagging or deleting a ticket keeps its definitions reusable. Tag nature and ticket workflow state remain independent.

## Child tickets

When a root ticket needs an independently tracked task, issue it with `tk new "한국어 하위 작업 제목" --parent <ref>`. Read its parent first: both must belong to the current repository and only one child level is supported. Use `tk ls --parent <ref>` or the `children` summaries in `tk show` to inspect all child states, including done/canceled.

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

`tk handoff <ref> --summary "<ref> 한국어 한 줄 요약" --body - --provider … --model … --session …`, the body on standard input. Branch and worktree are recorded from where you run it. The summary is at most 200 characters; the body has these four headings in this order (`tk` refuses anything else):

```md
## Done
- 완료하고 검증한 내용

## In progress
- 진행 중인 작업과 현재 상태

## Blocked
- 막힌 지점과 원인. 없으면 "없음". 다른 티켓이 막고 있다면 해당 ref를 명시한다.

## Next
- 다음 세션이 바로 이어서 수행할 작업
```

## Common Mistakes

| Mistake | Correct approach |
|---|---|
| Issuing a ticket for ordinary work finished in the same session | Report in chat unless the user explicitly requests a ticket or a note for later |
| Moving to `done` because the AI finished | `in_review` unless verified or told to complete |
| Writing progress into the ticket body | Progress goes to the handoff |
| A write without `--provider`/`--model` | Add both on every write |
