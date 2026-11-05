import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

describe("status", () => {
  test("show has the new status and the history of changes", () => {
    sb = sandbox();
    sb.json(["new", "Move it"]);
    sb.json(["status", "1", "in_progress"]);
    sb.json(["status", "MAIN-1", "in_review", "--provider", "anthropic", "--model", "claude-opus-5-5"], { cwd: sb.feat });

    const t = sb.json(["show", "MAIN-1"]);

    expect(t.status).toBe("in_review");
    expect(t.events.map((e: any) => [e.from_status, e.to_status, e.actor])).toEqual([
      ["todo", "in_progress", "human"],
      ["in_progress", "in_review", "anthropic/claude-opus-5-5"],
    ]);
  });

  test("all five statuses are accepted", () => {
    sb = sandbox();
    sb.json(["new", "Five"]);
    for (const s of ["in_progress", "in_review", "done", "canceled", "todo"]) {
      expect(sb.json(["status", "1", s]).status).toBe(s);
    }
  });

  test("anything else is refused with the accepted values", () => {
    sb = sandbox();
    sb.json(["new", "Wrong status"]);
    const r = sb.tk(["status", "1", "doing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("todo, in_progress, in_review, done, canceled");
    expect(sb.json(["show", "1"]).status).toBe("todo");
  });

  test("a reference to a missing ticket is refused", () => {
    sb = sandbox();
    sb.json(["new", "Only one"]);
    for (const ref of ["2", "MAIN-2", "NOPE-1"]) {
      const r = sb.tk(["show", ref]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no such ticket");
    }
  });
});
