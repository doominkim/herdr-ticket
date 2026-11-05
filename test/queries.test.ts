import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

const BODY = "## Done\n- a\n\n## In progress\n- b\n\n## Blocked\nNone\n\n## Next\n- c\n";

function otherRepo(dir: string, name: string) {
  const root = join(dir, name);
  for (const cmd of [["mkdir", "-p", root], ["git", "init", "-q", root], ["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]]) {
    if (Bun.spawnSync(cmd).exitCode !== 0) throw new Error(cmd.join(" "));
  }
  return root;
}

describe("brief", () => {
  test("only open tickets, each with its latest handoff summary", () => {
    sb = sandbox();
    sb.json(["new", "Open"]);
    sb.json(["new", "Finished"]);
    sb.json(["new", "Dropped"]);
    sb.json(["status", "2", "done"]);
    sb.json(["status", "3", "canceled"]);
    sb.json(["handoff", "1", "--summary", "old handoff", "--body", "-"], { stdin: BODY });
    sb.json(["handoff", "1", "--summary", "new handoff", "--body", "-"], { stdin: BODY });

    const b = sb.json(["brief"], { cwd: sb.feat });

    expect(b.repo.slug).toBe("MAIN");
    expect(b.tickets.map((t: any) => [t.ref, t.status, t.latest_handoff?.summary])).toEqual([["MAIN-1", "todo", "new handoff"]]);
  });
});

describe("rev", () => {
  test("every write raises it, reads leave it", () => {
    sb = sandbox();
    const rev = () => sb.json(["rev"]).rev as number;
    const r0 = rev();
    sb.json(["new", "Watch me"]);
    const r1 = rev();
    sb.json(["status", "1", "in_progress"]);
    const r2 = rev();
    sb.json(["handoff", "1", "--summary", "handoff", "--body", "-"], { stdin: BODY });
    const r3 = rev();
    sb.json(["edit", "1", "--title", "New title"]);
    const r4 = rev();
    sb.json(["show", "1"]);
    sb.json(["ls"]);

    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(r3).toBeGreaterThan(r2);
    expect(r4).toBeGreaterThan(r3);
    expect(rev()).toBe(r4);
  });
});

describe("edit", () => {
  test("changes title and body and records it", () => {
    sb = sandbox();
    sb.json(["new", "Old title"]);
    sb.json(["edit", "1", "--title", "New title", "--body", "-"], { stdin: "## Goal\nChanged\n" });
    const t = sb.json(["show", "1"]);
    expect([t.title, t.body]).toEqual(["New title", "## Goal\nChanged\n"]);
    expect(t.events.map((e: any) => [e.kind, e.actor])).toEqual([["edit", "human"]]);
  });

  test("nothing to change is refused", () => {
    sb = sandbox();
    sb.json(["new", "Same"]);
    expect(sb.tk(["edit", "1"]).code).toBe(1);
  });
});

describe("ls", () => {
  test("--status filters by status", () => {
    sb = sandbox();
    sb.json(["new", "a"]);
    sb.json(["new", "b"]);
    sb.json(["status", "2", "in_review"]);
    expect(sb.json(["ls", "--status", "in_review"]).tickets.map((t: any) => t.ref)).toEqual(["MAIN-2"]);
  });

  test("--all-repos includes other repositories", () => {
    sb = sandbox();
    const api = otherRepo(sb.dir, "api");
    sb.json(["new", "Main work"]);
    sb.json(["new", "API work"], { cwd: api });
    const all = sb.json(["ls", "--all-repos"]).tickets.map((t: any) => t.ref).sort();
    expect(all).toEqual(["API-1", "MAIN-1"]);
  });
});

describe("repo slug", () => {
  test("renaming the slug renames the refs", () => {
    sb = sandbox();
    sb.json(["new", "Refs"]);
    sb.json(["repo", "slug", "VAN"]);
    expect(sb.json(["show", "VAN-1"]).ref).toBe("VAN-1");
  });

  test("a slug used by another repository is refused", () => {
    sb = sandbox();
    const api = otherRepo(sb.dir, "api");
    sb.json(["new", "a"], { cwd: api });
    const r = sb.tk(["repo", "slug", "API"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already used");
  });

  test("2-10 uppercase letters or digits, starting with a letter", () => {
    sb = sandbox();
    expect(sb.tk(["repo", "slug", "AB"]).code).toBe(0);
    expect(sb.tk(["repo", "slug", "ABCDEFGHIJ"]).code).toBe(0);
    for (const bad of ["A", "ABCDEFGHIJK", "1AB", "AB-C"]) {
      const r = sb.tk(["repo", "slug", bad]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("2-10");
    }
  });
});
