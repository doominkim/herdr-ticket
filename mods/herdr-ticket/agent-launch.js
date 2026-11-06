/**
 * Build a supported registered launcher without mutating its configured arguments.
 * @param {string[]} run
 * @param {string} model
 * @param {string} prompt
 * @returns {string[]}
 */
export function buildAgentCommand(run, model, prompt) {
  const command = run[0];
  const family = typeof command === "string" ? command.split("/").pop() : "";
  if (!["claude", "codex", "omp"].includes(family)) {
    throw new Error("Choose a registered Claude Code, Codex, or Oh My Pi executable (claude, codex, or omp).");
  }
  const selected = model.trim();
  if (!selected) return [...run, prompt];
  const argv = [command];
  let index = 1;
  for (; index < run.length && run[index] !== "--"; index++) {
    const arg = run[index];
    if (arg === "--model" || (family === "codex" && arg === "-m")) {
      if (index + 1 < run.length && run[index + 1] !== "--") index++;
    } else if (!arg.startsWith("--model=") && !(family === "codex" && arg.startsWith("-m="))) {
      argv.push(arg);
    }
  }
  return [...argv, `--model=${selected}`, ...run.slice(index), prompt];
}
