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

// Independent schema-9 fixture: do not derive historical input from current migrations.
const SCHEMA_9 = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id), number INTEGER NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
    provider TEXT, model TEXT, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    session_terminal TEXT, session_at INTEGER, created_branch TEXT, created_worktree TEXT,
    tags TEXT NOT NULL DEFAULT '[]', parent_id INTEGER REFERENCES tickets(id), UNIQUE (repo_id, number)
  );
  CREATE INDEX tickets_parent ON tickets (parent_id);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL,
    from_status TEXT, to_status TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX events_ticket ON events (ticket_id, id);
  CREATE TABLE handoffs (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), summary TEXT NOT NULL,
    body TEXT NOT NULL, branch TEXT, worktree TEXT, created_by TEXT NOT NULL,
    provider TEXT, model TEXT, session_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX handoffs_ticket ON handoffs (ticket_id, id);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO meta VALUES ('rev', 147);
  CREATE TABLE repo_tags (
    id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id), name TEXT NOT NULL,
    color TEXT NOT NULL CHECK (color IN ('blue', 'green', 'yellow', 'purple', 'pink', 'red', 'orange', 'cyan', 'brown', 'gray')),
    UNIQUE (repo_id, name)
  );
  PRAGMA user_version = 9;
`;

// These are historical schema-9 triggers, installed after seeding so rev is known.
const LEGACY_TRIGGERS = `
  CREATE TRIGGER rev_repos_insert AFTER INSERT ON repos BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_repos_update AFTER UPDATE ON repos BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_repos_delete AFTER DELETE ON repos BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_tickets_insert AFTER INSERT ON tickets BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_tickets_update AFTER UPDATE ON tickets BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_tickets_delete AFTER DELETE ON tickets BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_events_insert AFTER INSERT ON events BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_events_update AFTER UPDATE ON events BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_events_delete AFTER DELETE ON events BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_handoffs_insert AFTER INSERT ON handoffs BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_handoffs_update AFTER UPDATE ON handoffs BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_handoffs_delete AFTER DELETE ON handoffs BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_repo_tags_insert AFTER INSERT ON repo_tags BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_repo_tags_update AFTER UPDATE ON repo_tags BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
  CREATE TRIGGER rev_repo_tags_delete AFTER DELETE ON repo_tags BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;
`;

function legacyRows(db: Database) {
  return {
    repos: db.query("SELECT id, root, slug, name, next_number, created_at FROM repos ORDER BY id").all(),
    tickets: db.query("SELECT id, repo_id, number, title, body, status, created_by, provider, model, session_id, created_at, updated_at, session_terminal, session_at, created_branch, created_worktree, tags, parent_id FROM tickets ORDER BY id").all(),
    events: db.query("SELECT * FROM events ORDER BY id").all(),
    handoffs: db.query("SELECT * FROM handoffs ORDER BY id").all(),
    catalog: db.query("SELECT * FROM repo_tags ORDER BY id").all(),
  };
}

describe("document schema migration", () => {
  test("schema 9 retains legacy records and revision, then starts document numbers independently", () => {
    const sb = fixture();
    const old = new Database(sb.db, { create: true });
    let preserved: { repos: unknown[]; tickets: unknown[]; events: unknown[]; handoffs: unknown[]; catalog: unknown[] };
    try {
      old.exec(SCHEMA_9);
      old.query("INSERT INTO repos VALUES (1, ?, 'MAIN', 'main', 9, 100)").run(sb.main);
      old.query("INSERT INTO repos VALUES (2, ?, 'OTHR', 'other', 24, 101)").run(sb.plain);
      old.query(`INSERT INTO tickets VALUES
        (40, 1, 7, '기존 상위 작업', '원래 본문', 'in_review', 'agent', 'openai', 'legacy-model', 'legacy-session',
         110, 210, 'legacy-terminal', 205, 'feat', ?, '["shared","legacy"]', NULL)`).run(sb.feat);
      old.query(`INSERT INTO tickets VALUES
        (41, 1, 8, '기존 하위 작업', '하위 본문', 'done', 'human', NULL, NULL, NULL,
         120, 220, NULL, NULL, 'main', ?, '["legacy"]', 40)`).run(sb.main);
      old.query(`INSERT INTO tickets VALUES
        (90, 2, 23, '다른 레포 작업', '별도 본문', 'todo', 'agent', 'anthropic', 'foreign-model', 'foreign-session',
         130, 230, 'foreign-terminal', 225, 'main', ?, '["shared"]', NULL)`).run(sb.plain);
      old.exec(`
        INSERT INTO events VALUES (3, 40, 'status', 'todo', 'in_review', 'legacy-actor', 200);
        INSERT INTO events VALUES (4, 41, 'status', 'in_progress', 'done', 'human', 220);
        INSERT INTO repo_tags VALUES (5, 1, 'shared', 'pink');
        INSERT INTO repo_tags VALUES (8, 1, 'legacy', 'cyan');
        INSERT INTO repo_tags VALUES (12, 1, 'unused', 'gray');
        INSERT INTO repo_tags VALUES (19, 2, 'shared', 'red');
      `);
      old.query(`INSERT INTO handoffs VALUES
        (9, 41, '기존 인수인계', '기존 기록', 'handoff-branch', ?, 'agent', 'anthropic', 'handoff-model', 'handoff-session', 215)`).run(sb.feat);
      old.exec(LEGACY_TRIGGERS);
      preserved = legacyRows(old);
    } finally {
      old.close();
    }

    // Opening the old file must not look like a user write to existing watchers.
    expect(sb.json(["doc", "ls"], { cwd: sb.feat }).docs).toEqual([]);
    expect(sb.json(["rev"]).rev).toBe(147);
    const reopened = new Database(sb.db, { readonly: true });
    try {
      expect(legacyRows(reopened)).toEqual(preserved);
      expect(reopened.query("SELECT slug, next_doc_number FROM repos ORDER BY id").all()).toEqual([
        { slug: "MAIN", next_doc_number: 1 }, { slug: "OTHR", next_doc_number: 1 },
      ]);
    } finally {
      reopened.close();
    }

    const parent = sb.json(["show", "7"]);
    expect(parent).toHaveProperty("priority", null);
    expect([parent.ref, parent.body, parent.status, parent.tags, parent.parent_ref]).toEqual([
      "MAIN-7", "원래 본문", "in_review", ["shared", "legacy"], null,
    ]);
    expect(parent.children.map((child: { ref: string }) => child.ref)).toEqual(["MAIN-8"]);
    expect([parent.created_by, parent.provider, parent.model, parent.session_id, parent.created_at, parent.updated_at]).toEqual([
      "agent", "openai", "legacy-model", "legacy-session", 110, 210,
    ]);
    expect([parent.created_branch, parent.created_worktree, parent.session]).toEqual([
      "feat", sb.feat, { terminal: "legacy-terminal", at: 205 },
    ]);
    expect(parent.events.map((event: { actor: string; from_status: string; to_status: string }) => [event.actor, event.from_status, event.to_status])).toEqual([
      ["legacy-actor", "todo", "in_review"],
    ]);
    const child = sb.json(["show", "8"]);
    expect(child).toHaveProperty("priority", null);
    expect(child.parent_ref).toBe("MAIN-7");
    expect(child.handoffs.map((handoff: { summary: string; body: string; provider: string; model: string; session_id: string }) =>
      [handoff.summary, handoff.body, handoff.provider, handoff.model, handoff.session_id])).toEqual([
      ["기존 인수인계", "기존 기록", "anthropic", "handoff-model", "handoff-session"],
    ]);
    expect(sb.json(["tags"]).tags).toEqual([
      { name: "shared", color: "pink" }, { name: "legacy", color: "cyan" }, { name: "unused", color: "gray" },
    ]);
    expect(sb.json(["rev"]).rev).toBe(147);

    const first = sb.json(["doc", "new", "첫 문서", "--kind", "spec", "--ticket", "8", "--body", "-"], {
      cwd: sb.feat, stdin: "마이그레이션 뒤 본문\n",
    });
    expect([first.ref, first.number, first.version, first.ticket_refs, first.created_branch, first.created_worktree]).toEqual([
      "MAIN-D1", 1, 1, ["MAIN-8"], "feat", sb.feat,
    ]);
    expect(sb.json(["doc", "show", "D1", "--history"]).history).toEqual([]);
    expect(sb.json(["show", "8"]).docs.map((doc: { ref: string }) => doc.ref)).toEqual(["MAIN-D1"]);
    expect(sb.json(["rev"]).rev).toBeGreaterThan(147);
    expect(sb.json(["new", "이전 티켓 번호 유지"]).ref).toBe("MAIN-9");
    expect(sb.json(["doc", "new", "다음 문서", "--kind", "note"]).ref).toBe("MAIN-D2");

    const initialized = Bun.spawnSync(["git", "init", "-q", "-b", "main", sb.plain], {
      env: { ...sb.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
    expect(sb.json(["doc", "new", "다른 레포 첫 문서", "--kind", "note"], { cwd: sb.plain }).ref).toBe("OTHR-D1");
    expect(sb.json(["new", "다른 레포 이전 번호 유지"], { cwd: sb.plain }).ref).toBe("OTHR-24");
  });
});
