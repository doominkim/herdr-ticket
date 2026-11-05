import type { Database } from "bun:sqlite";
import type { Author } from "./author";
import { TkError, whereAmI, type Repo } from "./repo";

export type Handoff = {
  summary: string;
  body: string;
  branch: string | null;
  worktree: string | null;
  created_by: string;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  created_at: number;
};

export const SUMMARY_MAX = 200;
export const HEADINGS = ["## Done", "## In progress", "## Blocked", "## Next"] as const;

/** The rules a handoff must meet before it is stored. */
export function validateHandoff(summary: string, body: string): void {
  if (!summary.trim()) throw new TkError("--summary is required");
  if ([...summary].length > SUMMARY_MAX) throw new TkError(`--summary is longer than ${SUMMARY_MAX} characters`);
  const lines = body.split("\n").map((l) => l.trimEnd());
  let from = 0;
  for (const h of HEADINGS) {
    const at = lines.indexOf(h, from);
    if (at < 0) throw new TkError(`the body needs these headings in this order: ${HEADINGS.join(", ")}`);
    from = at + 1;
  }
}


export function addHandoff(
  db: Database,
  repo: Repo,
  number: number,
  input: { summary: string; body: string; author: Author; cwd: string },
): Handoff {
  validateHandoff(input.summary, input.body);
  const { branch, worktree } = whereAmI(input.cwd);
  const a = input.author;
  return db.transaction(() => {
    const t = db.query("SELECT id FROM tickets WHERE repo_id = ? AND number = ?").get(repo.id, number) as { id: number } | null;
    if (!t) throw new TkError(`no such ticket: ${repo.slug}-${number}`);
    const now = Date.now();
    db.query(
      `INSERT INTO handoffs (ticket_id, summary, body, branch, worktree, created_by, provider, model, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, input.summary.trim(), input.body, branch, worktree, a.created_by, a.provider, a.model, a.session_id, now);
    db.query("UPDATE tickets SET updated_at = ? WHERE id = ?").run(now, t.id);
    return listHandoffs(db, repo, number)[0]!;
  }).immediate();
}

/** Newest first; latest-only reads fetch at most one row. */
export function listHandoffs(db: Database, repo: Repo, number: number, latestOnly = false): Handoff[] {
  return db
    .query(
      `SELECT h.summary, h.body, h.branch, h.worktree, h.created_by, h.provider, h.model, h.session_id, h.created_at
       FROM handoffs h JOIN tickets t ON t.id = h.ticket_id
       WHERE t.repo_id = ? AND t.number = ? ORDER BY h.id DESC${latestOnly ? " LIMIT 1" : ""}`,
    )
    .all(repo.id, number) as Handoff[];
}
