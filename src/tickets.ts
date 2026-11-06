import type { Database } from "bun:sqlite";
import type { Author } from "./author";
import { TkError, whereAmI, type Repo } from "./repo";
import { registerTags } from "./tags";

export type Priority = "high" | "medium" | "low";

export type Ticket = {
  ref: string;
  parent_ref: string | null;
  /** The repository's original main worktree. */
  repo_root: string;
  number: number;
  title: string;
  body: string;
  status: string;
  tags: string[];
  priority: Priority | null;
  created_by: string;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  created_branch: string | null;
  created_worktree: string | null;
  created_at: number;
  updated_at: number;
  /** The Herdr terminal that last worked on it. */
  session: { terminal: string; at: number } | null;
};

export type TicketSummary = Pick<Ticket, "ref" | "parent_ref" | "repo_root" | "number" | "title" | "status" | "tags" | "priority" | "session" | "created_at" | "updated_at">;
type SummaryRow = Omit<TicketSummary, "ref" | "parent_ref" | "repo_root" | "session" | "tags"> & { parent_number: number | null; tags: string; session_terminal: string | null; session_at: number | null };
type Row = SummaryRow & Pick<Ticket, "body" | "created_by" | "provider" | "model" | "session_id" | "created_branch" | "created_worktree">;

/** What a ticket says when it is issued without a body. */
export const BODY_TEMPLATE = "## Goal\n\n## Done when\n- [ ] \n";

export function normalizeTags(values: readonly string[]): string[] {
  const tags = [...new Set(values.map(value => value.trim().toLowerCase()))];
  if (tags.length > 8) throw new TkError("a ticket accepts at most 8 unique tags");
  if (tags.some(tag => !/^[a-z0-9-]{1,32}$/.test(tag))) {
    throw new TkError("tag names must be 1-32 ASCII letters, digits or hyphens");
  }
  return tags;
}

function storedTags(value: string): string[] {
  const tags: unknown = JSON.parse(value);
  if (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === "string")) {
    throw new TkError("stored ticket tags must be an array of strings");
  }
  return tags;
}
function checkedPriority(value: string | null): Priority | null {
  if (value !== null && value !== "high" && value !== "medium" && value !== "low") {
    throw new TkError(`unknown priority "${value}": use high, medium, low or an empty value to clear`);
  }
  return value;
}


const COLUMNS = "number, title, body, status, tags, priority, created_by, provider, model, session_id, created_at, updated_at, session_terminal, session_at, created_branch, created_worktree";
const SUMMARY_COLUMNS = "number, title, status, tags, priority, created_at, updated_at, session_terminal, session_at";
const TICKET_PROJECTION = `${COLUMNS.split(", ").map(column => `t.${column}`).join(", ")}, p.number AS parent_number`;
const SUMMARY_PROJECTION = `${SUMMARY_COLUMNS.split(", ").map(column => `t.${column}`).join(", ")}, p.number AS parent_number`;

const fromRow = <T extends SummaryRow>(repo: { slug: string; root: string }, { parent_number, session_terminal, session_at, tags, ...row }: T) => ({
  ref: `${repo.slug}-${row.number}`,
  parent_ref: parent_number === null ? null : `${repo.slug}-${parent_number}`,
  repo_root: repo.root,
  ...row,
  tags: storedTags(tags),
  session: session_terminal ? { terminal: session_terminal, at: session_at ?? row.updated_at } : null,
});

export function createTicket(db: Database, repo: Repo, input: { title: string; body: string; author: Author; cwd: string; tags?: string[]; priority?: string | null; parentRef?: string }): Ticket {
  const now = Date.now();
  const { title, author } = input;
  const body = input.body.trim() ? input.body : BODY_TEMPLATE;
  const tags = normalizeTags(input.tags ?? []);
  const priority = checkedPriority(input.priority ?? null);
  const { branch, worktree } = whereAmI(input.cwd);
  return db.transaction(() => {
    let parentId: number | null = null;
    if (input.parentRef !== undefined) {
      const bare = /^(\d+)$/.exec(input.parentRef);
      const full = /^([A-Za-z0-9]+)-(\d+)$/.exec(input.parentRef);
      if (!bare && !full) throw new TkError(`not a ticket reference: "${input.parentRef}" (use MAIN-12 or 12)`);
      if (full && full[1]!.toUpperCase() !== repo.slug) throw new TkError("parent must belong to the current repository");
      const number = Number(bare ? bare[1] : full![2]);
      const parent = db.query("SELECT id, parent_id FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number; parent_id: number | null } | null;
      if (!parent) throw new TkError(`no such ticket: ${input.parentRef}`);
      if (parent.parent_id !== null) throw new TkError("a child ticket cannot be a parent");
      parentId = parent.id;
    }
    const { next_number } = db.query("SELECT next_number FROM repos WHERE id = ?").get(repo.id) as { next_number: number };
    db.query("UPDATE repos SET next_number = next_number + 1 WHERE id = ?").run(repo.id);
    db.query(
      `INSERT INTO tickets (repo_id, number, title, body, status, tags, priority, created_by, provider, model, session_id, created_at, updated_at, created_branch, created_worktree, parent_id)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(repo.id, next_number, title, body, JSON.stringify(tags), priority, author.created_by, author.provider, author.model, author.session_id, now, now, branch, worktree, parentId);
    registerTags(db, repo, tags);
    return getTicket(db, repo, next_number)!;
  }).immediate(); // take the write lock first: a read-then-write upgrade fails busy without waiting
}

export function getTicket(db: Database, repo: Repo, number: number): Ticket | null {
  const row = db.query(`SELECT ${TICKET_PROJECTION}
    FROM tickets t LEFT JOIN tickets p ON p.id = t.parent_id WHERE t.repo_id = ? AND t.number = ?`).get(repo.id, number) as Row | null;
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

export function editTicket(db: Database, repo: Repo, number: number, change: { title?: string; body?: string; tags?: string[]; priority?: string | null }, actor: string): Ticket {
  if (change.title === undefined && change.body === undefined && change.tags === undefined && change.priority === undefined) throw new TkError("nothing to change: pass --title, --body, --tags and/or --priority");
  if (change.title !== undefined && !change.title.trim()) throw new TkError("--title cannot be empty");
  const tags = change.tags === undefined ? undefined : normalizeTags(change.tags);
  const priority = change.priority === undefined ? undefined : checkedPriority(change.priority);
  return db.transaction(() => {
    const row = db.query("SELECT id, title, body, tags, priority FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number; title: string; body: string; tags: string; priority: Priority | null } | null;
    if (!row) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
    const now = Date.now();
    db.query("UPDATE tickets SET title = ?, body = ?, tags = ?, priority = ?, updated_at = ? WHERE id = ?").run(
      change.title?.trim() ?? row.title, change.body ?? row.body, tags === undefined ? row.tags : JSON.stringify(tags), priority === undefined ? row.priority : priority, now, row.id,
    );
    if (tags !== undefined) registerTags(db, repo, tags);
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
    if (db.query("SELECT 1 FROM tickets WHERE parent_id = ? LIMIT 1").get(row.id)) {
      throw new TkError(`cannot delete ${repo.slug}-${number}: delete its child tickets first`);
    }
    db.query("DELETE FROM handoffs WHERE ticket_id = ?").run(row.id);
    db.query("DELETE FROM events WHERE ticket_id = ?").run(row.id);
    db.query("DELETE FROM tickets WHERE id = ?").run(row.id);
  }).immediate();
}

/** One repo's tickets, or every repo's (`repo` null), optionally filtered by status, terminal and direct parent. */
export function listTickets(db: Database, repo: Repo | null, status: string | undefined, terminal: string | undefined, summaryOnly: true, parentNumber?: number): TicketSummary[];
export function listTickets(db: Database, repo: Repo | null, status?: string, terminal?: string, summaryOnly?: false, parentNumber?: number): Ticket[];
export function listTickets(db: Database, repo: Repo | null, status?: string, terminal?: string, summaryOnly = false, parentNumber?: number): TicketSummary[] | Ticket[] {
  const where = [repo ? "t.repo_id = $repo" : "1", status ? "t.status = $status" : "1", terminal ? "t.session_terminal = $terminal" : "1",
    parentNumber !== undefined ? "p.repo_id = $repo AND p.number = $parent" : "1"].join(" AND ");
  const rows = db
    .query(
      `SELECT r.slug, r.root, ${summaryOnly ? SUMMARY_PROJECTION : TICKET_PROJECTION}
       FROM tickets t JOIN repos r ON r.id = t.repo_id LEFT JOIN tickets p ON p.id = t.parent_id WHERE ${where} ORDER BY r.slug, t.number`,
    )
    .all({ ...(repo ? { repo: repo.id } : {}), ...(status ? { status } : {}), ...(terminal ? { terminal } : {}), ...(parentNumber !== undefined ? { parent: parentNumber } : {}) }) as ((Row | SummaryRow) & { slug: string; root: string })[];
  return rows.map(({ slug, root, ...r }) => fromRow({ slug, root }, r));
}

export const OPEN_STATUSES = ["todo", "in_progress", "in_review"];
