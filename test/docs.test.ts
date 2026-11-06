import { afterEach, describe, expect, test } from "bun:test";
import { sandbox } from "./helpers";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let sb: ReturnType<typeof sandbox>;
afterEach(() => sb?.cleanup());

function anotherRepo() {
  const root = join(sb.dir, "other");
  mkdirSync(root);
  const r = Bun.spawnSync(["git", "init", "-q", "-b", "main", root], { env: { ...sb.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return root;
}

describe("repository documents", () => {
  test("a worktree creates a shared spec with its own document counter and readable persisted body", () => {
    sb = sandbox();
    sb.json(["new", "첫 티켓"]);
    const body = "## 요구사항\n사용자와 에이전트가 같은 명세를 읽는다.\n";
    const doc = sb.json(["doc", "new", "문서 저장 명세", "--kind", "spec", "--body", "-"], { cwd: sb.feat, stdin: body });
    expect([doc.ref, doc.number, doc.kind, doc.status, doc.title, doc.body, doc.repo_root]).toEqual([
      "MAIN-D1", 1, "spec", null, "문서 저장 명세", body, sb.main,
    ]);
    expect([doc.created_branch, doc.created_worktree, doc.version, doc.superseded_by, doc.ticket_refs]).toEqual([
      "feat", sb.feat, 1, null, [],
    ]);
    const shown = sb.json(["doc", "show", "D1"], { cwd: sb.main });
    expect([shown.ref, shown.body, shown.created_worktree]).toEqual(["MAIN-D1", body, sb.feat]);
    const listed = sb.json(["doc", "ls"]);
    expect(listed.repo.root).toBe(sb.main);
    expect(listed.docs.map((d: { ref: string; kind: string; title: string }) => [d.ref, d.kind, d.title])).toEqual([
      ["MAIN-D1", "spec", "문서 저장 명세"],
    ]);
    expect(listed.docs[0]).not.toHaveProperty("body");
    expect(sb.json(["new", "두 번째 티켓"]).ref).toBe("MAIN-2");
  });

  test("many-to-many ticket links appear as summaries and unlink without deleting either record", () => {
    sb = sandbox();
    sb.json(["new", "첫 티켓"]);
    sb.json(["new", "둘째 티켓"]);
    const doc = sb.json(["doc", "new", "연결 명세", "--kind", "spec", "--ticket", "MAIN-1", "--body", "-"], { stdin: "명세 본문은 요약에 포함하지 않는다." });
    expect(doc.ticket_refs).toEqual(["MAIN-1"]);
    expect(sb.json(["doc", "link", "D1", "--ticket", "2"]).ticket_refs).toEqual(["MAIN-1", "MAIN-2"]);
    sb.json(["doc", "new", "작업 메모", "--kind", "note", "--ticket", "1"]);
    const shown = sb.json(["show", "1", "--latest-handoff"]);
    expect(shown.docs.map((d: { ref: string; kind: string }) => [d.ref, d.kind])).toEqual([["MAIN-D1", "spec"], ["MAIN-D2", "note"]]);
    expect(shown.docs[0]).not.toHaveProperty("body");
    expect(sb.json(["brief"]).tickets[0].docs.map((d: { ref: string }) => d.ref)).toEqual(["MAIN-D1", "MAIN-D2"]);
    expect(sb.json(["doc", "ls", "--ticket", "2"]).docs.map((d: { ref: string }) => d.ref)).toEqual(["MAIN-D1"]);
    expect(sb.json(["doc", "unlink", "D1", "--ticket", "1"]).ticket_refs).toEqual(["MAIN-2"]);
    expect(sb.json(["show", "1"]).docs.map((d: { ref: string }) => d.ref)).toEqual(["MAIN-D2"]);
    expect(sb.json(["doc", "show", "D1"]).body).toBe("명세 본문은 요약에 포함하지 않는다.");
    expect(sb.json(["show", "2"]).docs.map((d: { ref: string }) => d.ref)).toEqual(["MAIN-D1"]);
  });

  test("edits retain earlier versions and their writers without rewriting creation origin", () => {
    sb = sandbox();
    const first = sb.json(["doc", "new", "첫 메모", "--kind", "note", "--body", "-", "--provider", "openai", "--model", "writer-one", "--session", "s-one"], {
      cwd: sb.feat, stdin: "첫 본문\n", env: { HC_TERMINAL_ID: "t-one" },
    });
    const second = sb.json(["doc", "edit", "D1", "--title", "수정한 메모", "--body", "-", "--provider", "anthropic", "--model", "writer-two", "--session", "s-two"], {
      cwd: sb.main, stdin: "두 번째 본문\n", env: { HC_TERMINAL_ID: "t-two" },
    });
    expect([second.title, second.body, second.version, second.provider, second.created_at, second.created_branch, second.created_worktree]).toEqual([
      "수정한 메모", "두 번째 본문\n", 2, "openai", first.created_at, "feat", sb.feat,
    ]);
    expect(second.revision_author).toEqual({ created_by: "agent", provider: "anthropic", model: "writer-two", session_id: "s-two" });
    expect(second.session.terminal).toBe("t-two");
    sb.json(["doc", "edit", "D1", "--title", "세 번째 제목"]);
    const current = sb.json(["doc", "show", "D1"]);
    expect([current.title, current.body, current.version, current.session.terminal]).toEqual(["세 번째 제목", "두 번째 본문\n", 3, "t-two"]);
    expect(current).not.toHaveProperty("history");
    const history = sb.json(["doc", "show", "D1", "--history"]).history;
    expect(history.map((r: any) => [r.version, r.title, r.body, r.status, r.author.model, r.created_at])).toEqual([
      [1, "첫 메모", "첫 본문\n", null, "writer-one", first.created_at],
      [2, "수정한 메모", "두 번째 본문\n", null, "writer-two", second.updated_at],
    ]);
    const text = sb.tk(["doc", "show", "D1", "--history"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("첫 본문");
    expect(text.stdout).toContain("두 번째 본문");
  });

  test("ADR decisions advance from proposed and status changes preserve earlier versions", () => {
    sb = sandbox();
    const first = sb.json(["doc", "new", "채택할 결정", "--kind", "adr"]);
    expect(first.status).toBe("proposed");
    const accepted = sb.json(["doc", "status", "D1", "accepted"]);
    expect([accepted.status, accepted.version, accepted.superseded_by]).toEqual(["accepted", 2, null]);
    expect(sb.json(["doc", "show", "D1", "--history"]).history.map((r: any) => [r.version, r.status])).toEqual([[1, "proposed"]]);
    const rev = sb.json(["rev"]).rev;
    for (const status of ["proposed", "rejected", "superseded", "unknown"]) expect(sb.tk(["doc", "status", "D1", status]).code).toBe(1);
    expect(sb.json(["rev"]).rev).toBe(rev);
    expect(sb.json(["doc", "show", "D1"]).status).toBe("accepted");
    sb.json(["doc", "new", "기각할 결정", "--kind", "adr"]);
    expect(sb.json(["doc", "status", "D2", "rejected"]).status).toBe("rejected");
    expect(sb.tk(["doc", "status", "D2", "accepted"]).code).toBe(1);
    expect(sb.json(["doc", "ls", "--kind", "adr", "--status", "accepted"]).docs.map((d: any) => d.ref)).toEqual(["MAIN-D1"]);
    expect(sb.json(["doc", "ls", "--status", "rejected"]).docs.map((d: any) => d.ref)).toEqual(["MAIN-D2"]);
  });

  test("spec and note have no lifecycle and reject ADR state writes atomically", () => {
    sb = sandbox();
    for (const kind of ["spec", "note"]) {
      const doc = sb.json(["doc", "new", "상태 없는 문서", "--kind", kind]);
      const rev = sb.json(["rev"]).rev;
      const failed = sb.tk(["doc", "status", doc.ref, "accepted"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("only ADR");
      expect(sb.json(["rev"]).rev).toBe(rev);
      const shown = sb.json(["doc", "show", doc.ref, "--history"]);
      expect([shown.status, shown.version, shown.history]).toEqual([null, 1, []]);
    }
  });

  test("only distinct accepted ADRs can supersede and the old decision keeps its own links and history", () => {
    sb = sandbox();
    sb.json(["new", "결정을 사용하는 티켓"]);
    sb.json(["doc", "new", "기존 결정", "--kind", "adr", "--ticket", "1"]);
    sb.json(["doc", "new", "새 결정", "--kind", "adr"]);
    sb.json(["doc", "status", "D1", "accepted"]);
    const before = sb.json(["rev"]).rev;
    const draft = sb.tk(["doc", "supersede", "D1", "--by", "D2"]);
    expect(draft.code).toBe(1);
    expect(draft.stderr).toContain("accepted");
    expect(sb.json(["rev"]).rev).toBe(before);
    sb.json(["doc", "status", "D2", "accepted"]);
    const self = sb.tk(["doc", "supersede", "D1", "--by", "D1"]);
    expect(self.code).toBe(1);
    expect(self.stderr).toContain("itself");
    const old = sb.json(["doc", "supersede", "D1", "--by", "MAIN-D2"]);
    expect([old.status, old.version, old.superseded_by, old.ticket_refs]).toEqual(["superseded", 3, "MAIN-D2", ["MAIN-1"]]);
    const replacement = sb.json(["doc", "show", "D2"]);
    expect([replacement.status, replacement.version]).toEqual(["accepted", 2]);
    expect(sb.json(["doc", "show", "D1", "--history"]).history.map((r: any) => [r.version, r.status, r.superseded_by])).toEqual([
      [1, "proposed", null], [2, "accepted", null],
    ]);
    expect(sb.json(["show", "1"]).docs.map((d: any) => [d.ref, d.status, d.superseded_by])).toEqual([["MAIN-D1", "superseded", "MAIN-D2"]]);
    expect(sb.json(["doc", "ls", "--status", "superseded"]).docs.map((d: any) => d.ref)).toEqual(["MAIN-D1"]);
    expect(sb.tk(["doc", "supersede", "D1", "--by", "D2"]).code).toBe(1);
    expect(sb.tk(["doc", "supersede", "D2", "--by", "D1"]).code).toBe(1);
  });

  test("a missing body flag value cannot erase content, but an explicitly empty body is valid", () => {
    sb = sandbox();
    sb.json(["doc", "new", "지우면 안 되는 메모", "--kind", "note", "--body", "-"], { stdin: "보존할 본문" });
    const rev = sb.json(["rev"]).rev;
    const missing = sb.tk(["doc", "edit", "D1", "--body"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--body");
    expect(sb.json(["rev"]).rev).toBe(rev);
    const preserved = sb.json(["doc", "show", "D1", "--history"]);
    expect([preserved.body, preserved.version, preserved.history]).toEqual(["보존할 본문", 1, []]);
    const cleared = sb.json(["doc", "edit", "D1", "--body", ""]);
    expect([cleared.body, cleared.version]).toEqual(["", 2]);
    expect(sb.json(["doc", "show", "D1", "--history"]).history[0].body).toBe("보존할 본문");
  });

  test("invalid kinds, missing flags and empty titles cannot consume document numbers or revisions", () => {
    sb = sandbox();
    sb.json(["new", "기준 티켓"]);
    const rev = sb.json(["rev"]).rev;
    for (const args of [
      ["doc", "new", "잘못된 종류", "--kind", "memo"],
      ["doc", "new", "종류 누락"],
      ["doc", "new", "", "--kind", "note"],
      ["doc", "new", "본문 값 누락", "--kind", "note", "--body"],
    ]) expect(sb.tk(args).code).toBe(1);
    expect(sb.json(["rev"]).rev).toBe(rev);
    const doc = sb.json(["doc", "new", "유효한 문서", "--kind", "note"]);
    expect(doc.ref).toBe("MAIN-D1");
    const current = sb.json(["rev"]).rev;
    for (const args of [
      ["doc", "edit", "D1", "--title", ""],
      ["doc", "edit", "D1", "--kind", "adr"],
      ["doc", "edit", "D1"],
      ["doc", "edit", "D1", "--title", "--body", "변경되면 안 됨"],
      ["doc", "ls", "--kind", "memo"],
      ["doc", "ls", "--status", "todo"],
      ["doc", "show", "1"],
    ]) expect(sb.tk(args).code).toBe(1);
    expect(sb.json(["rev"]).rev).toBe(current);
    const unchanged = sb.json(["doc", "show", "D1", "--history"]);
    expect([unchanged.kind, unchanged.title, unchanged.body, unchanged.version, unchanged.history]).toEqual(["note", "유효한 문서", "", 1, []]);
  });

  test("foreign or missing ticket links and ADR replacements roll back the entire operation", () => {
    sb = sandbox();
    sb.json(["new", "현재 저장소 티켓"]);
    const other = anotherRepo();
    const foreignTicket = sb.json(["new", "다른 저장소 티켓"], { cwd: other });
    const foreignDoc = sb.json(["doc", "new", "다른 저장소 결정", "--kind", "adr"], { cwd: other });
    sb.json(["doc", "status", foreignDoc.ref, "accepted"], { cwd: other });
    const rev = sb.json(["rev"]).rev;
    for (const ticket of [foreignTicket.ref, "999"]) {
      expect(sb.tk(["doc", "new", "실패할 원자적 생성", "--kind", "adr", "--ticket", ticket]).code).toBe(1);
    }
    expect(sb.json(["rev"]).rev).toBe(rev);
    const own = sb.json(["doc", "new", "현재 저장소 결정", "--kind", "adr", "--ticket", "1"]);
    expect(own.ref).toBe("MAIN-D1");
    sb.json(["doc", "status", "D1", "accepted"]);
    const before = sb.json(["rev"]).rev;
    for (const args of [
      ["doc", "link", "D1", "--ticket", foreignTicket.ref],
      ["doc", "unlink", "D1", "--ticket", foreignTicket.ref],
      ["doc", "link", "D1", "--ticket", "999"],
      ["doc", "ls", "--ticket", foreignTicket.ref],
      ["doc", "supersede", "D1", "--by", foreignDoc.ref],
      ["doc", "supersede", foreignDoc.ref, "--by", "MAIN-D1"],
    ]) expect(sb.tk(args).code).toBe(1);
    expect(sb.json(["rev"]).rev).toBe(before);
    const kept = sb.json(["doc", "show", "D1"]);
    expect([kept.status, kept.version, kept.ticket_refs]).toEqual(["accepted", 2, ["MAIN-1"]]);
    expect(sb.json(["doc", "show", foreignDoc.ref], { cwd: sb.plain }).status).toBe("accepted");
  });

  test("deleting a linked ticket removes only its associations and never deletes or renumbers documents", () => {
    sb = sandbox();
    sb.json(["new", "삭제할 티켓"]);
    sb.json(["new", "남길 티켓"]);
    sb.json(["doc", "new", "남겨야 할 명세", "--kind", "spec", "--ticket", "1", "--body", "-"], { stdin: "연결과 독립인 문서 본문" });
    sb.json(["doc", "link", "D1", "--ticket", "2"]);
    sb.json(["delete", "1", "--yes"]);
    const doc = sb.json(["doc", "show", "D1", "--history"]);
    expect([doc.body, doc.ticket_refs, doc.version, doc.history]).toEqual(["연결과 독립인 문서 본문", ["MAIN-2"], 1, []]);
    expect(sb.json(["show", "2"]).docs.map((d: any) => d.ref)).toEqual(["MAIN-D1"]);
    expect(sb.json(["doc", "new", "다음 문서", "--kind", "note"]).ref).toBe("MAIN-D2");
  });

  test("every document write requires agent identity and updates its terminal without changing ticket state", () => {
    sb = sandbox();
    sb.json(["new", "연결할 티켓"]);
    sb.json(["doc", "new", "기존 결정", "--kind", "adr"]);
    sb.json(["doc", "new", "대체 결정", "--kind", "adr"]);
    sb.json(["doc", "status", "D2", "accepted"]);
    const rev = sb.json(["rev"]).rev;
    for (const args of [
      ["doc", "new", "익명 문서", "--kind", "note"],
      ["doc", "edit", "D1", "--title", "익명 수정"],
      ["doc", "status", "D1", "accepted"],
      ["doc", "supersede", "D1", "--by", "D2"],
      ["doc", "link", "D1", "--ticket", "1"],
      ["doc", "unlink", "D1", "--ticket", "1"],
    ]) {
      const failed = sb.tk(args, { env: { CLAUDECODE: "1", HC_TERMINAL_ID: "anonymous" } });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("--provider and --model");
    }
    expect(sb.json(["rev"]).rev).toBe(rev);
    const author = ["--provider", "openai", "--model", "doc-writer", "--session", "writer-session"];
    const linked = sb.json(["doc", "link", "D1", "--ticket", "1", ...author], { env: { CLAUDECODE: "1", HC_TERMINAL_ID: "t-link" } });
    expect(linked.session.terminal).toBe("t-link");
    const unlinked = sb.json(["doc", "unlink", "D1", "--ticket", "1", ...author], { env: { HC_TERMINAL_ID: "t-unlink" } });
    expect([unlinked.ticket_refs, unlinked.session.terminal, unlinked.version]).toEqual([[], "t-unlink", 1]);
    const accepted = sb.json(["doc", "status", "D1", "accepted", ...author], { env: { HC_TERMINAL_ID: "t-status" } });
    expect([accepted.session.terminal, accepted.revision_author.model]).toEqual(["t-status", "doc-writer"]);
    const replaced = sb.json(["doc", "supersede", "D1", "--by", "D2", ...author], { env: { HC_TERMINAL_ID: "t-replace" } });
    expect([replaced.session.terminal, replaced.revision_author.session_id]).toEqual(["t-replace", "writer-session"]);
    expect(sb.json(["show", "1"]).status).toBe("todo");
    expect(sb.json(["doc", "show", "D1"], { env: { CLAUDECODE: "1" } }).status).toBe("superseded");
  });

  test("repository slug changes preserve document links and replacement references in revisions", () => {
    sb = sandbox();
    sb.json(["new", "연결할 티켓"]);
    sb.json(["doc", "new", "이전 결정", "--kind", "adr", "--ticket", "1"]);
    sb.json(["doc", "new", "새 결정", "--kind", "adr"]);
    sb.json(["doc", "status", "D1", "accepted"]);
    sb.json(["doc", "status", "D2", "accepted"]);
    sb.json(["doc", "supersede", "D1", "--by", "D2"]);
    sb.json(["repo", "slug", "NEWX"]);
    sb.json(["doc", "edit", "newx-d1", "--title", "추가 설명"], { cwd: sb.plain });
    const doc = sb.json(["doc", "show", "d1", "--history"]);
    expect([doc.ref, doc.superseded_by, doc.ticket_refs, doc.history[2].superseded_by]).toEqual(["NEWX-D1", "NEWX-D2", ["NEWX-1"], "NEWX-D2"]);
    expect(sb.json(["show", "1"]).docs[0].ref).toBe("NEWX-D1");
  });

  test("document mutations notify watchers while text, pretty and history reads leave revisions unchanged", () => {
    sb = sandbox();
    sb.json(["new", "문서 연결 티켓"]);
    let before = sb.json(["rev"]).rev;
    for (const args of [
      ["doc", "new", "첫 결정", "--kind", "adr"],
      ["doc", "new", "새 결정", "--kind", "adr"],
      ["doc", "edit", "D1", "--body", "결정 본문"],
      ["doc", "link", "D1", "--ticket", "1"],
      ["doc", "unlink", "D1", "--ticket", "1"],
      ["doc", "status", "D1", "accepted"],
      ["doc", "status", "D2", "accepted"],
      ["doc", "supersede", "D1", "--by", "D2"],
    ]) {
      sb.json(args);
      const after = sb.json(["rev"]).rev;
      expect(after).toBeGreaterThan(before);
      before = after;
    }
    for (const args of [["doc", "show", "MAIN-D1"], ["doc", "show", "D1", "--history"], ["doc", "ls", "--kind", "adr"], ["show", "1"], ["brief"]]) {
      const text = sb.tk(args);
      expect(text.code).toBe(0);
      const pretty = sb.tk([...args, "--pretty"]);
      expect(pretty.code).toBe(0);
      expect(() => JSON.parse(pretty.stdout)).not.toThrow();
    }
    expect(sb.json(["doc", "show", "D1"]).superseded_by).toBe("MAIN-D2");
    expect(sb.tk(["doc", "show", "D1"]).stdout).toContain("MAIN-D2");
    expect(sb.json(["rev"]).rev).toBe(before);
  });
});
