import { describe, expect, test } from "bun:test";
import { selectTickets } from "../mods/herdr-ticket/list.js";

const tickets = [
  { ref: "APP-5", number: 5, title: "Search Korean product names", status: "in_progress" },
  { ref: "APP-1", number: 1, title: "Set up dark mode", status: "todo" },
  { ref: "APP-3", number: 3, title: "Search the product list", status: "in_progress" },
  { ref: "APP-2", number: 2, title: "Review checkout", status: "in_review" },
  { ref: "APP-4", number: 4, title: "Upgrade Postgres", status: "done" },
  { ref: "APP-6", number: 6, title: "Dropped search approach", status: "canceled" },
];


describe("panel ticket list", () => {
  test("open prioritizes active work, sorts within groups, and excludes review and terminal states", () => {
    expect(selectTickets(tickets, "open", "").groups.map(g => [g.status, g.items.map(t => t.ref)])).toEqual([
      ["in_progress", ["APP-3", "APP-5"]],
      ["todo", ["APP-1"]],
    ]);
    expect(tickets.map(t => t.ref)).toEqual(["APP-5", "APP-1", "APP-3", "APP-2", "APP-4", "APP-6"]);
  });

  test("review and done filters remain separate while counts ignore the current filter", () => {
    const review = selectTickets(tickets, "in_review", "");
    expect(review.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-2"]]);
    const done = selectTickets(tickets, "done", "");
    expect(done.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-4"]]);
    expect(review.counts).toEqual({ open: 3, in_review: 1, done: 1 });
    expect(done.counts).toEqual(review.counts);
  });

  test("search matches title or ID case-insensitively inside the selected filter without changing counts", () => {
    const title = selectTickets(tickets, "open", "  SEARCH  ");
    expect(title.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-3", "APP-5"]]);
    expect(title.counts).toEqual({ open: 3, in_review: 1, done: 1 });
    expect(selectTickets(tickets, "open", "app-1").groups[0]?.items.map(t => t.ref)).toEqual(["APP-1"]);
    expect(selectTickets(tickets, "done", "search").groups).toEqual([]);
    expect(selectTickets(tickets, "open", "not present").groups).toEqual([]);
    expect(selectTickets([], "open", "").counts).toEqual({ open: 0, in_review: 0, done: 0 });
    expect(selectTickets([], "open", "").groups).toEqual([]);
    expect(selectTickets(tickets, "open", "   ").groups.map(g => g.status)).toEqual(["in_progress", "todo"]);
  });
});
