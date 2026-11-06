import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { TAG_COLORS } from "../mods/herdr-ticket/tag-colors.js";

export function dbPath(): string {
  return process.env.HERDR_TICKET_DB || join(homedir(), ".local", "share", "herdr-ticket", "tickets.db");
}

const MIGRATIONS = [
  `CREATE TABLE repos (
     id INTEGER PRIMARY KEY,
     root TEXT NOT NULL UNIQUE,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     next_number INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE tickets (
     id INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL REFERENCES repos(id),
     number INTEGER NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL,
     created_by TEXT NOT NULL,
     provider TEXT, model TEXT, session_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (repo_id, number)
   );`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id),
     kind TEXT NOT NULL,
     from_status TEXT,
     to_status TEXT,
     actor TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX events_ticket ON events (ticket_id, id);`,
  `CREATE TABLE handoffs (
     id INTEGER PRIMARY KEY,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id),
     summary TEXT NOT NULL,
     body TEXT NOT NULL,
     branch TEXT,
     worktree TEXT,
     created_by TEXT NOT NULL,
     provider TEXT, model TEXT, session_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX handoffs_ticket ON handoffs (ticket_id, id);`,
  // A change counter for watchers (the app panel polls it): triggers bump it on every write,
  // so no write path can forget to.
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
   INSERT INTO meta (key, value) VALUES ('rev', 0);
   ${["repos", "tickets", "events", "handoffs"]
     .flatMap((t) => ["INSERT", "UPDATE", "DELETE"].map((op) =>
       `CREATE TRIGGER rev_${t}_${op.toLowerCase()} AFTER ${op} ON ${t}
        BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;`))
     .join("\n")}`,
  // The Herdr terminal that last worked on the ticket (HC_TERMINAL_ID of the writer, or `tk link`).
  `ALTER TABLE tickets ADD COLUMN session_terminal TEXT;
   ALTER TABLE tickets ADD COLUMN session_at INTEGER;`,
  // Creation origin is immutable; old tickets remain unknown rather than being backfilled.
  `ALTER TABLE tickets ADD COLUMN created_branch TEXT;
   ALTER TABLE tickets ADD COLUMN created_worktree TEXT;`,
  `ALTER TABLE tickets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';`,
  // One-level child tickets retain their own lifecycle; existing tickets stay roots.
  `ALTER TABLE tickets ADD COLUMN parent_id INTEGER REFERENCES tickets(id);
   CREATE INDEX tickets_parent ON tickets (parent_id);`,
  // Catalog definitions outlive ticket usage. Backfill before adding revision triggers so opening an
  // old database preserves its revision and every existing row, including ticket tag array order.
  `CREATE TABLE repo_tags (
     id INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL REFERENCES repos(id),
     name TEXT NOT NULL,
     color TEXT NOT NULL CHECK (color IN (${TAG_COLORS.map(color => `'${color}'`).join(", ")})),
     UNIQUE (repo_id, name)
   );
   WITH appearances AS (
     SELECT t.repo_id, j.value AS name, t.id AS ticket_id, CAST(j.key AS INTEGER) AS tag_index,
       ROW_NUMBER() OVER (PARTITION BY t.repo_id, j.value ORDER BY t.id, CAST(j.key AS INTEGER)) AS occurrence
     FROM tickets t, json_each(t.tags) j
   ), ordered AS (
     SELECT repo_id, name,
       ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY ticket_id, tag_index) - 1 AS color_index
     FROM appearances WHERE occurrence = 1
   )
   INSERT INTO repo_tags (repo_id, name, color)
     SELECT repo_id, name, CASE color_index % ${TAG_COLORS.length}
       ${TAG_COLORS.map((color, index) => `WHEN ${index} THEN '${color}'`).join("\n       ")}
     END FROM ordered ORDER BY repo_id, color_index;
   ${["INSERT", "UPDATE", "DELETE"].map(op =>
     `CREATE TRIGGER rev_repo_tags_${op.toLowerCase()} AFTER ${op} ON repo_tags
      BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;`).join("\n")}`,
  `ALTER TABLE repos ADD COLUMN next_doc_number INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE docs (
     id INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL REFERENCES repos(id),
     number INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('spec', 'adr', 'note')),
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT,
     version INTEGER NOT NULL DEFAULT 1,
     superseded_by_id INTEGER REFERENCES docs(id),
     created_by TEXT NOT NULL,
     provider TEXT, model TEXT, session_id TEXT,
     created_branch TEXT, created_worktree TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     revision_author TEXT NOT NULL,
     session_terminal TEXT, session_at INTEGER,
     UNIQUE (repo_id, number),
     CHECK ((kind = 'adr' AND status IS NOT NULL AND status IN ('proposed', 'accepted', 'rejected', 'superseded'))
       OR (kind IN ('spec', 'note') AND status IS NULL)),
     CHECK ((status = 'superseded' AND superseded_by_id IS NOT NULL)
       OR (status IS NOT 'superseded' AND superseded_by_id IS NULL)),
     CHECK (superseded_by_id IS NULL OR superseded_by_id != id)
   );
   CREATE TABLE doc_revisions (
     doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     title TEXT NOT NULL, body TEXT NOT NULL, status TEXT,
     superseded_by_id INTEGER REFERENCES docs(id),
     author TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (doc_id, version)
   );
   CREATE TABLE doc_links (
     doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     PRIMARY KEY (doc_id, ticket_id)
   );
   CREATE INDEX doc_links_ticket ON doc_links (ticket_id, doc_id);
   ${["docs", "doc_revisions", "doc_links"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(op =>
     `CREATE TRIGGER rev_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
      BEGIN UPDATE meta SET value = value + 1 WHERE key = 'rev'; END;`)).join("\n")}`,
  // Priorities are opt-in; existing and newly unspecified tickets remain unclassified.
  `ALTER TABLE tickets ADD COLUMN priority TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low'));`,
];

export function rev(db: Database): number {
  return (db.query("SELECT value FROM meta WHERE key = 'rev'").get() as { value: number }).value;
}

function migrate(db: Database): void {
  const version = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version() >= MIGRATIONS.length) return;
  // Several processes may open the file at once: migrate under the write lock, re-reading the version.
  db.transaction(() => {
    for (let v = version(); v < MIGRATIONS.length; v++) {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    }
  }).immediate();
}

/**
 * Keep new files private until migration finishes. On macOS, unlinking a temporary hard link
 * after another process opens the published file invalidates that connection (IOERR_VNODE).
 * Readers may bypass the bootstrap lock only once the published inode has a single name.
 */
function createIfMissing(path: string): void {
  if (statSync(path, { throwIfNoEntry: false })?.nlink === 1) return;
  // Never delete this lock DB: every initializer must lock the same inode. SQLite releases
  // its write lock when a process crashes, unlike a mkdir/PID sentinel that can stay locked.
  const bootstrap = new Database(`${path}.init`, { create: true, strict: true });
  try {
    bootstrap.run("PRAGMA busy_timeout = 5000");
    bootstrap.transaction(() => {
      // The bootstrap lock owns this fixed temporary name, including leftovers after a crash.
      const tmp = `${path}.init-tmp`;
      const discard = () => {
        for (const file of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(file, { force: true });
      };
      const published = statSync(path, { throwIfNoEntry: false });
      if (published) {
        const pending = statSync(tmp, { throwIfNoEntry: false });
        // A creator can die between link and unlink. No reader opens that two-name inode
        // before acquiring this lock, so its matching orphan alias is safe to remove here.
        if (pending?.dev === published.dev && pending.ino === published.ino) discard();
      } else {
        discard();
        try {
          const db = new Database(tmp, { create: true, strict: true });
          try {
            db.run("PRAGMA journal_mode = WAL");
            migrate(db);
          } finally {
            db.close(true);
          }
          try {
            linkSync(tmp, path); // atomic publication, never overwrite an existing database
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          }
        } finally {
          discard();
        }
      }
      if (statSync(path).nlink !== 1) throw new Error(`Database has an unexpected hard link: ${path}`);
    }).immediate();
  } finally {
    bootstrap.close(true);
  }
}

export function openDb(): Database {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  createIfMissing(path);
  const db = new Database(path, { strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db); // a file made by an older tk
  return db;
}
