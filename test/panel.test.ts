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
  test("Open contains todo only while In Progress sorts active tickets without overlapping other states", () => {
    expect(selectTickets(tickets, "open", "").groups.map(g => [g.status, g.items.map(t => t.ref)])).toEqual([
      ["todo", ["APP-1"]],
    ]);
    expect(selectTickets(tickets, "in_progress", "").groups.map(g => [g.status, g.items.map(t => t.ref)])).toEqual([
      ["in_progress", ["APP-3", "APP-5"]],
    ]);
    expect(tickets.map(t => t.ref)).toEqual(["APP-5", "APP-1", "APP-3", "APP-2", "APP-4", "APP-6"]);
  });

  test("review and done filters remain separate while counts ignore the current filter", () => {
    const review = selectTickets(tickets, "in_review", "");
    expect(review.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-2"]]);
    const done = selectTickets(tickets, "done", "");
    expect(done.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-4"]]);
    expect(review.counts).toEqual({ open: 1, in_progress: 2, in_review: 1, done: 1 });
    expect(done.counts).toEqual(review.counts);
  });

  test("search matches title or ID case-insensitively inside the selected filter without changing counts", () => {
    const title = selectTickets(tickets, "in_progress", "  SEARCH  ");
    expect(title.groups.map(g => g.items.map(t => t.ref))).toEqual([["APP-3", "APP-5"]]);
    expect(title.counts).toEqual({ open: 1, in_progress: 2, in_review: 1, done: 1 });
    expect(selectTickets(tickets, "open", "app-1").groups[0]?.items.map(t => t.ref)).toEqual(["APP-1"]);
    expect(selectTickets(tickets, "done", "search").groups).toEqual([]);
    expect(selectTickets(tickets, "open", "not present").groups).toEqual([]);
    expect(selectTickets([], "open", "").counts).toEqual({ open: 0, in_progress: 0, in_review: 0, done: 0 });
    expect(selectTickets([], "open", "").groups).toEqual([]);
    expect(selectTickets(tickets, "open", "   ").groups.map(g => g.status)).toEqual(["todo"]);
  });

  test("siblings stay together under their parent without duplicating standalone tickets", () => {
    const rows = [
      { ref: "APP-4", number: 4, title: "둘째 하위 작업", status: "todo", parent_ref: "APP-1" },
      { ref: "APP-2", number: 2, title: "독립 작업", status: "todo", parent_ref: null },
      { ref: "APP-3", number: 3, title: "첫째 하위 작업", status: "todo", parent_ref: "APP-1" },
      { ref: "APP-1", number: 1, title: "부모 작업", status: "todo", parent_ref: null },
    ];
    const selected = selectTickets(rows, "open", "");
    expect(selected.groups[0]!.families.map(f => [f.ref, f.items.map(t => t.ref)])).toEqual([
      ["APP-1", ["APP-1", "APP-3", "APP-4"]],
      ["APP-2", ["APP-2"]],
    ]);
    expect(selected.counts).toEqual({ open: 4, in_progress: 0, in_review: 0, done: 0 });
    expect(rows.map(t => t.ref)).toEqual(["APP-4", "APP-2", "APP-3", "APP-1"]);
  });

  test("a filtered-out parent provides context but cannot enter its child's status list", () => {
    const rows = [
      { ref: "APP-1", number: 1, title: "검토 중인 부모", status: "in_review", parent_ref: null },
      { ref: "APP-2", number: 2, title: "진행 중인 하위 작업", status: "in_progress", parent_ref: "APP-1" },
      { ref: "APP-3", number: 3, title: "끝난 하위 작업", status: "done", parent_ref: "APP-1" },
      { ref: "APP-4", number: 4, title: "대기 중인 하위 작업", status: "todo", parent_ref: "APP-1" },
    ];
    const active = selectTickets(rows, "in_progress", "");
    expect(active.groups[0]!.families[0]!.parent?.title).toBe("검토 중인 부모");
    expect(active.groups[0]!.families[0]!.items.map(t => t.ref)).toEqual(["APP-2"]);
    expect(active.groups.map(g => [g.status, g.families[0]!.ref, g.families[0]!.items.map(t => t.ref)])).toEqual([
      ["in_progress", "APP-1", ["APP-2"]],
    ]);
    expect(selectTickets(rows, "open", "").groups[0]!.families[0]!.items.map(t => t.ref)).toEqual(["APP-4"]);
    const done = selectTickets(rows, "done", "");
    expect(done.groups[0]!.families[0]!.items.map(t => t.ref)).toEqual(["APP-3"]);
    expect(active.counts).toEqual({ open: 1, in_progress: 1, in_review: 1, done: 1 });
    expect(done.counts).toEqual(active.counts);
  });

  test("search keeps only matching family members and missing parents never hide children", () => {
    const rows = [
      { ref: "APP-1", number: 1, title: "부모 작업", status: "todo", parent_ref: null },
      { ref: "APP-2", number: 2, title: "결제 수정", status: "todo", parent_ref: "APP-1" },
      { ref: "APP-3", number: 3, title: "배송 수정", status: "todo", parent_ref: "APP-1" },
      { ref: "APP-5", number: 5, title: "다른 상태의 부모 아래 작업", status: "todo", parent_ref: "APP-4" },
    ];
    const child = selectTickets(rows, "open", "결제");
    expect(child.groups[0]!.families.map(f => [f.ref, f.items.map(t => t.ref)])).toEqual([["APP-1", ["APP-2"]]]);
    expect(selectTickets(rows, "open", "app-1").groups[0]!.families[0]!.items.map(t => t.ref)).toEqual(["APP-1"]);
    const unavailable = selectTickets(rows, "open", "app-5").groups[0]!.families[0]!;
    expect([unavailable.ref, unavailable.parent, unavailable.items.map(t => t.ref)]).toEqual(["APP-4", null, ["APP-5"]]);
    expect(child.counts).toEqual({ open: 4, in_progress: 0, in_review: 0, done: 0 });
  });
});
