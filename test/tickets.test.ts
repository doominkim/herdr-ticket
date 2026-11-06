import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

describe("repository", () => {
  test("a ticket issued in a worktree belongs to the original main worktree's repository", () => {
    sb = sandbox();
    sb.json(["new", "Fix the login bug"], { cwd: sb.feat });

    const list = sb.json(["ls"], { cwd: sb.main });

    expect(list.repo.root).toBe(sb.main);
    expect(list.tickets.map((t: any) => [t.ref, t.title, t.status])).toEqual([["MAIN-1", "Fix the login bug", "todo"]]);
  });

  test("creation origin stays fixed when another worktree updates and hands off the ticket", () => {
    sb = sandbox();
    const issued = sb.json(["new", "Keep the creation origin"], { cwd: sb.feat });
    expect([issued.created_branch, issued.created_worktree]).toEqual(["feat", sb.feat]);
    sb.json(["status", "1", "in_progress"], { cwd: sb.main });
    sb.json(["edit", "1", "--title", "Updated from main"], { cwd: sb.main });
    sb.json(["handoff", "1", "--summary", "Continue on main", "--body", "-"], {
      cwd: sb.main,
      stdin: "## Done\nCreated elsewhere\n\n## In progress\nMain work\n\n## Blocked\nNone\n\n## Next\nContinue\n",
    });

    const ticket = sb.json(["show", "1", "--latest-handoff"], { cwd: sb.main });
    expect([ticket.created_branch, ticket.created_worktree]).toEqual(["feat", sb.feat]);
    expect([ticket.handoffs[0].branch, ticket.handoffs[0].worktree]).toEqual(["main", sb.main]);
    expect(sb.json(["brief"]).tickets[0].created_worktree).toBe(sb.feat);
    expect(sb.json(["ls"]).tickets[0]).not.toHaveProperty("created_worktree");
  });

  test("a detached creation records the worktree without inventing a branch", () => {
    sb = sandbox();
    const detached = Bun.spawnSync(["git", "-C", sb.feat, "switch", "--detach", "-q"]);
    expect(detached.exitCode).toBe(0);
    const ticket = sb.json(["new", "Detached creation"], { cwd: sb.feat });
    expect([ticket.created_branch, ticket.created_worktree]).toEqual([null, sb.feat]);
    expect(sb.json(["show", ticket.ref]).created_branch).toBeNull();
  });

  test("upgrading a pre-origin database preserves old tickets and leaves their creation origin unknown", () => {
    sb = sandbox();
    // A version-5 database is a historical input, not a copy of the current migration implementation.
    const old = new Database(sb.db, { create: true });
    old.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY, root TEXT UNIQUE, slug TEXT UNIQUE, name TEXT, next_number INTEGER, created_at INTEGER);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, repo_id INTEGER, number INTEGER, title TEXT, body TEXT, status TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER, updated_at INTEGER,
        session_terminal TEXT, session_at INTEGER, UNIQUE(repo_id, number));
      CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER, kind TEXT, from_status TEXT, to_status TEXT, actor TEXT, created_at INTEGER);
      CREATE TABLE handoffs (id INTEGER PRIMARY KEY, ticket_id INTEGER, summary TEXT, body TEXT, branch TEXT, worktree TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER);
      INSERT INTO meta VALUES ('rev', 8);
      PRAGMA user_version = 5;
    `);
    old.query("INSERT INTO repos VALUES (1, ?, 'MAIN', 'main', 8, 100)").run(sb.main);
    old.exec("INSERT INTO tickets VALUES (42, 1, 7, 'Legacy work', 'Original legacy goal', 'in_review', 'agent', 'openai', 'legacy-model', 'session-old', 100, 200, 't-old', 190)");
    old.exec("INSERT INTO events VALUES (3, 42, 'status', 'todo', 'in_review', 'human', 200)");
    old.query("INSERT INTO handoffs VALUES (9, 42, 'Legacy handoff', 'Original checkpoint', 'old-branch', ?, 'human', NULL, NULL, NULL, 180)").run(sb.feat);
    old.close();

    const ticket = sb.json(["show", "7"], { cwd: sb.feat });
    expect([ticket.created_branch, ticket.created_worktree]).toEqual([null, null]);
    expect(ticket.tags).toEqual([]);
    expect([ticket.title, ticket.body, ticket.status, ticket.model, ticket.session.terminal]).toEqual([
      "Legacy work", "Original legacy goal", "in_review", "legacy-model", "t-old",
    ]);
    expect(ticket.events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([["status", "human"]]);
    expect(ticket.handoffs.map((h: { summary: string; branch: string | null; worktree: string | null }) => [h.summary, h.branch, h.worktree])).toEqual([["Legacy handoff", "old-branch", sb.feat]]);
    const next = sb.json(["new", "New after migration"], { cwd: sb.feat });
    expect([next.number, next.created_branch, next.created_worktree]).toEqual([8, "feat", sb.feat]);
    expect(next.tags).toEqual([]);
  });

  test("outside a git repository it refuses", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Anything"], { cwd: sb.plain });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a git repository");
  });
});

describe("content and author", () => {
  test("a person issues as human; an empty body gets the Goal / Done when template", () => {
    sb = sandbox();
    const t = sb.json(["new", "Template"]);
    expect(t.created_by).toBe("human");
    expect(t.body).toBe("## Goal\n\n## Done when\n- [ ] \n");
  });

  test("--body - reads the body from standard input", () => {
    sb = sandbox();
    const t = sb.json(["new", "With a body", "--body", "-"], { stdin: "## Goal\nLogin works\n" });
    expect(t.body).toBe("## Goal\nLogin works\n");
  });

  test("editing literal text flags preserves leading dashes and equals, and permits clearing only the body", () => {
    sb = sandbox();
    sb.json(["new", "상위 작업"]);
    sb.json(["new", "기존 하위 작업", "--parent", "1", "--tags", "feat", "--body", "기존 본문"]);
    sb.json(["status", "2", "in_review"]);
    const body = "---\nkind: note\n---\n## 내용\n한글 = 값\n";
    const saved = sb.tk(["edit", "2", "--title=--설정=값", `--body=${body}`]);
    expect(saved.code).toBe(0);
    const edited = sb.json(["show", "2"]);
    expect([edited.title, edited.body, edited.status, edited.tags, edited.parent_ref]).toEqual([
      "--설정=값", body, "in_review", ["feat"], "MAIN-1",
    ]);
    expect(sb.json(["edit", "2", "--body=-"], { stdin: "읽으면 안 되는 입력" }).body).toBe("-");
    expect(sb.json(["edit", "2", "--body=기존 값", "--body", "-"], { stdin: "표준 입력 본문" }).body).toBe("표준 입력 본문");
    expect(sb.json(["edit", "2", "--body", "-", "--body=-"], { stdin: "읽으면 안 되는 입력" }).body).toBe("-");
    sb.json(["edit", "2", "--title=수", "--body="]);
    expect([sb.json(["show", "2"]).title, sb.json(["show", "2"]).body]).toEqual(["수", ""]);
    expect(sb.tk(["edit", "2", "--title=   ", "--body=변경되면 안 됨"]).code).toBe(1);
    const kept = sb.json(["show", "2"]);
    expect([kept.title, kept.body, kept.status, kept.tags, kept.parent_ref]).toEqual(["수", "", "in_review", ["feat"], "MAIN-1"]);
  });

  test("an agent records provider and model together", () => {
    sb = sandbox();
    const t = sb.json(["new", "By an agent", "--provider", "anthropic", "--model", "claude-opus-5-5", "--session", "s1"]);
    expect([t.created_by, t.provider, t.model, t.session_id]).toEqual(["agent", "anthropic", "claude-opus-5-5", "s1"]);
  });

  test("provider without model is refused", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Half", "--provider", "anthropic"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--provider and --model");
  });

  test("inside an agent (CLAUDECODE=1) a write without provider and model is refused", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Anonymous"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--provider and --model");
  });
});

describe("numbering", () => {
  test("ten processes issuing at once get 1..10 with no gaps or repeats", async () => {
    sb = sandbox();
    sb.json(["ls"]); // register the repo and create the schema first
    const issue = (i: number) =>
      Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "new", `Concurrent ${i}`], {
        cwd: sb.main,
        env: { ...sb.env, HERDR_TICKET_DB: sb.db },
        stderr: "pipe",
      }).exited;
    const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => issue(i)));

    expect(codes).toEqual(Array(10).fill(0));
    const numbers = sb.json(["ls"]).tickets.map((t: any) => t.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("first use on an empty database from many processes registers one repo and continuous numbers", async () => {
    sb = sandbox();
    const issue = (i: number, cwd: string) =>
      Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "new", `First ${i}`], {
        cwd,
        env: { ...sb.env, HERDR_TICKET_DB: sb.db },
        stderr: "pipe",
      }).exited;
    const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => issue(i, i % 2 ? sb.feat : sb.main)));

    expect(codes).toEqual(Array(6).fill(0));
    const list = sb.json(["ls"]);
    expect(list.repo.slug).toBe("MAIN");
    expect(list.tickets.map((t: any) => t.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
