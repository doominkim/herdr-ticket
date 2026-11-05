import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

const BODY = "## Done\n- a\n\n## In progress\n- b\n\n## Blocked\nNone\n\n## Next\n- c\n";

describe("delete", () => {
  test("removes the ticket with its handoffs and history", () => {
    sb = sandbox();
    sb.json(["new", "Keep"]);
    sb.json(["new", "Remove"]);
    sb.json(["status", "2", "in_progress"]);
    sb.json(["handoff", "2", "--summary", "s", "--body", "-"], { stdin: BODY });

    sb.json(["delete", "MAIN-2", "--yes"]);

    expect(sb.json(["ls"]).tickets.map((t: any) => t.ref)).toEqual(["MAIN-1"]);
    const r = sb.tk(["show", "2"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such ticket");
  });

  test("without --yes it refuses and leaves the ticket", () => {
    sb = sandbox();
    sb.json(["new", "Careful"]);
    const r = sb.tk(["delete", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--yes");
    expect(sb.json(["show", "1"]).title).toBe("Careful");
  });

  test("numbers are never reused", () => {
    sb = sandbox();
    for (const t of ["a", "b", "c"]) sb.json(["new", t]);
    sb.json(["delete", "2", "--yes"]);
    expect(sb.json(["new", "d"]).ref).toBe("MAIN-4");
  });

  test("a missing ticket is refused", () => {
    sb = sandbox();
    sb.json(["new", "Only"]);
    const r = sb.tk(["delete", "5", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such ticket");
  });
});
