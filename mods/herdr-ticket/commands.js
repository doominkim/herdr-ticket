import { exec, home } from "herdr";

const TK = () => `${home()}/.local/bin/tk`;

/** @param {{ attachSession?: boolean }} [options] */
export async function tk(args, cwd, options) {
  const program = TK(), preserveSession = options?.attachSession === false;
  // A content edit in the panel must not claim the linked agent's ticket.
  const argv = preserveSession ? ["-u", "HC_TERMINAL_ID", program, ...args, "--json"] : [...args, "--json"];
  const r = await exec(preserveSession ? "/usr/bin/env" : program, argv, cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "tk failed").trim().replace(/^tk: /, ""));
  return JSON.parse(r.stdout);
}
