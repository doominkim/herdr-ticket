import { expect, test } from "bun:test";
import { sandbox } from "./helpers";

test("unspecified priority is explicit null in full tickets, summaries and linked worktrees", () => {
  const s = sandbox();
  try {
    const parent = s.json(["new", "기본 우선순위"]);
    expect(parent).toHaveProperty("priority", null);
    expect(s.json(["show", parent.ref], { cwd: s.feat })).toHaveProperty("priority", null);
    expect(s.json(["ls"]).tickets[0]).toHaveProperty("priority", null);
    const child = s.json(["new", "중요한 하위 작업", "--parent", parent.ref, "--priority", "high"], { cwd: s.feat });
    expect(child.priority).toBe("high");
    expect(s.json(["show", parent.ref]).children[0]).toHaveProperty("priority", "high");
    expect(s.json(["ls", "--all-repos"]).tickets.find((row: { ref: string }) => row.ref === child.ref)).toHaveProperty("priority", "high");
  } finally { s.cleanup(); }
});

test("priority transitions and clearing preserve content, status, tags, session and immutable origin", () => {
  const s = sandbox();
  try {
    const created = s.json(["new", "우선순위 변경", "--body=한글 **본문**", "--tags", "feat", "--priority", "high"], { cwd: s.feat });
    expect(created.priority).toBe("high");
    s.json(["status", created.ref, "in_progress"]);
    const before = s.json(["link", created.ref, "--terminal", "t8"]);
    const untouched = (ticket: typeof before) => ({
      body: ticket.body, status: ticket.status, tags: ticket.tags, session: ticket.session,
      created_branch: ticket.created_branch, created_worktree: ticket.created_worktree,
      created_by: ticket.created_by, provider: ticket.provider, model: ticket.model, session_id: ticket.session_id,
    });
    const renamed = s.json(["edit", created.ref, "--title", "제목만 수정"]);
    expect(renamed.priority).toBe("high");
    const medium = s.json(["edit", created.ref, "--priority", "medium"]);
    expect(medium.priority).toBe("medium");
    expect(untouched(medium)).toEqual(untouched(before));
    const low = s.json(["edit", created.ref, "--priority", "low"]);
    expect(low.priority).toBe("low");
    const cleared = s.json(["edit", created.ref, "--priority="]);
    expect(cleared).toHaveProperty("priority", null);
    expect(untouched(cleared)).toEqual(untouched(before));
    expect(cleared.title).toBe("제목만 수정");
    expect(s.json(["ls"]).tickets[0]).toHaveProperty("priority", null);
  } finally { s.cleanup(); }
});

test("invalid priority rejects the entire edit and a missing value cannot consume a ticket number", () => {
  const s = sandbox();
  try {
    const created = s.json(["new", "변경되지 않아야 함", "--tags", "fix"]);
    const before = s.json(["show", created.ref]);
    const revision = s.json(["rev"]);
    const invalid = s.tk(["edit", created.ref, "--title", "저장되면 안 됨", "--tags", "bug", "--priority", "urgent"]);
    expect(invalid.code).toBe(1);
    expect(s.json(["show", created.ref])).toEqual(before);
    expect(s.json(["rev"])).toEqual(revision);
    expect(s.tk(["new", "값 누락", "--priority"]).code).toBe(1);
    expect(s.json(["new", "다음 번호"]).number).toBe(created.number + 1);
  } finally { s.cleanup(); }
});
