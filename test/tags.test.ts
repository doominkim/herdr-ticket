import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function fixture() {
  const sb = sandbox();
  cleanup = sb.cleanup;
  return sb;
}

describe("ticket tags", () => {
  test("creation normalizes tags and exposes them on full tickets and summaries", () => {
    const sb = fixture();
    const created = sb.json(["new", "Tagged work", "--tags", " BUG,fix,bug ,Feat "]);
    expect(created.tags).toEqual(["bug", "fix", "feat"]);
    expect(sb.json(["show", created.ref, "--latest-handoff"]).tags).toEqual(["bug", "fix", "feat"]);
    expect(sb.json(["ls"]).tickets[0].tags).toEqual(["bug", "fix", "feat"]);
    expect(sb.json(["brief"]).tickets[0].tags).toEqual(["bug", "fix", "feat"]);
  });

  test("equals syntax preserves names beginning with hyphens and clears them with an empty value", () => {
    const sb = fixture();
    const created = sb.json(["new", "Hyphen tags", "--tags=--bug,-"]);
    expect(created.tags).toEqual(["--bug", "-"]);
    expect(sb.json(["edit", created.ref, "--tags="]).tags).toEqual([]);
  });

  test("untagged tickets consistently return an empty array", () => {
    const sb = fixture();
    const created = sb.json(["new", "No tags"]);
    expect(created.tags).toEqual([]);
    expect(sb.json(["ls"]).tickets[0].tags).toEqual([]);
    expect(sb.json(["show", created.ref]).tags).toEqual([]);
  });

  test("editing replaces tags, omission preserves them, and empty input clears them without moving the origin", () => {
    const sb = fixture();
    const created = sb.json(["new", "Tagged work", "--body", "Original goal", "--tags", "bug,fix"], { cwd: sb.feat });
    sb.json(["status", created.ref, "in_review"]);
    const edited = sb.json(["edit", created.ref, "--tags", " FEAT,custom-tag,feat "]);
    expect(edited.tags).toEqual(["feat", "custom-tag"]);
    const renamed = sb.json(["edit", created.ref, "--title", "Renamed"]);
    expect(renamed.tags).toEqual(["feat", "custom-tag"]);
    expect([renamed.status, renamed.body, renamed.created_branch, renamed.created_worktree]).toEqual([
      "in_review", "Original goal", "feat", sb.feat,
    ]);
    expect(sb.json(["edit", created.ref, "--tags", ""]).tags).toEqual([]);
    sb.json(["edit", created.ref, "--tags", "fix"]);
    expect(sb.json(["edit", created.ref, "--tags", "   "]).tags).toEqual([]);
  });

  test("name length accepts 1 and 32 characters but rejects 33 without consuming a ticket number", () => {
    const sb = fixture();
    expect(sb.json(["new", "Boundary names", "--tags", `a,${"b".repeat(32)}`]).tags).toEqual(["a", "b".repeat(32)]);
    const tooLong = sb.tk(["new", "Too long", "--tags", "c".repeat(33)]);
    expect(tooLong.code).toBe(1);
    expect(sb.json(["new", "Next ticket"]).number).toBe(2);
  });

  test("eight unique tags are accepted after deduplication but nine are rejected atomically", () => {
    const sb = fixture();
    const eight = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const created = sb.json(["new", "Eight", "--tags", [...eight, "T1"].join(",")]);
    expect(created.tags).toEqual(eight);
    const rev = sb.json(["rev"]).rev;
    const failed = sb.tk(["edit", created.ref, "--title", "Must not change", "--tags", [...eight, "t9"].join(",")]);
    expect(failed.code).toBe(1);
    expect(sb.json(["show", created.ref]).title).toBe("Eight");
    expect(sb.json(["show", created.ref]).tags).toEqual(eight);
    expect(sb.json(["show", created.ref]).events).toEqual([]);
    expect(sb.json(["rev"]).rev).toBe(rev);
  });

  test("invalid characters, empty entries and missing values cannot change a ticket", () => {
    const sb = fixture();
    const created = sb.json(["new", "Keep me", "--tags", "fix"]);
    for (const value of ["bug fix", "bug,,fix", ",bug", "bug,", "버그", "bug_fix", "bug/fix"]) {
      expect(sb.tk(["edit", created.ref, "--title", "Rejected", "--tags", value]).code).toBe(1);
    }
    expect(sb.tk(["edit", created.ref, "--tags"]).code).toBe(1);
    expect(sb.tk(["new", "Missing value", "--tags"]).code).toBe(1);
    const kept = sb.json(["show", created.ref]);
    expect([kept.title, kept.tags, kept.events]).toEqual(["Keep me", ["fix"], []]);
  });
});
