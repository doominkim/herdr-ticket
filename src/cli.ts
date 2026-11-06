#!/usr/bin/env bun
// tk — tickets and handoffs per repository (its original main worktree), in one SQLite file.
import { actorName, resolveAuthor } from "./author";
import { openDb, rev } from "./db";
import { addHandoff, listHandoffs } from "./handoffs";
import { repoFor, resolveRef, setSlug, TkError, type Repo } from "./repo";
import { attachSession, createTicket, deleteTicket, editTicket, getTicket, listTickets, OPEN_STATUSES, setStatus, STATUSES, ticketEvents } from "./tickets";
import { listTags } from "./tags";
import { createDoc, docHistory, docsForTicket, editDoc, getDoc, linkDoc, listDocs, resolveDocRef, setDocStatus, supersedeDoc, unlinkDoc } from "./docs";

type Args = { _: string[]; flags: Record<string, string | true>; literalFlags: Set<string> };

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, literalFlags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && a.includes("=")) {
      const equals = a.indexOf("=");
      const key = a.slice(2, equals);
      out.flags[key] = a.slice(equals + 1);
      out.literalFlags.add(key);
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      out.literalFlags.delete(key);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

/** A separated `--body -` reads stdin; equals-form text is always literal. */
async function text(args: Args, key: string): Promise<string> {
  const v = args.flags[key];
  if (v === "-" && !args.literalFlags.has(key)) return await Bun.stdin.text();
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

function priorityFlag(flags: Args["flags"]): string | null | undefined {
  if (flags.priority === undefined) return undefined;
  if (typeof flags.priority !== "string") throw new TkError("--priority needs high, medium, low or an empty value to clear");
  return flags.priority === "" ? null : flags.priority;
}

function optionalTextFlag(flags: Args["flags"], key: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new TkError(`--${key} needs a value`);
  return value;
}

const HELP = `tk — tickets, repository documents and handoffs (shared across a repository's worktrees)

  tk brief                         open tickets of this repo, each with its latest handoff
  tk new <title> [--body -] [--tags bug,fix] [--priority P] [--parent REF]
                                   issue a ticket (todo); empty body gets the Goal / Done when template
  tk ls [--status S] [--terminal T] [--all-repos | --parent REF]
                                   list summaries (--parent: direct children, all statuses unless filtered)
  tk show <ref> [--latest-handoff]  body, parent, children and newest handoff; full history in JSON by default
                                   --latest-handoff: only newest handoff, no events in JSON
  tk status <ref> <status>         todo | in_progress | in_review | done | canceled
  tk edit <ref> [--title T] [--body -] [--tags bug,fix] [--priority P]
  tk tags                          this repo's persistent tag catalog, with stable colors
  tk link <ref> --terminal T       attach a Herdr terminal as the ticket's session
  tk delete <ref> --yes            remove a ticket with its handoffs and history (numbers are not reused)
  tk handoff <ref> --summary S --body -
                                   summary ≤200 chars; body has ## Done, ## In progress, ## Blocked, ## Next in order
  tk doc new <title> --kind spec|adr|note [--body -] [--ticket REF]
                                   create a repository document (ADRs start proposed; spec/note have no status)
  tk doc ls [--kind K] [--status S] [--ticket REF]
  tk doc show <doc-ref> [--history] current content; --history adds previous version snapshots
  tk doc edit <doc-ref> [--title T] [--body -]
  tk doc status <doc-ref> proposed|accepted|rejected
                                   ADRs only; decided ADRs cannot return to proposed or change decision
  tk doc supersede <old> --by <new> both must be distinct accepted ADRs in the same repository
  tk doc link <doc-ref> --ticket REF
  tk doc unlink <doc-ref> --ticket REF
                                   many-to-many links within a repository; deleting tickets preserves documents
  tk repo [slug NEW]               this repo's slug (2-10 uppercase letters/digits)
  tk rev                           change counter (for watchers)

  <ref>       MAIN-12, or 12 for this repo
  <doc-ref>   MAIN-D1, or D1 for this repo; independent of ticket numbering
              show/brief include linked document summaries; read full content with tk doc show
              edits and ADR decisions keep version history; creation author/origin stay unchanged
  --body -    read the text from standard input
  --key=value pass literal text, including -- or a single -; --body= clears an edited body
  --tags      replace tags: comma-separated, 0-8 unique names of 1-32 ASCII letters/digits/hyphens; "" clears
  --priority  high | medium | low; empty value clears to null, omission preserves the current value
  --parent    a root ticket in this repo; children have independent states and cannot have children
              parents with any children cannot be deleted; --all-repos and --parent cannot combine
  Agents add --provider P --model M [--session S] to every write; inside an agent it is required.
  Inside a Herdr terminal ($HC_TERMINAL_ID) every write attaches that terminal to the ticket or document.
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
    case "doc": {
      const [action, ...values] = rest;
      for (const key of ["title", "body"]) {
        if (args.flags[key] !== undefined && typeof args.flags[key] !== "string") throw new TkError(`--${key} needs a value (use "" to clear the body)`);
      }
      if (action === "new") {
        const author = resolveAuthor(args.flags, process.env);
        if (typeof args.flags.kind !== "string") throw new TkError("usage: tk doc new <title> --kind <spec|adr|note> [--body -]");
        const input = { title: values.join(" ").trim(), kind: args.flags.kind, body: await text(args, "body"), ticketRef: optionalTextFlag(args.flags, "ticket") };
        const d = db.transaction(() => createDoc(db, repo(), input, { author, cwd, terminal: here })).immediate();
        print(d, `${d.ref}  [${d.kind}${d.status ? ` · ${d.status}` : ""}]  ${d.title}`);
        return 0;
      }
      if (action === "ls") {
        const filter = { kind: optionalTextFlag(args.flags, "kind"), status: optionalTextFlag(args.flags, "status"), ticketRef: optionalTextFlag(args.flags, "ticket") };
        const { r, docs } = db.transaction(() => {
          const r = repo();
          return { r, docs: listDocs(db, r, filter, cwd) };
        }).immediate();
        print({ repo: r, docs }, docs.map(d => `${d.ref}  [${d.kind}${d.status ? ` · ${d.status}` : ""}]  ${d.title}`).join("\n"));
        return 0;
      }
      if (action === "show") {
        if (!values[0]) throw new TkError("usage: tk doc show <ref>");
        const { d, history } = db.transaction(() => {
          const { repo: r, number } = resolveDocRef(db, values[0]!, cwd);
          return { d: getDoc(db, r, number), history: args.flags.history === true ? docHistory(db, r, number) : undefined };
        }).deferred();
        const lines = [`${d.ref}  [${d.kind}${d.status ? ` · ${d.status}` : ""}]  ${d.title}`, `Version: ${d.version}`, `Author: ${actorName(d.revision_author)}`];
        if (d.created_worktree) lines.push(`Created in: ${d.created_branch ?? "(detached HEAD)"} · ${d.created_worktree}`);
        if (d.ticket_refs.length) lines.push(`Tickets: ${d.ticket_refs.join(", ")}`);
        if (d.superseded_by) lines.push(`Superseded by: ${d.superseded_by}`);
        lines.push("", d.body.trimEnd());
        if (history?.length) {
          lines.push("", "--- history ---");
          for (const version of history) lines.push("", `Version ${version.version} · ${version.title}${version.status ? ` [${version.status}]` : ""}`,
            `${actorName(version.author)} · ${new Date(version.created_at).toISOString()}`, "", version.body.trimEnd());
        }
        print({ ...d, ...(history !== undefined ? { history } : {}) }, lines.join("\n"));
        return 0;
      }
      if (action === "link" || action === "unlink") {
        const author = resolveAuthor(args.flags, process.env), ticket = optionalTextFlag(args.flags, "ticket");
        if (!values[0] || !ticket) throw new TkError(`usage: tk doc ${action} <ref> --ticket <ticket>`);
        const d = db.transaction(() => {
          const { repo: r, number } = resolveDocRef(db, values[0]!, cwd);
          return (action === "link" ? linkDoc : unlinkDoc)(db, r, number, ticket, { author, cwd, terminal: here });
        }).immediate();
        print(d, `${d.ref}  ${action === "link" ? "linked to" : "unlinked from"} ${ticket}`);
        return 0;
      }
      if (action === "edit") {
        const author = resolveAuthor(args.flags, process.env);
        if (!values[0]) throw new TkError("usage: tk doc edit <ref> [--title T] [--body -]");
        if (args.flags.kind !== undefined) throw new TkError("document kind cannot be edited");
        const change = {
          ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
          ...(args.flags.body !== undefined ? { body: await text(args, "body") } : {}),
        };
        const d = db.transaction(() => {
          const { repo: r, number } = resolveDocRef(db, values[0]!, cwd);
          return editDoc(db, r, number, change, { author, cwd, terminal: here });
        }).immediate();
        print(d, `${d.ref}  updated (version ${d.version})`);
        return 0;
      }
      if (action === "status") {
        const author = resolveAuthor(args.flags, process.env);
        if (!values[0] || !values[1]) throw new TkError("usage: tk doc status <ref> <proposed|accepted|rejected>");
        const d = db.transaction(() => {
          const { repo: r, number } = resolveDocRef(db, values[0]!, cwd);
          return setDocStatus(db, r, number, values[1]!, { author, cwd, terminal: here });
        }).immediate();
        print(d, `${d.ref}  → ${d.status}`);
        return 0;
      }
      if (action === "supersede") {
        const author = resolveAuthor(args.flags, process.env), by = optionalTextFlag(args.flags, "by");
        if (!values[0] || !by) throw new TkError("usage: tk doc supersede <old> --by <new>");
        const d = db.transaction(() => {
          const { repo: r, number } = resolveDocRef(db, values[0]!, cwd);
          return supersedeDoc(db, r, number, by, { author, cwd, terminal: here });
        }).immediate();
        print(d, `${d.ref}  superseded by ${d.superseded_by}`);
        return 0;
      }
      throw new TkError("usage: tk doc <new|ls|show|edit|status|supersede|link|unlink>");
    }
    case "new": {
      const title = rest.join(" ").trim();
      if (!title) throw new TkError("usage: tk new <title> [--body -] [--tags bug,fix] [--priority P] [--parent REF] [--provider P --model M --session S]");
      const author = resolveAuthor(args.flags, process.env);
      const body = await text(args, "body");
      const tags = tagNames(args.flags);
      const parent = parentRef(args.flags);
      const priority = priorityFlag(args.flags);
      const t = db.transaction(() => {
        const r = repo();
        return attach(r, createTicket(db, r, { title, body, author, cwd, tags, priority, parentRef: parent }).number);
      }).immediate();
      print(t, `${t.ref}  ${t.title}${t.priority ? `  [${t.priority}]` : ""}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}`);
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
      const docs = docsForTicket(db, r, number);
      const latest = handoffs[0];
      const text = [`${t.ref}  [${t.status}]  ${t.title}`];
      if (t.tags.length) text.push(`Tags: ${t.tags.join(", ")}`);
      if (t.priority) text.push(`Priority: ${t.priority}`);
      if (t.parent_ref) text.push(`Parent: ${t.parent_ref}`);
      if (children.length) text.push("Children:", ...children.map(child => `  ${child.ref}  [${child.status}]  ${child.title}`));
      if (docs.length) text.push("Documents:", ...docs.map(d => `  ${d.ref}  [${d.kind}${d.status ? ` · ${d.status}` : ""}]  ${d.title}`));
      if (t.created_worktree) text.push(`Created in: ${t.created_branch ?? "(detached HEAD)"} · ${t.created_worktree}`);
      text.push("", t.body.trimEnd());
      if (latest) text.push("", latestOnly ? "--- latest handoff ---" : `--- latest handoff (of ${handoffs.length}) ---`, latest.summary, "", latest.body.trimEnd());
      print({ ...t, children, docs, ...(!latestOnly ? { events: ticketEvents(db, r, number) } : {}), handoffs }, text.join("\n"));
      return 0;
    }
    case "handoff": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk handoff <ref> --summary <text> --body - [--provider P --model M --session S]");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const author = resolveAuthor(args.flags, process.env);
      const summary = typeof args.flags.summary === "string" ? args.flags.summary : "";
      const h = addHandoff(db, r, number, { summary, body: await text(args, "body"), author, cwd });
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
      print({ repo: r, tickets }, tickets.map((t) => `${t.ref}  [${t.status}]  ${t.title}${t.priority ? `  [${t.priority}]` : ""}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}`).join("\n"));
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
        .map((t) => ({ ...t, latest_handoff: listHandoffs(db, r, t.number, true)[0] ?? null, docs: docsForTicket(db, r, t.number) }));
      const lines = tickets.map((t) => {
        const h = t.latest_handoff;
        return `${t.ref}  [${t.status}]  ${t.title}${t.priority ? `  [${t.priority}]` : ""}${t.tags.length ? `  #${t.tags.join(" #")}` : ""}${h ? `\n    └ ${h.summary}` : ""}`
          + t.docs.map(d => `\n    · ${d.ref}  [${d.kind}${d.status ? ` · ${d.status}` : ""}]  ${d.title}`).join("");
      });
      print({ repo: r, tickets }, [`${r.slug}  ${r.root}`, ...lines].join("\n"));
      return 0;
    }
    case "edit": {
      const [ref] = rest;
      if (!ref) throw new TkError("usage: tk edit <ref> [--title T] [--body -] [--tags bug,fix] [--priority P]");
      const { repo: r, number } = resolveRef(db, ref, cwd);
      const actor = actorName(resolveAuthor(args.flags, process.env));
      const change = {
        ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
        ...(args.flags.body !== undefined ? { body: await text(args, "body") } : {}),
        ...(args.flags.tags !== undefined ? { tags: tagNames(args.flags) } : {}),
        ...(args.flags.priority !== undefined ? { priority: priorityFlag(args.flags) } : {}),
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
