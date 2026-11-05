import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
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
 * Creates the file whole, out of sight, then links it into place. Switching a fresh file to WAL
 * while other processes open it can fail "locked" without waiting, so nobody sees a half-made file;
 * a process that loses the race to link drops its copy and uses the winner's.
 */
function createIfMissing(path: string): void {
  if (existsSync(path)) return;
  const tmp = `${path}.new-${process.pid}-${Date.now()}`;
  const db = new Database(tmp, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL"); // stored in the file: later opens are already WAL
  migrate(db);
  db.close();
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
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
