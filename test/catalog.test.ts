import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sandbox } from "./helpers";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function fixture() {
  const sb = sandbox();
  cleanup = sb.cleanup;
  return sb;
}

describe("repository tag catalog", () => {
  test("ticket saves register normalized colors that remain available after clearing and deleting tickets", () => {
    const sb = fixture();
    const ticket = sb.json(["new", "Tagged work", "--tags", " BUG,fix,bug "]);
    expect(ticket.tags).toEqual(["bug", "fix"]);
    const catalog = sb.json(["tags"]);
    expect(catalog.repo.root).toBe(sb.main);
    expect(catalog.tags).toEqual([
      { name: "bug", color: "blue" },
      { name: "fix", color: "green" },
    ]);
    expect(sb.json(["edit", ticket.ref, "--tags", "fix,feature"]).tags).toEqual(["fix", "feature"]);
    const registered = [
      { name: "bug", color: "blue" },
      { name: "fix", color: "green" },
      { name: "feature", color: "yellow" },
    ];
    expect(sb.json(["tags"]).tags).toEqual(registered);
    sb.json(["edit", ticket.ref, "--tags="]);
    expect(sb.json(["tags"]).tags).toEqual(registered);
    sb.json(["delete", ticket.ref, "--yes"]);
    expect(sb.json(["tags"]).tags).toEqual(registered);
    expect(sb.json(["ls"]).tickets).toEqual([]);
  });

  test("a multi-tag save uses ten distinct colors before cycling without charging existing names a slot", () => {
    const sb = fixture();
    sb.json(["new", "First eight", "--tags", "t1,t2,t3,t4,t5,t6,t7,t8"]);
    const second = sb.json(["new", "Cross palette boundary", "--tags", "t8,t9,t10,t11,t12,T9"]);
    expect(second.tags).toEqual(["t8", "t9", "t10", "t11", "t12"]);
    const colors = [
      { name: "t1", color: "blue" },
      { name: "t2", color: "green" },
      { name: "t3", color: "yellow" },
      { name: "t4", color: "purple" },
      { name: "t5", color: "pink" },
      { name: "t6", color: "red" },
      { name: "t7", color: "orange" },
      { name: "t8", color: "cyan" },
      { name: "t9", color: "brown" },
      { name: "t10", color: "gray" },
      { name: "t11", color: "blue" },
      { name: "t12", color: "green" },
    ];
    expect(sb.json(["tags"]).tags).toEqual(colors);
    sb.json(["edit", second.ref, "--tags", "t12,t1,t13,t13"]);
    expect(sb.json(["tags"]).tags).toEqual([...colors, { name: "t13", color: "yellow" }]);
  });

  test("worktrees share definitions while other repositories restart their own palette", () => {
    const sb = fixture();
    const main = sb.json(["new", "Main definitions", "--tags", "bug,shared"]);
    sb.json(["new", "Worktree definition", "--tags", "shared,feature"], { cwd: sb.feat });
    const expected = [
      { name: "bug", color: "blue" },
      { name: "shared", color: "green" },
      { name: "feature", color: "yellow" },
    ];
    expect(sb.json(["tags"], { cwd: sb.feat })).toEqual(sb.json(["tags"]));
    expect(sb.json(["tags"]).tags).toEqual(expected);
    const initialized = Bun.spawnSync(["git", "init", "-q", "-b", "main", sb.plain], {
      env: { ...sb.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
    expect(sb.json(["tags"], { cwd: sb.plain }).tags).toEqual([]);
    sb.json(["new", "Other repository", "--tags", "shared,other"], { cwd: sb.plain });
    expect(sb.json(["tags"], { cwd: sb.plain }).tags).toEqual([
      { name: "shared", color: "blue" },
      { name: "other", color: "green" },
    ]);
    sb.json(["status", main.ref, "done"]);
    sb.json(["status", "2", "canceled"]);
    expect(sb.json(["brief"]).tickets).toEqual([]);
    expect(sb.json(["tags"]).tags).toEqual(expected);
  });

  test("rejected saves leave no definitions, revision changes or consumed ticket and color numbers", () => {
    const sb = fixture();
    const parent = sb.json(["new", "Parent", "--tags", "kept"]);
    const child = sb.json(["new", "Child", "--parent", parent.ref]);
    const before = sb.json(["rev"]).rev;
    const attempts = [
      ["new", "Invalid names", "--tags", "orphan,bad_name"],
      ["new", "Too many", "--tags", "a,b,c,d,e,f,g,h,i"],
      ["new", "Missing value", "--tags"],
      ["new", "Missing parent", "--parent", "999", "--tags", "orphan"],
      ["new", "Invalid parent", "--parent", "bad-ref", "--tags", "orphan"],
      ["new", "Foreign parent", "--parent", "OTHR-1", "--tags", "orphan"],
      ["new", "Nested child", "--parent", child.ref, "--tags", "orphan"],
      ["edit", "999", "--tags", "orphan"],
      ["edit", parent.ref, "--tags", "orphan,bad_name"],
      ["edit", parent.ref, "--title", " ", "--tags", "orphan"],
      ["edit", parent.ref, "--tags"],
    ];
    for (const args of attempts) {
      const rejected = sb.tk(args);
      expect(rejected.code).toBe(1);
      expect(sb.json(["tags"]).tags).toEqual([{ name: "kept", color: "blue" }]);
      expect(sb.json(["rev"]).rev).toBe(before);
    }
    expect(sb.json(["show", parent.ref]).events).toEqual([]);
    expect(sb.json(["show", parent.ref]).tags).toEqual(["kept"]);
    const next = sb.json(["new", "Next successful save", "--tags", "next"]);
    expect(next.number).toBe(3);
    expect(sb.json(["tags"]).tags).toEqual([
      { name: "kept", color: "blue" },
      { name: "next", color: "green" },
    ]);
  });

  test("catalog registration notifies watchers and reads never advance the revision", () => {
    const sb = fixture();
    const created = sb.json(["new", "Watch catalog"]);
    const before = sb.json(["rev"]).rev;
    sb.json(["edit", created.ref, "--tags", "new-tag"]);
    const registered = sb.json(["rev"]).rev;
    expect(registered).toBeGreaterThan(before);
    const catalog = sb.json(["tags"]);
    expect(catalog.tags).toEqual([{ name: "new-tag", color: "blue" }]);
    sb.json(["edit", created.ref, "--tags", "NEW-TAG,new-tag"]);
    const unchangedCatalog = sb.json(["rev"]).rev;
    expect(unchangedCatalog).toBeGreaterThan(registered);
    expect(sb.json(["tags"])).toEqual(catalog);
    for (const args of [["tags"], ["tags", "--pretty"], ["ls"], ["brief"], ["show", created.ref]]) {
      sb.json(args);
    }
    const text = sb.tk(["tags"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("new-tag");
    expect(text.stdout).toContain("blue");
    expect(sb.json(["rev"]).rev).toBe(unchangedCatalog);
  });

  test("version-8 backfill follows first ticket id and array order without changing legacy records or revision", () => {
    const sb = fixture();
    const old = new Database(sb.db, { create: true });
    old.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY, root TEXT UNIQUE, slug TEXT UNIQUE, name TEXT, next_number INTEGER, created_at INTEGER);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, repo_id INTEGER REFERENCES repos(id), number INTEGER, title TEXT, body TEXT, status TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER, updated_at INTEGER,
        session_terminal TEXT, session_at INTEGER, created_branch TEXT, created_worktree TEXT, tags TEXT NOT NULL DEFAULT '[]',
        parent_id INTEGER REFERENCES tickets(id), UNIQUE(repo_id, number));
      CREATE INDEX tickets_parent ON tickets (parent_id);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), kind TEXT, from_status TEXT, to_status TEXT, actor TEXT, created_at INTEGER);
      CREATE INDEX events_ticket ON events (ticket_id, id);
      CREATE TABLE handoffs (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), summary TEXT, body TEXT, branch TEXT, worktree TEXT,
        created_by TEXT, provider TEXT, model TEXT, session_id TEXT, created_at INTEGER);
      CREATE INDEX handoffs_ticket ON handoffs (ticket_id, id);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER);
      INSERT INTO meta VALUES ('rev', 147);
      PRAGMA user_version = 8;
    `);
    old.query("INSERT INTO repos VALUES (1, ?, 'MAIN', 'main', 9, 100)").run(sb.main);
    old.query("INSERT INTO repos VALUES (2, ?, 'OTHR', 'other', 4, 101)").run(sb.plain);
    const insert = old.query(`INSERT INTO tickets
      (id, repo_id, number, title, body, status, created_by, provider, model, session_id, created_at, updated_at,
       session_terminal, session_at, created_branch, created_worktree, tags, parent_id)
      VALUES (?, ?, ?, ?, '기존 본문', ?, 'legacy-agent', 'openai', 'legacy-model', 'old-session', ?, 300,
       'old-terminal', 290, 'legacy-branch', ?, ?, ?)`);
    insert.run(40, 1, 8, "늦은 태그", "canceled", 100, sb.feat, '["zeta","alpha"]', null);
    insert.run(10, 1, 7, "첫 태그", "in_review", 200, sb.main, '["beta","shared"]', null);
    insert.run(20, 1, 2, "하위 태그", "done", 150, sb.feat, '["alpha","beta"]', 10);
    insert.run(30, 2, 3, "다른 레포", "todo", 120, sb.plain, '["shared","foreign"]', null);
    old.exec("INSERT INTO events VALUES (3, 10, 'status', 'todo', 'in_review', 'legacy-actor', 250)");
    old.query("INSERT INTO handoffs VALUES (9, 20, '기존 인수인계', '기존 기록', 'handoff-branch', ?, 'handoff-agent', 'anthropic', 'handoff-model', 'handoff-session', 280)").run(sb.feat);
    for (const table of ["repos", "tickets", "events", "handoffs"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        old.exec(`CREATE TRIGGER rev_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;`);
      }
    }
    const preserved = {
      repos: old.query("SELECT id, root, slug, name, next_number, created_at FROM repos ORDER BY id").all(),
      tickets: old.query("SELECT id, repo_id, number, title, body, status, created_by, provider, model, session_id, created_at, updated_at, session_terminal, session_at, created_branch, created_worktree, tags, parent_id FROM tickets ORDER BY id").all(),
      events: old.query("SELECT * FROM events ORDER BY id").all(),
      handoffs: old.query("SELECT * FROM handoffs ORDER BY id").all(),
    };
    old.close();

    const migrated = sb.json(["tags"], { cwd: sb.feat });
    expect(migrated.tags).toEqual([
      { name: "beta", color: "blue" },
      { name: "shared", color: "green" },
      { name: "alpha", color: "yellow" },
      { name: "zeta", color: "purple" },
    ]);
    expect(sb.json(["rev"]).rev).toBe(147);
    const reopened = new Database(sb.db, { readonly: true });
    try {
      expect({
        repos: reopened.query("SELECT id, root, slug, name, next_number, created_at FROM repos ORDER BY id").all(),
        tickets: reopened.query("SELECT id, repo_id, number, title, body, status, created_by, provider, model, session_id, created_at, updated_at, session_terminal, session_at, created_branch, created_worktree, tags, parent_id FROM tickets ORDER BY id").all(),
        events: reopened.query("SELECT * FROM events ORDER BY id").all(),
        handoffs: reopened.query("SELECT * FROM handoffs ORDER BY id").all(),
      }).toEqual(preserved);
    } finally {
      reopened.close();
    }
    const parent = sb.json(["show", "7"]);
    expect([parent.tags, parent.parent_ref, parent.children[0].ref, parent.events[0].actor]).toEqual([
      ["beta", "shared"], null, "MAIN-2", "legacy-actor",
    ]);
    expect(sb.json(["show", "2"]).handoffs[0].session_id).toBe("handoff-session");
    const initialized = Bun.spawnSync(["git", "init", "-q", "-b", "main", sb.plain], {
      env: { ...sb.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
    expect(sb.json(["tags"], { cwd: sb.plain }).tags).toEqual([
      { name: "shared", color: "blue" },
      { name: "foreign", color: "green" },
    ]);
    expect(sb.json(["tags"])).toEqual(migrated);
    expect(sb.json(["rev"]).rev).toBe(147);
    const next = sb.json(["new", "다음 태그", "--tags", "beta,next"]);
    expect(next.number).toBe(9);
    expect(sb.json(["tags"]).tags).toEqual([...migrated.tags, { name: "next", color: "pink" }]);
    sb.json(["edit", "3", "--tags", "foreign,next"], { cwd: sb.plain });
    expect(sb.json(["tags"], { cwd: sb.plain }).tags).toEqual([
      { name: "shared", color: "blue" },
      { name: "foreign", color: "green" },
      { name: "next", color: "yellow" },
    ]);
  });
});
