import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

const BODY = "## Done\n- a\n\n## In progress\n- b\n\n## Blocked\nNone\n\n## Next\n- c\n";
const inTerminal = (id: string) => ({ env: { HC_TERMINAL_ID: id } });

describe("session", () => {
  test("a write from inside a Herdr terminal attaches that terminal to the ticket", () => {
    sb = sandbox();
    sb.json(["new", "Watched"], inTerminal("t9"));
    expect(sb.json(["show", "1"]).session.terminal).toBe("t9");
  });

  test("the last writing terminal wins, for status, edit and handoff alike", () => {
    sb = sandbox();
    sb.json(["new", "Passed around"], inTerminal("t9"));
    sb.json(["status", "1", "in_progress"], inTerminal("t10"));
    expect(sb.json(["show", "1"]).session.terminal).toBe("t10");
    sb.json(["edit", "1", "--title", "Renamed"], inTerminal("t11"));
    expect(sb.json(["show", "1"]).session.terminal).toBe("t11");
    sb.json(["handoff", "1", "--summary", "s", "--body", "-"], { stdin: BODY, ...inTerminal("t12") });
    expect(sb.json(["show", "1"]).session.terminal).toBe("t12");
  });

  test("a write from outside Herdr keeps the attached session", () => {
    sb = sandbox();
    sb.json(["new", "Stays"], inTerminal("t9"));
    sb.json(["status", "1", "in_review"]);
    expect(sb.json(["show", "1"]).session.terminal).toBe("t9");
  });

  test("a ticket nobody worked on from Herdr has no session", () => {
    sb = sandbox();
    sb.json(["new", "Untouched"]);
    expect(sb.json(["show", "1"]).session).toBeNull();
  });

  test("link attaches a terminal explicitly, and ls and brief carry it", () => {
    sb = sandbox();
    sb.json(["new", "Linked"]);
    sb.json(["link", "MAIN-1", "--terminal", "t20"]);
    expect(sb.json(["ls"]).tickets[0].session.terminal).toBe("t20");
    expect(sb.json(["brief"]).tickets[0].session.terminal).toBe("t20");
  });

  test("ls --terminal finds the tickets a terminal works on, across repositories, with their repo root", () => {
    sb = sandbox();
    sb.json(["new", "Mine"], inTerminal("t30"));
    sb.json(["new", "Someone else's"], inTerminal("t31"));
    const found = sb.json(["ls", "--all-repos", "--terminal", "t30"], { cwd: sb.plain });
    expect(found.tickets.map((t: any) => [t.ref, t.repo_root])).toEqual([["MAIN-1", sb.main]]);
  });

  test("link needs --terminal and an existing ticket", () => {
    sb = sandbox();
    sb.json(["new", "x"]);
    expect(sb.tk(["link", "1"]).stderr).toContain("--terminal");
    expect(sb.tk(["link", "9", "--terminal", "t1"]).stderr).toContain("no such ticket");
  });
});
