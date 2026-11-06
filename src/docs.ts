import type { Database } from "bun:sqlite";
import type { Author } from "./author";
import { repoFor, resolveRef, TkError, whereAmI, type Repo } from "./repo";

export const DOC_KINDS = ["spec", "adr", "note"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export type DocStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type Doc = {
  ref: string;
  repo_root: string;
  number: number;
  kind: DocKind;
  title: string;
  body: string;
  status: DocStatus | null;
  version: number;
  superseded_by: string | null;
  created_by: Author["created_by"];
  provider: string | null;
  model: string | null;
  session_id: string | null;
  created_branch: string | null;
  created_worktree: string | null;
  created_at: number;
  updated_at: number;
  revision_author: Author;
  session: { terminal: string; at: number } | null;
  ticket_refs: string[];
};
export type DocSummary = Pick<Doc, "ref" | "repo_root" | "number" | "kind" | "title" | "status" | "version" | "superseded_by" | "created_at" | "updated_at">;
export type DocRevision = {
  version: number; title: string; body: string; status: DocStatus | null;
  superseded_by: string | null; author: Author; created_at: number;
};
export type DocContext = { author: Author; cwd: string; terminal: string | null };
type SummaryRow = Omit<DocSummary, "ref" | "repo_root" | "superseded_by"> & { superseded_number: number | null };
type Row = SummaryRow & Pick<Doc, "body" | "created_by" | "provider" | "model" | "session_id" | "created_branch" | "created_worktree"> & {
  id: number; revision_author: string; session_terminal: string | null; session_at: number | null; superseded_by_id: number | null;
};
const SUMMARY = "number, kind, title, status, version, created_at, updated_at";
const FIELDS = `${SUMMARY}, body, created_by, provider, model, session_id, created_branch, created_worktree, revision_author, session_terminal, session_at, superseded_by_id`;
const projection = (columns: string) => columns.split(", ").map(c => `d.${c}`).join(", ");

function summary(repo: Repo, row: SummaryRow): DocSummary {
  return {
    ref: `${repo.slug}-D${row.number}`, repo_root: repo.root, number: row.number,
    kind: row.kind, title: row.title, status: row.status, version: row.version,
    superseded_by: row.superseded_number === null ? null : `${repo.slug}-D${row.superseded_number}`,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function resolveDocRef(db: Database, ref: string, cwd: string): { repo: Repo; number: number } {
  const bare = /^D(\d+)$/i.exec(ref);
  if (bare) return { repo: repoFor(db, cwd), number: Number(bare[1]) };
  const full = /^([A-Za-z0-9]+)-D(\d+)$/i.exec(ref);
  if (!full) throw new TkError(`not a document reference: "${ref}" (use MAIN-D1 or D1)`);
  const repo = db.query("SELECT id, root, slug, name FROM repos WHERE slug = ?").get(full[1]!.toUpperCase()) as Repo | null;
  if (!repo) throw new TkError(`no such document: ${ref}`);
  return { repo, number: Number(full[2]) };
}

function rowFor(db: Database, repo: Repo, number: number): Row {
  const row = db.query(`SELECT d.id, ${projection(FIELDS)}, s.number AS superseded_number
    FROM docs d LEFT JOIN docs s ON s.id = d.superseded_by_id WHERE d.repo_id = ? AND d.number = ?`).get(repo.id, number) as Row | null;
  if (!row) throw new TkError(`no such document: ${repo.slug}-D${number}`);
  return row;
}

export function getDoc(db: Database, repo: Repo, number: number): Doc {
  return db.transaction(() => {
    const row = rowFor(db, repo, number);
    const links = db.query(`SELECT t.number FROM doc_links l JOIN tickets t ON t.id = l.ticket_id
      WHERE l.doc_id = ? ORDER BY t.number`).all(row.id) as { number: number }[];
    return {
      ...summary(repo, row), body: row.body, created_by: row.created_by, provider: row.provider,
      model: row.model, session_id: row.session_id, created_branch: row.created_branch,
      created_worktree: row.created_worktree, revision_author: JSON.parse(row.revision_author) as Author,
      session: row.session_terminal ? { terminal: row.session_terminal, at: row.session_at ?? row.updated_at } : null,
      ticket_refs: links.map(t => `${repo.slug}-${t.number}`),
    };
  }).deferred();
}

export function createDoc(db: Database, repo: Repo, input: { title: string; body: string; kind: string; ticketRef?: string }, context: DocContext): Doc {
  if (!(DOC_KINDS as readonly string[]).includes(input.kind)) throw new TkError(`unknown document kind "${input.kind}": use ${DOC_KINDS.join(", ")}`);
  if (!input.title.trim()) throw new TkError("document title cannot be empty");
  const kind = input.kind as DocKind;
  const origin = whereAmI(context.cwd), now = Date.now(), author = context.author;
  return db.transaction(() => {
    const { next_doc_number: number } = db.query("SELECT next_doc_number FROM repos WHERE id = ?").get(repo.id) as { next_doc_number: number };
    db.query("UPDATE repos SET next_doc_number = next_doc_number + 1 WHERE id = ?").run(repo.id);
    db.query(`INSERT INTO docs (repo_id, number, kind, title, body, status, created_by, provider, model, session_id,
      created_branch, created_worktree, created_at, updated_at, revision_author, session_terminal, session_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      repo.id, number, kind, input.title.trim(), input.body, kind === "adr" ? "proposed" : null,
      author.created_by, author.provider, author.model, author.session_id, origin.branch, origin.worktree,
      now, now, JSON.stringify(author), context.terminal, context.terminal ? now : null,
    );
    if (input.ticketRef !== undefined) {
      const doc = rowFor(db, repo, number);
      const ticket = linkedTicketId(db, repo, input.ticketRef, context.cwd);
      db.query("INSERT INTO doc_links (doc_id, ticket_id) VALUES (?, ?)").run(doc.id, ticket);
    }
    return getDoc(db, repo, number);
  }).immediate();
}

type DocFilter = { kind?: string; status?: string; ticketRef?: string };

function queryDocs(db: Database, repo: Repo, where: string, params: Record<string, string | number> = {}): DocSummary[] {
  const rows = db.query(`SELECT ${projection(SUMMARY)}, s.number AS superseded_number
    FROM docs d LEFT JOIN docs s ON s.id = d.superseded_by_id
    WHERE d.repo_id = $repo AND ${where} ORDER BY d.number`).all({ repo: repo.id, ...params }) as SummaryRow[];
  return rows.map(row => summary(repo, row));
}

export function listDocs(db: Database, repo: Repo, filter: DocFilter = {}, cwd = repo.root): DocSummary[] {
  if (filter.kind !== undefined && !(DOC_KINDS as readonly string[]).includes(filter.kind)) throw new TkError(`unknown document kind "${filter.kind}"`);
  if (filter.status !== undefined && !["proposed", "accepted", "rejected", "superseded"].includes(filter.status)) throw new TkError(`unknown ADR status "${filter.status}"`);
  const ticket = filter.ticketRef === undefined ? undefined : linkedTicketId(db, repo, filter.ticketRef, cwd);
  const where = [filter.kind !== undefined ? "d.kind = $kind" : "1", filter.status !== undefined ? "d.status = $status" : "1",
    ticket !== undefined ? "EXISTS (SELECT 1 FROM doc_links l WHERE l.doc_id = d.id AND l.ticket_id = $ticket)" : "1"].join(" AND ");
  return queryDocs(db, repo, where, {
    ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(ticket !== undefined ? { ticket } : {}),
  });
}

function linkedTicketId(db: Database, repo: Repo, ref: string, cwd: string): number {
  const target = resolveRef(db, ref, cwd);
  if (target.repo.id !== repo.id) throw new TkError("document and ticket must belong to the same repository");
  const ticket = db.query("SELECT id FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, target.number) as { id: number } | null;
  if (!ticket) throw new TkError(`no such ticket: ${ref}`);
  return ticket.id;
}

function touchSession(db: Database, id: number, context: DocContext): void {
  if (context.terminal) db.query("UPDATE docs SET session_terminal = ?, session_at = ? WHERE id = ?").run(context.terminal, Date.now(), id);
}

export function linkDoc(db: Database, repo: Repo, number: number, ticketRef: string, context: DocContext): Doc {
  return db.transaction(() => {
    const doc = rowFor(db, repo, number), ticket = linkedTicketId(db, repo, ticketRef, context.cwd);
    db.query("INSERT OR IGNORE INTO doc_links (doc_id, ticket_id) VALUES (?, ?)").run(doc.id, ticket);
    touchSession(db, doc.id, context);
    return getDoc(db, repo, number);
  }).immediate();
}

export function unlinkDoc(db: Database, repo: Repo, number: number, ticketRef: string, context: DocContext): Doc {
  return db.transaction(() => {
    const doc = rowFor(db, repo, number), ticket = linkedTicketId(db, repo, ticketRef, context.cwd);
    db.query("DELETE FROM doc_links WHERE doc_id = ? AND ticket_id = ?").run(doc.id, ticket);
    touchSession(db, doc.id, context);
    return getDoc(db, repo, number);
  }).immediate();
}

export function docsForTicket(db: Database, repo: Repo, number: number): DocSummary[] {
  return queryDocs(db, repo, `EXISTS (SELECT 1 FROM doc_links l JOIN tickets t ON t.id = l.ticket_id
    WHERE l.doc_id = d.id AND t.repo_id = $repo AND t.number = $ticket)`, { ticket: number });
}

function revise(db: Database, row: Row, change: Pick<Row, "title" | "body" | "status" | "superseded_by_id">, context: DocContext): void {
  const now = Date.now();
  db.query(`INSERT INTO doc_revisions (doc_id, version, title, body, status, superseded_by_id, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.version, row.title, row.body, row.status, row.superseded_by_id, row.revision_author, row.updated_at);
  db.query(`UPDATE docs SET title = ?, body = ?, status = ?, superseded_by_id = ?, version = version + 1,
    revision_author = ?, updated_at = ?, session_terminal = ?, session_at = ? WHERE id = ?`).run(
    change.title, change.body, change.status, change.superseded_by_id, JSON.stringify(context.author), now,
    context.terminal ?? row.session_terminal, context.terminal ? now : row.session_at, row.id,
  );
}

export function editDoc(db: Database, repo: Repo, number: number, change: { title?: string; body?: string }, context: DocContext): Doc {
  if (change.title === undefined && change.body === undefined) throw new TkError("nothing to change: pass --title and/or --body");
  if (change.title !== undefined && !change.title.trim()) throw new TkError("--title cannot be empty");
  return db.transaction(() => {
    const row = rowFor(db, repo, number);
    revise(db, row, { title: change.title?.trim() ?? row.title, body: change.body ?? row.body, status: row.status, superseded_by_id: row.superseded_by_id }, context);
    return getDoc(db, repo, number);
  }).immediate();
}

export function docHistory(db: Database, repo: Repo, number: number): DocRevision[] {
  const doc = rowFor(db, repo, number);
  const rows = db.query(`SELECT r.version, r.title, r.body, r.status, r.author, r.created_at, s.number AS superseded_number
    FROM doc_revisions r LEFT JOIN docs s ON s.id = r.superseded_by_id WHERE r.doc_id = ? ORDER BY r.version`).all(doc.id) as
    (Omit<DocRevision, "author" | "superseded_by"> & { author: string; superseded_number: number | null })[];
  return rows.map(({ author, superseded_number, ...row }) => ({
    ...row, author: JSON.parse(author) as Author,
    superseded_by: superseded_number === null ? null : `${repo.slug}-D${superseded_number}`,
  }));
}

export function setDocStatus(db: Database, repo: Repo, number: number, status: string, context: DocContext): Doc {
  if (status === "superseded") throw new TkError("use tk doc supersede <old> --by <new>");
  if (!["proposed", "accepted", "rejected"].includes(status)) throw new TkError(`unknown ADR status "${status}"`);
  return db.transaction(() => {
    const row = rowFor(db, repo, number);
    if (row.kind !== "adr") throw new TkError("only ADR documents have a status");
    if (row.status !== "proposed" && row.status !== status) throw new TkError("only a proposed ADR can be accepted or rejected");
    revise(db, row, { title: row.title, body: row.body, status: status as DocStatus, superseded_by_id: row.superseded_by_id }, context);
    return getDoc(db, repo, number);
  }).immediate();
}

export function supersedeDoc(db: Database, repo: Repo, number: number, by: string, context: DocContext): Doc {
  return db.transaction(() => {
    const old = rowFor(db, repo, number), target = resolveDocRef(db, by, context.cwd);
    if (target.repo.id !== repo.id) throw new TkError("both ADRs must belong to the same repository");
    if (target.number === number) throw new TkError("an ADR cannot supersede itself");
    const replacement = rowFor(db, repo, target.number);
    if (old.kind !== "adr" || replacement.kind !== "adr") throw new TkError("only ADR documents can supersede another ADR");
    if (old.status !== "accepted" || replacement.status !== "accepted") throw new TkError("both ADRs must be accepted before superseding");
    revise(db, old, { title: old.title, body: old.body, status: "superseded", superseded_by_id: replacement.id }, context);
    return getDoc(db, repo, number);
  }).immediate();
}
