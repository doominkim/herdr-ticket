#!/usr/bin/env bun
// tk — tickets and handoffs per repository (its original main worktree), in one SQLite file.
import { actorName, resolveAuthor } from "./author";
import { openDb, rev } from "./db";
import { addHandoff, listHandoffs } from "./handoffs";
import { repoFor, resolveRef, setSlug, TkError, type Repo } from "./repo";
import { attachSession, createTicket, deleteTicket, editTicket, getTicket, listTickets, OPEN_STATUSES, setStatus, STATUSES, ticketEvents } from "./tickets";
import { listTags } from "./tags";

type Args = { _: string[]; flags: Record<string, string | true> };

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--tags=")) {
      out.flags.tags = a.slice("--tags=".length);
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

/** A text flag; `-` reads standard input. */
async function text(flags: Args["flags"], key: string): Promise<string> {
  const v = flags[key];
  if (v === "-") return await Bun.stdin.text();
  return typeof v === "string" ? v : "";
}

function tagNames(flags: Args["flags"]): string[] | undefined {
  const value = flags.tags;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TkError("--tags needs a comma-separated value (use an empty string to clear)");
  return value.trim() ? value.split(",") : [];
}

function parentRef(flags: Args["flags"]): string | undefined {
  const value = flags.parent;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new TkError("--parent needs a ticket reference");
  return value;
}

const HELP = `tk — tickets and handoffs per repository (its original main worktree, from any worktree)

  tk brief                         open tickets of this repo, each with its latest handoff
  tk new <title> [--body -] [--tags bug,fix] [--parent REF]
                                   issue a ticket (todo); empty body gets the Goal / Done when template
  tk ls [--status S] [--terminal T] [--all-repos | --parent REF]
                                   list summaries (--parent: direct children, all statuses unless filtered)
  tk show <ref> [--latest-handoff]  body, parent, children and newest handoff; full history in JSON by default
                                   --latest-handoff: only newest handoff, no events in JSON
  tk status <ref> <status>         todo | in_progress | in_review | done | canceled
  tk edit <ref> [--title T] [--body -] [--tags bug,fix]
  tk tags                          this repo's persistent tag catalog, with stable colors
  tk link <ref> --terminal T       attach a Herdr terminal as the ticket's session
  tk delete <ref> --yes            remove a ticket with its handoffs and history (numbers are not reused)
  tk handoff <ref> --summary S --body -
                                   summary ≤200 chars; body has ## Done, ## In progress, ## Blocked, ## Next in order
  tk repo [slug NEW]               this repo's slug (2-10 uppercase letters/digits)
  tk rev                           change counter (for watchers)

  <ref>       MAIN-12, or 12 for this repo
  --body -    read the text from standard input
  --tags      replace tags: comma-separated, 0-8 unique names of 1-32 ASCII letters/digits/hyphens; "" clears
  --parent    a root ticket in this repo; children have independent states and cannot have children
              parents with any children cannot be deleted; --all-repos and --parent cannot combine
  Agents add --provider P --model M [--session S] to every write; inside an agent it is required.
  Inside a Herdr terminal ($HC_TERMINAL_ID) every write attaches that terminal as the ticket's session.
  --json      compact JSON output        --pretty    indented JSON (implies --json)
  --cwd DIR   act as if run in DIR
  Database: $HERDR_TICKET_DB or ~/.local/share/herdr-ticket/tickets.db`;

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const [cmd, ...rest] = args._;
  if (!cmd || cmd === "help" || args.flags.help === true) {
    console.log(HELP);
    return 0;
  }
  const pretty = args.flags.pretty === true;
  const asJson = args.flags.json === true || pretty;
  const cwd = typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd();
  const print = (data: unknown, out: string) => console.log(asJson ? JSON.stringify(data, null, pretty ? 2 : undefined) : out);
  const db = openDb();
  const repo = () => repoFor(db, cwd);
  // Inside a Herdr terminal, whatever this write touches gets that terminal as its session.
  const here = process.env.HC_TERMINAL_ID || null;
  const attach = (r: Repo, number: number) => (here ? attachSession(db, r, number, here) : getTicket(db, r, number)!);

  switch (cmd) {
    case "new": {
      const title = rest.join(" ").trim();
      if (!title) throw new TkError("usage: tk new <title> [--body -] [--tags bug,fix] [--parent REF] [--provider P --model M --session S]");
      const author = resolveAuthor(args.flags, process.env);
      const body = await text(args.flags, "body");
      const tags = tagNames(args.flags);
      const parent = parentRef(args.flags);
      const t = db.transaction(() => {
        const r = repo();
        return attach(r, createTicket(db, r, { title, body, author, cwd, tags, parentRef: parent }).number);
      }).immediate();
      print(t, `${t.ref}  ${t.title}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}`);
      return 0;
    }
    case "status": {
      const [ref, status] = rest;
      if (!ref || !status) throw new TkError(`usage: tk status <ref> <${STATUSES.join("|")}>`);
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const actor = actorName(resolveAuthor(args.flags, process.env));
      setStatus(db, r, number, status, actor);
      const t = attach(r, number);
      print(t, `${t.ref}  → ${t.status}`);
      return 0;
    }
    case "show": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk show <ref> [--latest-handoff]");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const t = getTicket(db, r, number);
      if (!t) throw new TkError(`no such ticket: ${ref}`);
      const latestOnly = args.flags["latest-handoff"] === true;
      const handoffs = listHandoffs(db, r, number, latestOnly);
      const children = listTickets(db, r, undefined, undefined, true, number);
      const latest = handoffs[0];
      const text = [`${t.ref}  [${t.status}]  ${t.title}`];
      if (t.tags.length) text.push(`Tags: ${t.tags.join(", ")}`);
      if (t.parent_ref) text.push(`Parent: ${t.parent_ref}`);
      if (children.length) text.push("Children:", ...children.map(child => `  ${child.ref}  [${child.status}]  ${child.title}`));
      if (t.created_worktree) text.push(`Created in: ${t.created_branch ?? "(detached HEAD)"} · ${t.created_worktree}`);
      text.push("", t.body.trimEnd());
      if (latest) text.push("", latestOnly ? "--- latest handoff ---" : `--- latest handoff (of ${handoffs.length}) ---`, latest.summary, "", latest.body.trimEnd());
      print({ ...t, children, ...(!latestOnly ? { events: ticketEvents(db, r, number) } : {}), handoffs }, text.join("\n"));
      return 0;
    }
    case "handoff": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk handoff <ref> --summary <text> --body - [--provider P --model M --session S]");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const author = resolveAuthor(args.flags, process.env);
      const summary = typeof args.flags.summary === "string" ? args.flags.summary : "";
      const h = addHandoff(db, r, number, { summary, body: await text(args.flags, "body"), author, cwd });
      attach(r, number);
      print(h, `${r.slug}-${number}  handoff recorded: ${h.summary}`);
      return 0;
    }
    case "ls": {
      const all = args.flags["all-repos"] === true;
      if (all && args.flags.parent !== undefined) throw new TkError("--all-repos cannot be combined with --parent");
      const parent = parentRef(args.flags);
      const scope = () => {
        const r = all ? null : repo();
        if (parent === undefined) return { r, parentNumber: undefined };
        const resolved = resolveRef(db, parent, cwd);
        if (r?.id !== resolved.repo.id) throw new TkError("parent must belong to the current repository");
        if (!getTicket(db, resolved.repo, resolved.number)) throw new TkError(`no such ticket: ${parent}`);
        return { r, parentNumber: resolved.number };
      };
      const { r, parentNumber } = parent === undefined ? scope() : db.transaction(scope).immediate();
      const status = typeof args.flags.status === "string" ? args.flags.status : undefined;
      const terminal = typeof args.flags.terminal === "string" ? args.flags.terminal : undefined;
      const tickets = listTickets(db, r, status, terminal, true, parentNumber);
      print({ repo: r, tickets }, tickets.map((t) => `${t.ref}  [${t.status}]  ${t.title}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}`).join("\n"));
      return 0;
    }
    case "tags": {
      const r = repo();
      const tags = listTags(db, r);
      print({ repo: r, tags }, tags.map(tag => `${tag.name}  ${tag.color}`).join("\n"));
      return 0;
    }
    case "brief": {
      // What an agent reads first: the open tickets, each with its latest handoff.
      const r = repo();
      const tickets = listTickets(db, r)
        .filter((t) => OPEN_STATUSES.includes(t.status))
        .map((t) => ({ ...t, latest_handoff: listHandoffs(db, r, t.number, true)[0] ?? null }));
      const lines = tickets.map((t) => {
        const h = t.latest_handoff;
        return `${t.ref}  [${t.status}]  ${t.title}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}${h ? `\n    └ ${h.summary}` : ""}`;
      });
      print({ repo: r, tickets }, [`${r.slug}  ${r.root}`, ...lines].join("\n"));
      return 0;
    }
    case "edit": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk edit <ref> [--title T] [--body -] [--tags bug,fix]");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const actor = actorName(resolveAuthor(args.flags, process.env));
      const change = {
        ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
        ...(args.flags.body !== undefined ? { body: await text(args.flags, "body") } : {}),
        ...(args.flags.tags !== undefined ? { tags: tagNames(args.flags) } : {}),
      };
      editTicket(db, r, number, change, actor);
      const t = attach(r, number);
      print(t, `${t.ref}  updated`);
      return 0;
    }
    case "link": {
      const [ref] = rest;
      const terminal = typeof args.flags.terminal === "string" ? args.flags.terminal : "";
      if (!ref || !terminal) throw new TkError("usage: tk link <ref> --terminal <address>");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const t = attachSession(db, r, number, terminal);
      print(t, `${t.ref}  session ${terminal}`);
      return 0;
    }
    case "delete": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk delete <ref> --yes");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const t = getTicket(db, r, number);
      if (!t) throw new TkError(`no such ticket: ${ref}`);
      if (args.flags.yes !== true) {
        const n = listHandoffs(db, r, number).length;
        throw new TkError(`this removes ${t.ref} "${t.title}" with ${n} handoff(s) and its history; pass --yes to delete`);
      }
      deleteTicket(db, r, number);
      print({ deleted: t.ref }, `${t.ref}  deleted`);
      return 0;
    }
    case "rev": {
      const v = rev(db);
      print({ rev: v }, String(v));
      return 0;
    }
    case "repo": {
      const [sub, value] = rest;
      const r = repo();
      if (sub === "slug" && value) {
        const updated = setSlug(db, r, value);
        print(updated, `${updated.slug}  ${updated.root}`);
        return 0;
      }
      if (!sub) {
        print(r, `${r.slug}  ${r.root}`);
        return 0;
      }
      throw new TkError("usage: tk repo [slug <NEW>]");
    }
    default:
      throw new TkError(`unknown command: ${cmd ?? "(none)"}`);
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof TkError) {
    console.error(`tk: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
