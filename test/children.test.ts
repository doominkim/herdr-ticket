import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sandbox } from "./helpers";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("child tickets", () => {
  test("a child issued in a linked worktree is independent and visible from main", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    const parent = sb.json(["new", "상위 작업", "--body", "상위 작업 본문"]);
    const child = sb.json(["new", "하위 작업", "--parent", parent.ref, "--body", "하위 작업 본문"], { cwd: sb.feat });

    expect(parent.parent_ref).toBeNull();
    expect([child.ref, child.title, child.body, child.status, child.parent_ref]).toEqual([
      "MAIN-2", "하위 작업", "하위 작업 본문", "todo", "MAIN-1",
    ]);
    expect([child.repo_root, child.created_branch, child.created_worktree]).toEqual([sb.main, "feat", sb.feat]);
    const shown = sb.json(["show", child.ref], { cwd: sb.main });
    expect([shown.ref, shown.body, shown.status, shown.parent_ref, shown.children]).toEqual([
      "MAIN-2", "하위 작업 본문", "todo", "MAIN-1", [],
    ]);
    const listed = sb.json(["ls"], { cwd: sb.main });
    expect(listed.tickets.map((ticket: { ref: string; parent_ref: string | null }) => [ticket.ref, ticket.parent_ref])).toEqual([
      ["MAIN-1", null], ["MAIN-2", "MAIN-1"],
    ]);
  });

  test("show and parent-filtered lists expose lightweight children across every status", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업"]);
    sb.json(["new", "완료된 하위 작업", "--parent", "1", "--body", "완료 본문", "--tags", "backend"], { env: { HC_TERMINAL_ID: "term-child" } });
    sb.json(["status", "2", "done"]);
    sb.json(["new", "취소된 하위 작업", "--parent", "MAIN-1"]);
    sb.json(["status", "3", "canceled"]);
    sb.json(["new", "다른 독립 작업"]);

    for (const flags of [[], ["--latest-handoff"]]) {
      const shown = sb.json(["show", "1", ...flags]);
      expect(shown.children.map((ticket: { ref: string; status: string; parent_ref: string | null }) => [ticket.ref, ticket.status, ticket.parent_ref])).toEqual([
        ["MAIN-2", "done", "MAIN-1"], ["MAIN-3", "canceled", "MAIN-1"],
      ]);
      expect(shown.children[0]).not.toHaveProperty("body");
      expect(shown.children[0]).not.toHaveProperty("created_by");
      expect(shown.children[0].tags).toEqual(["backend"]);
      expect(shown.children[0].session.terminal).toBe("term-child");
    }
    const children = sb.json(["ls", "--parent", "1"], { cwd: sb.feat });
    expect(children.repo.root).toBe(sb.main);
    expect(children.tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(["MAIN-2", "MAIN-3"]);
    expect(sb.json(["ls", "--parent", "MAIN-1", "--status", "done", "--terminal", "term-child"]).tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(["MAIN-2"]);
    expect(sb.json(["ls", "--parent", "1", "--status", "canceled", "--terminal", "term-child"]).tickets).toEqual([]);
    expect(sb.tk(["show", "1"]).stdout).toContain("MAIN-2");
    expect(sb.tk(["show", "2"]).stdout).toContain("Parent: MAIN-1");
  });

  test("any child blocks parent deletion until the child is explicitly deleted", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업"]);
    sb.json(["new", "하위 작업", "--parent", "1"]);
    sb.json(["handoff", "1", "--summary", "상위 작업 기록", "--body", "-"], {
      stdin: "## Done\n기록 보존\n\n## In progress\n상위 작업\n\n## Blocked\n없음\n\n## Next\n하위 작업 완료\n",
    });
    for (const status of ["todo", "in_progress", "in_review", "done", "canceled"]) {
      sb.json(["status", "2", status]);
      const before = sb.json(["rev"]).rev;
      const rejected = sb.tk(["delete", "1", "--yes"]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("child");
      expect(sb.json(["rev"]).rev).toBe(before);
      expect(sb.json(["show", "1"]).handoffs[0].summary).toBe("상위 작업 기록");
    }
    sb.json(["delete", "2", "--yes"]);
    expect(sb.json(["show", "1"]).children).toEqual([]);
    expect(sb.json(["delete", "1", "--yes"]).deleted).toBe("MAIN-1");
    expect(sb.json(["new", "후속 작업"]).ref).toBe("MAIN-3");
  });

  test("a root accepts children but its child rejects grandchildren without consuming a number", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업"]);
    sb.json(["new", "하위 작업", "--parent", "1"]);
    const before = sb.json(["rev"]).rev;
    const rejected = sb.tk(["new", "금지된 손자 작업", "--parent", "MAIN-2"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("child ticket cannot be a parent");
    expect(sb.json(["rev"]).rev).toBe(before);
    expect(sb.json(["new", "두 번째 하위 작업", "--parent", "main-1"]).ref).toBe("MAIN-3");
    expect(sb.json(["ls", "--parent", "2"]).tickets).toEqual([]);
  });

  test("a foreign parent cannot redirect creation or register the current repository on failure", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업"]);
    expect(Bun.spawnSync(["git", "init", "-q", sb.plain]).exitCode).toBe(0);
    const before = sb.json(["rev"]).rev;
    const rejected = sb.tk(["new", "잘못된 저장소 작업", "--parent", "MAIN-1"], { cwd: sb.plain });
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("current repository");
    expect(sb.json(["rev"]).rev).toBe(before);
    expect(sb.json(["ls", "--all-repos"]).tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(["MAIN-1"]);
    // A failed registration would reserve PLAI and prevent this otherwise valid slug.
    expect(sb.json(["repo", "slug", "PLAI"]).slug).toBe("PLAI");
    expect(sb.json(["new", "현재 저장소 후속 작업"]).ref).toBe("PLAI-2");
    const other = sb.json(["new", "다른 저장소 작업"], { cwd: sb.plain });
    const again = sb.tk(["new", "다시 거부되는 작업", "--parent", other.ref]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("current repository");
    expect(sb.json(["ls"], { cwd: sb.plain }).tickets).toHaveLength(1);
    expect(sb.json(["new", "현재 저장소 정상 작업"]).ref).toBe("PLAI-3");
  });

  test("a missing parent value or reference rejects creation and listing without changing tickets", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업"]);
    const before = sb.json(["rev"]).rev;
    for (const parent of [[], [""], ["wrong"], ["0"], ["999"], ["MAIN-999"], ["OTHER-1"]]) {
      const created = sb.tk(["new", "거부되는 작업", "--parent", ...parent]);
      expect(created.code).toBe(1);
      expect(created.stdout).toBe("");
      const listed = sb.tk(["ls", "--parent", ...parent]);
      expect(listed.code).toBe(1);
      expect(listed.stdout).toBe("");
    }
    const incompatible = sb.tk(["ls", "--all-repos", "--parent", "1"]);
    expect(incompatible.code).toBe(1);
    expect(incompatible.stderr).toContain("--all-repos");
    expect(sb.json(["rev"]).rev).toBe(before);
    expect(sb.json(["new", "정상 하위 작업", "--parent", "1"]).ref).toBe("MAIN-2");
  });

  test("parent and child retain independent states, content, authors, tags and sessions", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    sb.json(["new", "상위 작업", "--body", "상위 본문", "--tags", "parent"], { env: { HC_TERMINAL_ID: "term-parent" } });
    sb.json(["status", "1", "in_review"]);
    const child = sb.json(["new", "하위 작업", "--parent", "1", "--body", "하위 본문", "--tags", "child", "--provider", "openai", "--model", "test-model", "--session", "agent-child"], {
      cwd: sb.feat, env: { HC_TERMINAL_ID: "term-child" },
    });
    expect([child.created_by, child.provider, child.model, child.session_id]).toEqual(["agent", "openai", "test-model", "agent-child"]);
    expect([child.status, child.tags, child.session.terminal]).toEqual(["todo", ["child"], "term-child"]);
    expect(sb.json(["show", "1"]).status).toBe("in_review");
    expect(sb.json(["brief"]).tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(["MAIN-1", "MAIN-2"]);
    sb.json(["status", "2", "done"]);
    expect(sb.json(["show", "1"]).status).toBe("in_review");
    sb.json(["status", "1", "canceled"]);
    expect(sb.json(["show", "2"]).status).toBe("done");
    sb.json(["status", "2", "in_progress"]);
    expect(sb.json(["show", "1"]).status).toBe("canceled");
    sb.json(["status", "1", "done"]);
    const another = sb.json(["new", "추가 하위 작업", "--parent", "1"]);
    expect(another.status).toBe("todo");
    expect(another.tags).toEqual([]);
    expect(another.session).toBeNull();
    const parent = sb.json(["show", "1"]);
    expect([parent.status, parent.body, parent.tags, parent.created_by, parent.session.terminal]).toEqual([
      "done", "상위 본문", ["parent"], "human", "term-parent",
    ]);
    expect(sb.json(["brief"]).tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(["MAIN-2", "MAIN-3"]);
  });

  test("a version-7 database gains nullable parents without losing existing ticket history or origins", () => {
    const sb = sandbox();
    cleanup = sb.cleanup;
    const old = new Database(sb.db, { create: true });
    old.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY, root TEXT UNIQUE, slug TEXT UNIQUE, name TEXT, next_number INTEGER, created_at INTEGER);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, repo_id INTEGER REFERENCES repos(id), number INTEGER, title TEXT, body TEXT, status TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER, updated_at INTEGER,
        session_terminal TEXT, session_at INTEGER, created_branch TEXT, created_worktree TEXT, tags TEXT NOT NULL DEFAULT '[]',
        UNIQUE(repo_id, number));
      CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), kind TEXT, from_status TEXT, to_status TEXT, actor TEXT, created_at INTEGER);
      CREATE INDEX events_ticket ON events (ticket_id, id);
      CREATE TABLE handoffs (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), summary TEXT, body TEXT, branch TEXT, worktree TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER);
      CREATE INDEX handoffs_ticket ON handoffs (ticket_id, id);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER);
      INSERT INTO meta VALUES ('rev', 8);
      CREATE TRIGGER rev_tickets_update AFTER UPDATE ON tickets
        BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
      PRAGMA user_version = 7;
    `);
    old.query("INSERT INTO repos VALUES (1, ?, 'MAIN', 'main', 8, 100)").run(sb.main);
    old.query("INSERT INTO tickets VALUES (42, 1, 7, '기존 상위 작업', '기존 본문', 'in_review', 'agent', 'openai', 'legacy-model', 'legacy-session', 100, 200, 'term-legacy', 190, 'feat', ?, '[\"legacy\"]')").run(sb.feat);
    old.exec("INSERT INTO events VALUES (3, 42, 'status', 'todo', 'in_review', 'human', 200)");
    old.query("INSERT INTO handoffs VALUES (9, 42, '기존 인수인계', '기존 기록', 'feat', ?, 'human', NULL, NULL, NULL, 180)").run(sb.feat);
    old.close();

    const migrated = sb.json(["show", "7"]);
    expect([migrated.parent_ref, migrated.children]).toEqual([null, []]);
    expect([migrated.title, migrated.body, migrated.status, migrated.tags]).toEqual(["기존 상위 작업", "기존 본문", "in_review", ["legacy"]]);
    expect([migrated.created_branch, migrated.created_worktree, migrated.session.terminal]).toEqual(["feat", sb.feat, "term-legacy"]);
    expect([migrated.provider, migrated.model, migrated.session_id]).toEqual(["openai", "legacy-model", "legacy-session"]);
    expect(migrated.events.map((event: { kind: string; actor: string }) => [event.kind, event.actor])).toEqual([["status", "human"]]);
    expect(migrated.handoffs.map((handoff: { summary: string; body: string }) => [handoff.summary, handoff.body])).toEqual([["기존 인수인계", "기존 기록"]]);
    const child = sb.json(["new", "마이그레이션 후 하위 작업", "--parent", "7"], { cwd: sb.feat });
    expect([child.ref, child.parent_ref]).toEqual(["MAIN-8", "MAIN-7"]);
    expect(sb.json(["ls", "--parent", "7"]).tickets[0].ref).toBe("MAIN-8");
    sb.json(["repo", "slug", "NEXT"]);
    expect(sb.json(["show", "8"]).parent_ref).toBe("NEXT-7");
    expect(sb.json(["show", "7", "--latest-handoff"]).children[0].ref).toBe("NEXT-8");
    const before = sb.json(["rev"]).rev;
    sb.json(["status", "7", "in_progress"]);
    expect(sb.json(["rev"]).rev).toBeGreaterThan(before);
    const changed = sb.json(["show", "7"]);
    expect(changed.events).toHaveLength(2);
    expect(changed.handoffs[0].summary).toBe("기존 인수인계");
    expect(sb.tk(["delete", "7", "--yes"]).code).toBe(1);
    expect(sb.json(["new", "마이그레이션 후 독립 작업"]).ref).toBe("NEXT-9");
  });
});
