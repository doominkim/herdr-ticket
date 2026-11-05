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

describe("show", () => {
  test("--latest-handoff returns current ticket and only the newest handoff without events", () => {
    sb = sandbox();
    sb.json(["new", "Original title", "--body", "-"], { stdin: "Original goal\n" });
    sb.json(["handoff", "1", "--summary", "Old checkpoint", "--body", "-"], {
      stdin: "## Done\nOld work\n\n## In progress\nOld task\n\n## Blocked\nNone\n\n## Next\nOld next step\n",
    });
    sb.json(["status", "1", "in_progress"]);
    sb.json(["edit", "1", "--title", "Current title", "--body", "-"], { stdin: "Current goal\n" });
    const newestBody = "## Done\nNew work\n\n## In progress\nNew task\n\n## Blocked\nNone\n\n## Next\nNew next step\n";
    sb.json(["handoff", "1", "--summary", "Newest checkpoint", "--body", "-"], { stdin: newestBody });
    sb.json(["status", "1", "in_review"]);
    sb.json(["link", "1", "--terminal", "t-current"]);

    const ticket = sb.json(["show", "1", "--latest-handoff"]);

    expect([ticket.ref, ticket.title, ticket.body, ticket.status]).toEqual(["MAIN-1", "Current title", "Current goal\n", "in_review"]);
    expect(ticket.session.terminal).toBe("t-current");
    expect(ticket.handoffs).toHaveLength(1);
    expect([ticket.handoffs[0].summary, ticket.handoffs[0].body]).toEqual(["Newest checkpoint", newestBody]);
    expect(ticket).not.toHaveProperty("events");
    expect(JSON.stringify(ticket)).not.toContain("Old checkpoint");

    const full = sb.json(["show", "1"]);
    expect(full.handoffs.map((h: { summary: string }) => h.summary)).toEqual(["Newest checkpoint", "Old checkpoint"]);
    expect(full.events.map((e: { kind: string }) => e.kind)).toEqual(["status", "edit", "status"]);
  });

  test("--latest-handoff keeps an empty handoffs array and ticket body when no handoff exists", () => {
    sb = sandbox();
    sb.json(["new", "No checkpoint", "--body", "-"], { stdin: "Goal without handoffs\n" });
    sb.json(["status", "1", "in_progress"]);

    const ticket = sb.json(["show", "1", "--latest-handoff"]);
    expect(ticket.handoffs).toEqual([]);
    expect(ticket.body).toBe("Goal without handoffs\n");
    expect(ticket.status).toBe("in_progress");
    expect(ticket.session).toBeNull();
    expect(ticket).not.toHaveProperty("events");
    const text = sb.tk(["show", "1", "--latest-handoff"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Goal without handoffs");
    expect(text.stdout).not.toContain("--- latest handoff");
  });

  test("default text shows only the newest handoff while default JSON retains history", () => {
    sb = sandbox();
    sb.json(["new", "Readable ticket", "--body", "-"], { stdin: "Readable goal\n" });
    sb.json(["handoff", "1", "--summary", "Old summary", "--body", "-"], { stdin: BODY.replace("- a", "Old completed work") });
    sb.json(["handoff", "1", "--summary", "New summary", "--body", "-"], { stdin: BODY.replace("- a", "New completed work") });

    for (const flags of [[], ["--latest-handoff"]]) {
      const result = sb.tk(["show", "1", ...flags]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Readable goal");
      expect(result.stdout).toContain("New summary");
      expect(result.stdout).toContain("New completed work");
      expect(result.stdout).not.toContain("Old summary");
      expect(result.stdout).not.toContain("Old completed work");
    }
    expect(sb.json(["show", "1"]).handoffs).toHaveLength(2);
  });

  test("--latest-handoff still rejects a missing ticket", () => {
    sb = sandbox();
    sb.json(["new", "Existing"]);
    const result = sb.tk(["show", "2", "--latest-handoff", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no such ticket");
    expect(result.stdout).toBe("");
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
  test("JSON summaries retain identity, state, session and repository without ticket bodies or authors", () => {
    sb = sandbox();
    sb.json(["new", "Completed work", "--body", "-"], { stdin: "Detailed completed goal\n" });
    sb.json(["link", "1", "--terminal", "t-finished"]);
    sb.json(["handoff", "1", "--summary", "Finished checkpoint", "--body", "-"], { stdin: BODY });
    sb.json(["status", "1", "done"]);
    sb.json(["new", "Unlinked work"]);

    const list = sb.json(["ls"]);
    expect(list.repo.root).toBe(sb.main);
    expect(list.tickets[0]).toEqual({
      ref: "MAIN-1",
      parent_ref: null,
      repo_root: sb.main,
      number: 1,
      title: "Completed work",
      status: "done",
      tags: [],
      session: { terminal: "t-finished", at: expect.any(Number) },
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
    expect(list.tickets[1].session).toBeNull();
    for (const ticket of list.tickets) {
      for (const field of ["body", "created_by", "provider", "model", "session_id", "events", "handoffs"]) {
        expect(ticket).not.toHaveProperty(field);
      }
    }

    const detail = sb.json(["show", list.tickets[0].ref, "--latest-handoff"]);
    expect(detail.body).toBe("Detailed completed goal\n");
    expect(detail.session).toEqual(list.tickets[0].session);
    expect(detail.status).toBe("done");
    expect(detail.handoffs[0].summary).toBe("Finished checkpoint");
  });

  test("status and terminal filters combine across repositories and keep the repo wrapper", () => {
    sb = sandbox();
    const api = otherRepo(sb.dir, "api");
    sb.json(["new", "Match here"], { env: { HC_TERMINAL_ID: "t-shared" } });
    sb.json(["new", "Wrong terminal"], { env: { HC_TERMINAL_ID: "t-other" } });
    sb.json(["new", "Wrong status"], { env: { HC_TERMINAL_ID: "t-shared" } });
    sb.json(["new", "Match elsewhere"], { cwd: api, env: { HC_TERMINAL_ID: "t-shared" } });
    sb.json(["status", "1", "done"]);
    sb.json(["status", "2", "done"]);
    sb.json(["status", "1", "done"], { cwd: api });

    const local = sb.json(["ls", "--status", "done", "--terminal", "t-shared"], { cwd: sb.feat });
    expect(local.repo.root).toBe(sb.main);
    expect(local.tickets.map((t: { ref: string }) => t.ref)).toEqual(["MAIN-1"]);
    const all = sb.json(["ls", "--all-repos", "--status", "done", "--terminal", "t-shared"], { cwd: sb.plain });
    expect(all.repo).toBeNull();
    expect(all.tickets.map((t: { ref: string; repo_root: string }) => [t.ref, t.repo_root])).toEqual([
      ["API-1", api], ["MAIN-1", sb.main],
    ]);
    const empty = sb.json(["ls", "--terminal", "t-missing"]);
    expect(empty.repo.root).toBe(sb.main);
    expect(empty.tickets).toEqual([]);
  });

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
