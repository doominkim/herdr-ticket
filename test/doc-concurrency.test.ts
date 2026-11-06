import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Author } from "../src/author";
import type { Doc, DocRevision } from "../src/docs";
import { sandbox } from "./helpers";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function fixture() {
  const sb = sandbox();
  cleanup = sb.cleanup;
  return sb;
}

type SandboxContext = { db: string; main: string; env: Record<string, string | undefined> };
type Job = { args: string[]; cwd?: string; terminal?: string };
type Result = { args: string[]; code: number; stdout: string; stderr: string };
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function diagnostic(result: Result) {
  return `tk ${result.args.join(" ")} exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

// Start independent processes behind a readiness barrier, not sleeps. Every actual CLI process
// inherits only this sandbox's DB. Drain both output streams even for expected failures.
async function concurrent(sb: SandboxContext, jobs: Job[]) {
  const workers = jobs.map(job => {
    const { promise: ready, resolve: signalReady } = Promise.withResolvers<void>();
    const argv = [process.execPath, CLI, ...job.args, "--json"];
    const script = `
      process.send("ready");
      await Bun.stdin.text();
      process.disconnect();
      process.argv = ${JSON.stringify(argv)};
      // Static import would open the DB before the readiness barrier is released.
      await import(${JSON.stringify(CLI)});
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: job.cwd ?? sb.main,
      env: { ...sb.env, HERDR_TICKET_DB: sb.db, ...(job.terminal ? { HC_TERMINAL_ID: job.terminal } : {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      ipc(message) { if (message === "ready") signalReady(); },
      // This deadline reaps hung processes; readiness and ordering never depend on time.
      timeout: 15_000,
    });
    const completed = Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).then(([code, stdout, stderr]) => ({ args: job.args, code, stdout, stderr }));
    return {
      child, completed,
      ready: Promise.race([ready, completed.then(result => { throw new Error(`Worker exited before release: ${diagnostic(result)}`); })]),
    };
  });
  try {
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.stdin.end();
    return await Promise.all(workers.map(worker => worker.completed));
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.all(workers.map(worker => worker.completed));
  }
}

function successful(result: Result): Doc {
  if (result.code !== 0) throw new Error(diagnostic(result));
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Expected document JSON: ${diagnostic(result)}`);
  }
}

function agent(model: string): Author {
  return { created_by: "agent", provider: "openai", model, session_id: `session-${model}` };
}

function authorFlags(model: string) {
  return ["--provider", "openai", "--model", model, "--session", `session-${model}`];
}

describe("concurrent document writes", () => {
  test("fresh opens share worktree counters with no duplicate or consumed document numbers after rejected writes", async () => {
    const sb = fixture();
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      args: ["doc", "new", `Concurrent document ${i}`, "--kind", "note", "--body", `body-${i}`, ...authorFlags(`creator-${i}`)],
      cwd: i % 2 ? sb.feat : sb.main,
      terminal: `terminal-${i}`,
    }));
    const rejected = [
      { args: ["doc", "new", "Missing linked ticket A", "--kind", "spec", "--ticket", "999"], cwd: sb.main },
      { args: ["doc", "new", "Missing linked ticket B", "--kind", "adr", "--ticket", "999"], cwd: sb.feat },
    ];
    const results = await concurrent(sb, [...jobs, ...rejected]);
    const docs = results.slice(0, jobs.length).map(successful);
    for (const result of results.slice(jobs.length)) {
      if (result.code !== 1 || !result.stderr.includes("no such ticket")) throw new Error(diagnostic(result));
    }
    expect(docs.map(doc => doc.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(docs.map(doc => doc.ref)).size).toBe(8);
    for (const [i, doc] of docs.entries()) {
      expect([doc.title, doc.body, doc.revision_author, doc.session?.terminal]).toEqual([
        `Concurrent document ${i}`, `body-${i}`, agent(`creator-${i}`), `terminal-${i}`,
      ]);
      expect([doc.ref, doc.version, doc.created_branch, doc.created_worktree]).toEqual([
        `MAIN-D${doc.number}`, 1, i % 2 ? "feat" : "main", i % 2 ? sb.feat : sb.main,
      ]);
      expect(sb.json(["doc", "show", doc.ref, "--history"]).history).toEqual([]);
    }
    const listed = sb.json(["doc", "ls"], { cwd: sb.feat });
    expect(listed.docs.map((doc: Doc) => doc.ref)).toEqual([
      "MAIN-D1", "MAIN-D2", "MAIN-D3", "MAIN-D4", "MAIN-D5", "MAIN-D6", "MAIN-D7", "MAIN-D8",
    ]);
    expect(sb.json(["doc", "new", "Next document", "--kind", "note"]).ref).toBe("MAIN-D9");
    expect(sb.json(["new", "Ticket counter is independent"]).ref).toBe("MAIN-1");
  }, 30_000);

  test("concurrent edits retain each complete body and matching author exactly once in ordered history", async () => {
    const sb = fixture();
    const initial = sb.json(["doc", "new", "Initial title", "--kind", "note", "--body", "-", ...authorFlags("initial")], {
      cwd: sb.feat, stdin: "initial body\n", env: { HC_TERMINAL_ID: "initial-terminal" },
    });
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      args: ["doc", "edit", "D1", "--title", `Edit title ${i}`, "--body", `edit body ${i}\n`, ...authorFlags(`editor-${i}`)],
      cwd: i % 2 ? sb.feat : sb.main,
      terminal: `editor-terminal-${i}`,
    }));
    const responses = (await concurrent(sb, jobs)).map(successful);
    expect(responses.map(doc => doc.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const current = sb.json(["doc", "show", "D1", "--history"]);
    expect(current.version).toBe(9);
    expect(current.history.map((revision: DocRevision) => revision.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const versions = [
      ...current.history,
      { version: current.version, title: current.title, body: current.body, status: current.status,
        superseded_by: current.superseded_by, author: current.revision_author, created_at: current.updated_at },
    ] as DocRevision[];
    const expected = [
      { title: "Initial title", body: "initial body\n", author: agent("initial") },
      ...jobs.map((_, i) => ({ title: `Edit title ${i}`, body: `edit body ${i}\n`, author: agent(`editor-${i}`) })),
    ];
    expect(versions.map(({ title, body, author }) => ({ title, body, author })).sort((a, b) => a.title.localeCompare(b.title)))
      .toEqual(expected.sort((a, b) => a.title.localeCompare(b.title)));
    const writes = new Map<number, Doc>([[1, initial], ...responses.map(doc => [doc.version, doc] as [number, Doc])]);
    for (const version of versions) {
      const write = writes.get(version.version)!;
      expect([version.title, version.body, version.author, version.created_at, version.status, version.superseded_by]).toEqual([
        write.title, write.body, write.revision_author, write.updated_at, null, null,
      ]);
    }
    const last = responses.find(doc => doc.version === 9)!;
    expect([current.revision_author, current.session]).toEqual([last.revision_author, last.session]);
    expect([current.created_by, current.provider, current.model, current.session_id, current.created_at, current.created_branch, current.created_worktree]).toEqual([
      "agent", "openai", "initial", "session-initial", initial.created_at, "feat", sb.feat,
    ]);
    expect(sb.json(["doc", "show", "D1"])).not.toHaveProperty("history");
  }, 30_000);

  test("racing supersede attempts have one winner and preserve the old ADR history and all replacements", async () => {
    const sb = fixture();
    sb.json(["new", "Linked decision consumer"]);
    const old = sb.json(["doc", "new", "Original decision", "--kind", "adr", "--body", "-", "--ticket", "1", ...authorFlags("old-create")], {
      stdin: "original decision body\n", cwd: sb.feat,
    });
    const accepted = sb.json(["doc", "status", "D1", "accepted", ...authorFlags("old-accept")]);
    const replacements = Array.from({ length: 3 }, (_, i) => {
      const created = sb.json(["doc", "new", `Replacement ${i}`, "--kind", "adr", ...authorFlags(`replacement-${i}`)]);
      sb.json(["doc", "status", created.ref, "accepted", ...authorFlags(`replacement-${i}`)]);
      return sb.json(["doc", "show", created.ref, "--history"]);
    });
    const jobs = replacements.map((replacement, i) => ({
      args: ["doc", "supersede", "MAIN-D1", "--by", replacement.ref, ...authorFlags(`superseder-${i}`)],
      cwd: i % 2 ? sb.feat : sb.main,
      terminal: `superseder-terminal-${i}`,
    }));
    const results = await concurrent(sb, jobs);
    const winners = results.filter(result => result.code === 0);
    if (winners.length !== 1) throw new Error(`Expected exactly one supersede winner:\n${results.map(diagnostic).join("\n")}`);
    for (const result of results.filter(result => result.code !== 0)) {
      if (result.code !== 1 || !result.stderr.includes("accepted")) throw new Error(diagnostic(result));
    }
    const winningIndex = results.indexOf(winners[0]!);
    const winner = successful(winners[0]!);
    const shown = sb.json(["doc", "show", "D1", "--history"]);
    expect([shown.status, shown.version, shown.superseded_by, shown.revision_author, shown.session?.terminal, shown.ticket_refs]).toEqual([
      "superseded", 3, replacements[winningIndex]!.ref, agent(`superseder-${winningIndex}`), `superseder-terminal-${winningIndex}`, ["MAIN-1"],
    ]);
    expect(winner).toEqual(sb.json(["doc", "show", "D1"]));
    expect(shown.history).toEqual([
      { version: 1, title: "Original decision", body: "original decision body\n", status: "proposed", superseded_by: null,
        author: agent("old-create"), created_at: old.created_at },
      { version: 2, title: "Original decision", body: "original decision body\n", status: "accepted", superseded_by: null,
        author: agent("old-accept"), created_at: accepted.updated_at },
    ]);
    expect([shown.body, shown.model, shown.created_at, shown.created_branch, shown.created_worktree]).toEqual([
      "original decision body\n", "old-create", old.created_at, "feat", sb.feat,
    ]);
    for (const replacement of replacements) expect(sb.json(["doc", "show", replacement.ref, "--history"])).toEqual(replacement);
    expect(sb.json(["show", "1"]).docs.map((doc: Doc) => [doc.ref, doc.status, doc.superseded_by])).toEqual([
      ["MAIN-D1", "superseded", replacements[winningIndex]!.ref],
    ]);
    expect(sb.json(["doc", "new", "Next document", "--kind", "note"]).ref).toBe("MAIN-D5");
  }, 30_000);

  for (const mode of ["api", "cli"] as const) {
    test(`${mode} document reads keep body, links and history in one snapshot during a committed edit`, () => {
      const sb = fixture();
      sb.json(["new", "동시 연결할 티켓"]);
      sb.json(["doc", "new", "동시에 읽을 문서", "--kind", "note", "--body", "수정 전"]);
      const preload = join(sb.dir, "interleave-read.ts");
      // Commit real writes after the document row has been read, before subsequent queries.
      // Match the returned data, not SQL text, and fail loudly if the race was not exercised.
      writeFileSync(preload, `
        import { Database } from "bun:sqlite";
        const query = Database.prototype.query;
        let interleaved = false;
        Database.prototype.query = function (...args) {
          const statement = query.apply(this, args);
          const get = statement.get.bind(statement);
          statement.get = (...values) => {
            const row = get(...values);
            if (!interleaved && row?.version === 1 && row?.body === "수정 전") {
              interleaved = true;
              for (const args of [
                ["doc", "edit", "D1", "--body", "수정 후"],
                ["doc", "link", "D1", "--ticket", "1"],
              ]) {
                const writer = Bun.spawnSync([process.execPath, ${JSON.stringify(CLI)}, ...args, "--provider", "openai", "--model", "race-writer"], {
                  cwd: process.cwd(), env: process.env, stdin: "ignore",
                });
                if (writer.exitCode !== 0) throw new Error(writer.stderr.toString());
              }
            }
            return row;
          };
          return statement;
        };
        process.on("exit", () => {
          if (!interleaved) { console.error("Read/write interleaving was not reached"); process.exitCode = 90; }
        });
      `);
      const api = `
        import { Database } from "bun:sqlite";
        import { resolveDocRef, getDoc } from ${JSON.stringify(join(import.meta.dir, "..", "src", "docs.ts"))};
        const db = new Database(process.env.HERDR_TICKET_DB);
        const { repo, number } = resolveDocRef(db, "MAIN-D1", process.cwd());
        console.log(JSON.stringify(getDoc(db, repo, number)));
        db.close();
      `;
      const argv = mode === "api" ? ["--eval", api] : [CLI, "doc", "show", "D1", "--history", "--json"];
      const result = Bun.spawnSync([process.execPath, "--preload", preload, ...argv], {
        cwd: sb.main, env: { ...sb.env, HERDR_TICKET_DB: sb.db }, stdin: "ignore", timeout: 20_000,
      });
      if (result.exitCode !== 0) throw new Error(`Reader failed: ${result.stderr.toString()}`);
      const read = JSON.parse(result.stdout.toString());
      expect([read.version, read.body, read.ticket_refs]).toEqual([1, "수정 전", []]);
      if (mode === "cli") expect(read.history).toEqual([]);
      const committed = sb.json(["doc", "show", "D1", "--history"]);
      expect([committed.version, committed.body, committed.ticket_refs, committed.history[0].body]).toEqual([2, "수정 후", ["MAIN-1"], "수정 전"]);
    }, 30_000);
  }
});
