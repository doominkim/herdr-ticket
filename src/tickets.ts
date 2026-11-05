import type { Database } from "bun:sqlite";
import type { Author } from "./author";
import { TkError, type Repo } from "./repo";

export type Ticket = {
  ref: string;
  /** The repository's original main worktree. */
  repo_root: string;
  number: number;
  title: string;
  body: string;
  status: string;
  created_by: string;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  /** The Herdr terminal that last worked on it. */
  session: { terminal: string; at: number } | null;
};

type Row = Omit<Ticket, "ref" | "repo_root" | "session"> & { session_terminal: string | null; session_at: number | null };

/** What a ticket says when it is issued without a body. */
export const BODY_TEMPLATE = "## Goal\n\n## Done when\n- [ ] \n";

const COLUMNS = "number, title, body, status, created_by, provider, model, session_id, created_at, updated_at, session_terminal, session_at";

const fromRow = (repo: { slug: string; root: string }, { session_terminal, session_at, ...row }: Row): Ticket => ({
  ref: `${repo.slug}-${row.number}`,
  repo_root: repo.root,
  ...row,
  session: session_terminal ? { terminal: session_terminal, at: session_at ?? row.updated_at } : null,
});

export function createTicket(db: Database, repo: Repo, input: { title: string; body: string; author: Author }): Ticket {
  const now = Date.now();
  const { title, author } = input;
  const body = input.body.trim() ? input.body : BODY_TEMPLATE;
  return db.transaction(() => {
    const { next_number } = db.query("SELECT next_number FROM repos WHERE id = ?").get(repo.id) as { next_number: number };
    db.query("UPDATE repos SET next_number = next_number + 1 WHERE id = ?").run(repo.id);
    db.query(
      `INSERT INTO tickets (repo_id, number, title, body, status, created_by, provider, model, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`,
    ).run(repo.id, next_number, title, body, author.created_by, author.provider, author.model, author.session_id, now, now);
    return getTicket(db, repo, next_number)!;
  }).immediate(); // take the write lock first: a read-then-write upgrade fails busy without waiting
}

export function getTicket(db: Database, repo: Repo, number: number): Ticket | null {
  const row = db.query(`SELECT ${COLUMNS} FROM tickets WHERE repo_id = ? AND number = ?`).get(repo.id, number) as Row | null;
  return row ? fromRow(repo, row) : null;
}

export const STATUSES = ["todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];

export type TicketEvent = { kind: string; from_status: string | null; to_status: string | null; actor: string; created_at: number };

export function setStatus(db: Database, repo: Repo, number: number, status: string, actor: string): Ticket {
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new TkError(`unknown status "${status}": use one of ${STATUSES.join(", ")}`);
  }
  return db.transaction(() => {
    const row = db.query("SELECT id, status FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number; status: string } | null;
    if (!row) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
    const now = Date.now();
    db.query("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, now, row.id);
    db.query("INSERT INTO events (ticket_id, kind, from_status, to_status, actor, created_at) VALUES (?, 'status', ?, ?, ?, ?)").run(
      row.id, row.status, status, actor, now,
    );
    return getTicket(db, repo, number)!;
  }).immediate();
}

export function ticketEvents(db: Database, repo: Repo, number: number): TicketEvent[] {
  return db
    .query(
      `SELECT e.kind, e.from_status, e.to_status, e.actor, e.created_at FROM events e
       JOIN tickets t ON t.id = e.ticket_id WHERE t.repo_id = ? AND t.number = ? ORDER BY e.id`,
    )
    .all(repo.id, number) as TicketEvent[];
}

export function editTicket(db: Database, repo: Repo, number: number, change: { title?: string; body?: string }, actor: string): Ticket {
  if (change.title === undefined && change.body === undefined) throw new TkError("nothing to change: pass --title and/or --body");
  if (change.title !== undefined && !change.title.trim()) throw new TkError("--title cannot be empty");
  return db.transaction(() => {
    const row = db.query("SELECT id, title, body FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number; title: string; body: string } | null;
    if (!row) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
    const now = Date.now();
    db.query("UPDATE tickets SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(
      change.title?.trim() ?? row.title, change.body ?? row.body, now, row.id,
    );
    db.query("INSERT INTO events (ticket_id, kind, actor, created_at) VALUES (?, 'edit', ?, ?)").run(row.id, actor, now);
    return getTicket(db, repo, number)!;
  }).immediate();
}

/** Attaches a Herdr terminal to the ticket as the session that last worked on it. */
export function attachSession(db: Database, repo: Repo, number: number, terminal: string): Ticket {
  const r = db.query("UPDATE tickets SET session_terminal = ?, session_at = ? WHERE repo_id = ? AND number = ?").run(terminal, Date.now(), repo.id, number);
  if (r.changes === 0) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
  return getTicket(db, repo, number)!;
}

/** Removes a ticket with its handoffs and history. Its number is not given out again. */
export function deleteTicket(db: Database, repo: Repo, number: number): void {
  db.transaction(() => {
    const row = db.query("SELECT id FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number } | null;
    if (!row) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
    db.query("DELETE FROM handoffs WHERE ticket_id = ?").run(row.id);
    db.query("DELETE FROM events WHERE ticket_id = ?").run(row.id);
    db.query("DELETE FROM tickets WHERE id = ?").run(row.id);
  }).immediate();
}

/** One repo's tickets, or every repo's (`repo` null), optionally of one status or one session terminal. */
export function listTickets(db: Database, repo: Repo | null, status?: string, terminal?: string): Ticket[] {
  const where = [repo ? "t.repo_id = $repo" : "1", status ? "t.status = $status" : "1", terminal ? "t.session_terminal = $terminal" : "1"].join(" AND ");
  const rows = db
    .query(
      `SELECT r.slug, r.root, ${COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}
       FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE ${where} ORDER BY r.slug, t.number`,
    )
    .all({ ...(repo ? { repo: repo.id } : {}), ...(status ? { status } : {}), ...(terminal ? { terminal } : {}) }) as (Row & { slug: string; root: string })[];
  return rows.map(({ slug, root, ...r }) => fromRow({ slug, root }, r));
}

export const OPEN_STATUSES = ["todo", "in_progress", "in_review"];
