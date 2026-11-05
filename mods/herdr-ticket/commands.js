import { exec, home } from "herdr";

const TK = () => `${home()}/.local/bin/tk`;

export async function tk(args, cwd) {
  const r = await exec(TK(), [...args, "--json"], cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "tk failed").trim().replace(/^tk: /, ""));
  return JSON.parse(r.stdout);
}
