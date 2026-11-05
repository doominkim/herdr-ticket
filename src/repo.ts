import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

export type Repo = { id: number; root: string; slug: string; name: string };

export class TkError extends Error {}

/** The repo's original main worktree: the folder holding the git common dir, from any worktree. */
export function mainWorktree(cwd: string): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.exitCode !== 0) throw new TkError(`not a git repository: ${cwd}`);
  return realpathSync(dirname(r.stdout.toString().trim()));
}

function baseSlug(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (letters || "REPO").slice(0, 4);
}

/**
 * A ticket reference: `MAIN-12` names its repo by slug (works from anywhere), a bare `12` means
 * the repo of `cwd`.
 */
export function resolveRef(db: Database, ref: string, cwd: string): { repo: Repo; number: number } {
  const bare = /^(\d+)$/.exec(ref);
  if (bare) return { repo: repoFor(db, cwd), number: Number(bare[1]) };
  const full = /^([A-Za-z0-9]+)-(\d+)$/.exec(ref);
  if (!full) throw new TkError(`not a ticket reference: "${ref}" (use MAIN-12 or 12)`);
  const repo = db.query("SELECT id, root, slug, name FROM repos WHERE slug = ?").get(full[1]!.toUpperCase()) as Repo | null;
  if (!repo) throw new TkError(`no such ticket: ${ref}`);
  return { repo, number: Number(full[2]) };
}

export const SLUG_RULE = /^[A-Z][A-Z0-9]{1,9}$/;

export function setSlug(db: Database, repo: Repo, slug: string): Repo {
  if (!SLUG_RULE.test(slug)) throw new TkError(`slug must be 2-10 uppercase letters or digits, starting with a letter: "${slug}"`);
  return db.transaction(() => {
    const taken = db.query("SELECT root FROM repos WHERE slug = ? AND id != ?").get(slug, repo.id) as { root: string } | null;
    if (taken) throw new TkError(`slug ${slug} is already used by ${taken.root}`);
    db.query("UPDATE repos SET slug = ? WHERE id = ?").run(slug, repo.id);
    return { ...repo, slug };
  }).immediate();
}

/** The repo for `cwd`, registered on first use. */
export function repoFor(db: Database, cwd: string): Repo {
  const root = mainWorktree(cwd);
  const find = () => db.query("SELECT id, root, slug, name FROM repos WHERE root = ?").get(root) as Repo | null;
  const found = find();
  if (found) return found;
  // First use may race with another process: look again under the write lock before inserting.
  return db.transaction(() => {
    const again = find();
    if (again) return again;
    const name = basename(root);
    const base = baseSlug(name);
    let slug = base;
    for (let n = 2; db.query("SELECT 1 FROM repos WHERE slug = ?").get(slug); n++) slug = `${base}${n}`;
    const id = Number(db.query("INSERT INTO repos (root, slug, name, created_at) VALUES (?, ?, ?, ?)").run(root, slug, name, Date.now()).lastInsertRowid);
    return { id, root, slug, name };
  }).immediate();
}
