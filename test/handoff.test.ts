import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

const BODY = "## Done\n- Fixed login\n\n## In progress\n- Nothing\n\n## Blocked\nNone\n\n## Next\n- Ask for review\n";
const AGENT = ["--provider", "anthropic", "--model", "claude-opus-5-5", "--session", "s9"];

describe("handoff", () => {
  test("a handoff left in a worktree is stored with branch, worktree and author", () => {
    sb = sandbox();
    sb.json(["new", "Hand it over"]);
    sb.json(["handoff", "MAIN-1", "--summary", "MAIN-1 login fixed", "--body", "-", ...AGENT], { cwd: sb.feat, stdin: BODY });

    const t = sb.json(["show", "1"]);

    expect(t.handoffs).toHaveLength(1);
    const h = t.handoffs[0];
    expect([h.summary, h.body, h.branch, h.worktree]).toEqual(["MAIN-1 login fixed", BODY, "feat", sb.feat]);
    expect([h.provider, h.model, h.session_id]).toEqual(["anthropic", "claude-opus-5-5", "s9"]);
  });

  test("the newest handoff comes first", () => {
    sb = sandbox();
    sb.json(["new", "Twice"]);
    sb.json(["handoff", "1", "--summary", "first", "--body", "-"], { stdin: BODY });
    sb.json(["handoff", "1", "--summary", "second", "--body", "-"], { stdin: BODY });
    expect(sb.json(["show", "1"]).handoffs.map((h: any) => h.summary)).toEqual(["second", "first"]);
  });

  test("a summary of 200 characters is accepted, 201 is refused", () => {
    sb = sandbox();
    sb.json(["new", "Summary length"]);
    expect(sb.tk(["handoff", "1", "--summary", "a".repeat(200), "--body", "-"], { stdin: BODY }).code).toBe(0);
    const r = sb.tk(["handoff", "1", "--summary", "a".repeat(201), "--body", "-"], { stdin: BODY });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("200");
  });

  test("an empty summary is refused", () => {
    sb = sandbox();
    sb.json(["new", "Empty summary"]);
    const r = sb.tk(["handoff", "1", "--summary", " ", "--body", "-"], { stdin: BODY });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--summary");
  });

  test("a body missing one of the four headings is refused", () => {
    sb = sandbox();
    sb.json(["new", "Missing heading"]);
    const r = sb.tk(["handoff", "1", "--summary", "missing", "--body", "-"], { stdin: BODY.replace("## Blocked\nNone\n\n", "") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("## Done, ## In progress, ## Blocked, ## Next");
  });

  test("the four headings out of order are refused", () => {
    sb = sandbox();
    sb.json(["new", "Order"]);
    const swapped = "## In progress\n- a\n\n## Done\n- b\n\n## Blocked\nNone\n\n## Next\n- c\n";
    const r = sb.tk(["handoff", "1", "--summary", "order", "--body", "-"], { stdin: swapped });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("## Done, ## In progress, ## Blocked, ## Next");
  });

  test("inside an agent a handoff without provider and model is refused", () => {
    sb = sandbox();
    sb.json(["new", "Anonymous handoff"]);
    const r = sb.tk(["handoff", "1", "--summary", "anon", "--body", "-"], { stdin: BODY, env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(1);
    expect(sb.json(["show", "1"]).handoffs).toHaveLength(0);
  });
});
