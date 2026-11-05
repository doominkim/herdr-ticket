import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

describe("repository", () => {
  test("a ticket issued in a worktree belongs to the original main worktree's repository", () => {
    sb = sandbox();
    sb.json(["new", "Fix the login bug"], { cwd: sb.feat });

    const list = sb.json(["ls"], { cwd: sb.main });

    expect(list.repo.root).toBe(sb.main);
    expect(list.tickets.map((t: any) => [t.ref, t.title, t.status])).toEqual([["MAIN-1", "Fix the login bug", "todo"]]);
  });

  test("outside a git repository it refuses", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Anything"], { cwd: sb.plain });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a git repository");
  });
});

describe("content and author", () => {
  test("a person issues as human; an empty body gets the Goal / Done when template", () => {
    sb = sandbox();
    const t = sb.json(["new", "Template"]);
    expect(t.created_by).toBe("human");
    expect(t.body).toBe("## Goal\n\n## Done when\n- [ ] \n");
  });

  test("--body - reads the body from standard input", () => {
    sb = sandbox();
    const t = sb.json(["new", "With a body", "--body", "-"], { stdin: "## Goal\nLogin works\n" });
    expect(t.body).toBe("## Goal\nLogin works\n");
  });

  test("an agent records provider and model together", () => {
    sb = sandbox();
    const t = sb.json(["new", "By an agent", "--provider", "anthropic", "--model", "claude-opus-5-5", "--session", "s1"]);
    expect([t.created_by, t.provider, t.model, t.session_id]).toEqual(["agent", "anthropic", "claude-opus-5-5", "s1"]);
  });

  test("provider without model is refused", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Half", "--provider", "anthropic"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--provider and --model");
  });

  test("inside an agent (CLAUDECODE=1) a write without provider and model is refused", () => {
    sb = sandbox();
    const r = sb.tk(["new", "Anonymous"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--provider and --model");
  });
});

describe("numbering", () => {
  test("ten processes issuing at once get 1..10 with no gaps or repeats", async () => {
    sb = sandbox();
    sb.json(["ls"]); // register the repo and create the schema first
    const issue = (i: number) =>
      Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "new", `Concurrent ${i}`], {
        cwd: sb.main,
        env: { ...sb.env, HERDR_TICKET_DB: sb.db },
        stderr: "pipe",
      }).exited;
    const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => issue(i)));

    expect(codes).toEqual(Array(10).fill(0));
    const numbers = sb.json(["ls"]).tickets.map((t: any) => t.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("first use on an empty database from many processes registers one repo and continuous numbers", async () => {
    sb = sandbox();
    const issue = (i: number, cwd: string) =>
      Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "new", `First ${i}`], {
        cwd,
        env: { ...sb.env, HERDR_TICKET_DB: sb.db },
        stderr: "pipe",
      }).exited;
    const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => issue(i, i % 2 ? sb.feat : sb.main)));

    expect(codes).toEqual(Array(6).fill(0));
    const list = sb.json(["ls"]);
    expect(list.repo.slug).toBe("MAIN");
    expect(list.tickets.map((t: any) => t.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
