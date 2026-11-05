import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

export type Run = { code: number; stdout: string; stderr: string };

/** A sandbox: its own database and a git repo `main` with a linked worktree `main.feat`. */
export function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tk-test-")));
  const db = join(dir, "tickets.db");
  const main = join(dir, "main");
  const feat = join(dir, "main.feat");
  const plain = join(dir, "plain");
  const sh = (cmd: string[], cwd = dir) => {
    const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  };
  sh(["mkdir", "-p", main, plain]);
  sh(["git", "init", "-q", "-b", "main"], main);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], main);
  sh(["git", "worktree", "add", "-q", "-b", "feat", feat], main);

  // These tests may themselves run inside an agent: start from an environment without agent markers.
  const { CLAUDECODE: _c, CODEX_SANDBOX: _x, HC_TERMINAL_ID: _t, ...baseEnv } = process.env;
  type Opts = { cwd?: string; stdin?: string; env?: Record<string, string> };
  const tk = (args: string[], opts: Opts = {}): Run => {
    const r = Bun.spawnSync(["bun", CLI, ...args], {
      cwd: opts.cwd ?? main,
      env: { ...baseEnv, HERDR_TICKET_DB: db, ...opts.env },
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const json = (args: string[], opts: Opts = {}) => {
    const r = tk([...args, "--json"], opts);
    if (r.code !== 0) throw new Error(`tk ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return { dir, db, main, feat, plain, tk, json, env: baseEnv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
