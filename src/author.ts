import { TkError } from "./repo";

export type Author = { created_by: "human" | "agent"; provider: string | null; model: string | null; session_id: string | null };

/** Environment markers set by coding agents that run shell commands. */
const AGENT_ENV = ["CLAUDECODE", "CODEX_SANDBOX"];

/**
 * Who is writing. An agent names its provider and model (both, or the record would be pinned on
 * the human); a process inside an agent that names neither is refused for the same reason.
 */
export function resolveAuthor(flags: Record<string, string | true>, env: Record<string, string | undefined>): Author {
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : null);
  const provider = str("provider");
  const model = str("model");
  const session_id = str("session");
  if (provider && model) return { created_by: "agent", provider, model, session_id };
  if (provider || model || AGENT_ENV.some((k) => env[k])) {
    throw new TkError("agents must pass both --provider and --model (and --session when they have one)");
  }
  return { created_by: "human", provider: null, model: null, session_id: null };
}

/** How an author appears in history: `human`, or `provider/model`. */
export function actorName(a: Author): string {
  return a.created_by === "agent" ? `${a.provider}/${a.model}` : "human";
}
