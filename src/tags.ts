import type { Database } from "bun:sqlite";
import type { Repo } from "./repo";

import { TAG_COLORS } from "../mods/herdr-ticket/tag-colors.js";
export type TagColor = (typeof TAG_COLORS)[number];
export type RepoTag = { name: string; color: TagColor };

export function listTags(db: Database, repo: Repo): RepoTag[] {
  return db.query("SELECT name, color FROM repo_tags WHERE repo_id = ? ORDER BY id").all(repo.id) as RepoTag[];
}

/** Called only inside a ticket write transaction, after its tags and target have been validated. */
export function registerTags(db: Database, repo: Repo, tags: readonly string[]): void {
  if (!tags.length) return;
  let { count } = db.query("SELECT COUNT(*) AS count FROM repo_tags WHERE repo_id = ?").get(repo.id) as { count: number };
  const insert = db.query("INSERT INTO repo_tags (repo_id, name, color) VALUES (?, ?, ?) ON CONFLICT (repo_id, name) DO NOTHING");
  for (const name of tags) {
    const result = insert.run(repo.id, name, TAG_COLORS[count % TAG_COLORS.length]!);
    if (result.changes) count++;
  }
}
