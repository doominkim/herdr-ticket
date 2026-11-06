import { expect, test } from "bun:test";
import { planTicketTabNames } from "../mods/herdr-ticket/session-ticket-names.js";

const ticket = (ref: string, status = "in_progress", terminal = "t1") => ({ ref, status, session: { terminal } });
const panes = [{ terminal: "t1", tab: "tab1" }];
const tabs = [{ id: "tab1", name: "원래 세션" }];

test("one tab shows all linked in-progress refs in stable numeric order without including review or ended sessions", () => {
  const result = planTicketTabNames([
    ticket("HERD-9"), ticket("HERD-6"), ticket("HERD-7", "in_review"), ticket("HERD-20", "in_progress", "ended"),
  ], panes, tabs, {});
  expect(result.renames).toEqual([{ id: "tab1", name: "HERD-6, HERD-9 · 원래 세션" }]);
  expect(result.ownership.tab1?.base).toBe("원래 세션");
  expect(result.ownership.tab1?.applied).toBe("HERD-6, HERD-9 · 원래 세션");
});

test("unchanged labels are idempotent and finishing the last ticket restores only the owned original name", () => {
  const first = planTicketTabNames([ticket("HERD-6")], panes, tabs, {});
  const applied = [{ id: "tab1", name: "HERD-6 · 원래 세션" }];
  const repeated = planTicketTabNames([ticket("HERD-6")], panes, applied, first.ownership);
  expect(repeated.renames).toEqual([]);
  const finished = planTicketTabNames([ticket("HERD-6", "done")], panes, applied, repeated.ownership);
  expect(finished.renames).toEqual([{ id: "tab1", name: "원래 세션" }]);
  expect(finished.ownership).toEqual({});
});

test("a manual rename becomes the new base and must never be replaced with an older saved name", () => {
  const first = planTicketTabNames([ticket("HERD-6")], panes, tabs, {});
  const manual = [{ id: "tab1", name: "사용자가 바꾼 이름" }];
  expect(planTicketTabNames([], panes, manual, first.ownership).renames).toEqual([]);
  const relabeled = planTicketTabNames([ticket("HERD-6")], panes, manual, first.ownership);
  expect(relabeled.renames).toEqual([{ id: "tab1", name: "HERD-6 · 사용자가 바꾼 이름" }]);
  expect(relabeled.ownership.tab1?.base).toBe("사용자가 바꾼 이름");
});

test("split panes share one tab label while unrelated tabs and out-of-snapshot terminals are untouched", () => {
  const result = planTicketTabNames([ticket("HERD-6"), ticket("APP-2", "in_progress", "t2"), ticket("REMOTE-1", "in_progress", "remote/t3")],
    [...panes, { terminal: "t2", tab: "tab1" }, { terminal: "remote/t3", tab: "remote/tab3" }],
    [...tabs, { id: "tab2", name: "그대로 둘 탭" }], {});
  expect(result.renames).toEqual([{ id: "tab1", name: "APP-2, HERD-6 · 원래 세션" }]);
});

test("duplicate ticket refs across split panes are shown once and numbers sort naturally", () => {
  const result = planTicketTabNames([
    ticket("HERD-10"), ticket("HERD-2"), ticket("APP-12", "in_progress", "t2"),
    ticket("APP-2"), ticket("HERD-2", "in_progress", "t2"),
  ], [...panes, { terminal: "t2", tab: "tab1" }], tabs, {});
  expect(result.renames).toEqual([{ id: "tab1", name: "APP-2, APP-12, HERD-2, HERD-10 · 원래 세션" }]);
});

test("terminal addresses must match exactly and only in-progress tickets contribute refs", () => {
  const result = planTicketTabNames([
    ticket("HERD-6", "todo"),
    ticket("HERD-7", "done"),
    ticket("HERD-8", "in_progress", "remote/t1"),
    { ref: "HERD-9", status: "in_progress", session: null },
  ], panes, tabs, {});
  expect(result).toEqual({ renames: [], ownership: {} });
});

test("a reduced ticket set replaces only the owned prefix and the final ticket restores the base", () => {
  const first = planTicketTabNames([ticket("HERD-6"), ticket("HERD-9")], panes, tabs, {});
  const reduced = planTicketTabNames([ticket("HERD-9")], panes,
    [{ id: "tab1", name: "HERD-6, HERD-9 · 원래 세션" }], first.ownership);
  expect(reduced.renames).toEqual([{ id: "tab1", name: "HERD-9 · 원래 세션" }]);
  expect(reduced.ownership.tab1?.base).toBe("원래 세션");
  expect(planTicketTabNames([], [], [{ id: "tab1", name: "HERD-9 · 원래 세션" }], reduced.ownership))
    .toEqual({ renames: [{ id: "tab1", name: "원래 세션" }], ownership: {} });
});

test("manual renames after a prefix change are preserved when the final ticket finishes", () => {
  const first = planTicketTabNames([ticket("HERD-6")], panes, tabs, {});
  expect(planTicketTabNames([], panes, [{ id: "tab1", name: "HERD-6 · 직접 정한 이름" }], first.ownership))
    .toEqual({ renames: [], ownership: {} });
});

test("an original ticket-like name is never stripped and repeated snapshots do not accumulate prefixes", () => {
  const original = [{ id: "tab1", name: "HERD-6 · 사용자가 정한 이름" }];
  const first = planTicketTabNames([ticket("HERD-6")], panes, original, {});
  expect(first.renames).toEqual([{ id: "tab1", name: "HERD-6 · HERD-6 · 사용자가 정한 이름" }]);
  const applied = [{ id: "tab1", name: first.renames[0]!.name }];
  const repeated = planTicketTabNames([ticket("HERD-6")], panes, applied, first.ownership);
  expect(repeated.renames).toEqual([]);
  expect(planTicketTabNames([], panes, applied, repeated.ownership).renames).toEqual([
    { id: "tab1", name: "HERD-6 · 사용자가 정한 이름" },
  ]);
});

test("malformed or stale ownership never restores an unrelated original name", () => {
  const current = [{ id: "tab1", name: "현재 이름" }];
  for (const entry of [
    null, {}, { base: 1, applied: "현재 이름" }, { base: "예전 이름", applied: "현재 이름" },
    { base: "현재 이름", applied: "현재 이름" },
    { base: "예전 이름", applied: "HERD-6 · 예전 이름" },
  ]) {
    const previous = { tab1: entry };
    expect(planTicketTabNames([], panes, current, previous)).toEqual({ renames: [], ownership: {} });
    const active = planTicketTabNames([ticket("HERD-6")], panes, current, previous);
    expect(active.renames).toEqual([{ id: "tab1", name: "HERD-6 · 현재 이름" }]);
    expect(active.ownership.tab1?.base).toBe("현재 이름");
  }
  const malformed = [{ id: "tab1", name: "not-a-ticket · 예전 이름" }];
  expect(planTicketTabNames([], panes, malformed, {
    tab1: { base: "예전 이름", applied: "not-a-ticket · 예전 이름" },
  })).toEqual({ renames: [], ownership: {} });
});

test("an empty original name is restored and disappeared tab ownership is removed", () => {
  const first = planTicketTabNames([ticket("HERD-6")], panes, [{ id: "tab1", name: "" }], {});
  expect(first.renames).toEqual([{ id: "tab1", name: "HERD-6 · " }]);
  expect(planTicketTabNames([], panes, [{ id: "tab1", name: "HERD-6 · " }], first.ownership))
    .toEqual({ renames: [{ id: "tab1", name: "" }], ownership: {} });
  expect(planTicketTabNames([ticket("HERD-6")], panes, [], first.ownership))
    .toEqual({ renames: [], ownership: {} });
});

test("inputs remain untouched and ownership survives a JSON round trip", () => {
  const input = [ticket("HERD-6")];
  const previous = { gone: { base: "gone", applied: "HERD-7 · gone" } };
  const before = JSON.stringify({ input, panes, tabs, previous });
  Object.freeze(input[0]!.session);
  Object.freeze(input[0]);
  Object.freeze(input);
  Object.freeze(previous.gone);
  Object.freeze(previous);
  const first = planTicketTabNames(input, panes, tabs, previous);
  expect(JSON.stringify({ input, panes, tabs, previous })).toBe(before);
  expect(first.ownership).toEqual({ tab1: { base: "원래 세션", applied: "HERD-6 · 원래 세션" } });
  expect(planTicketTabNames(input, panes, [{ id: "tab1", name: "HERD-6 · 원래 세션" }],
    JSON.parse(JSON.stringify(first.ownership))).renames).toEqual([]);
});

test("noncanonical ownership and non-record persisted values cannot authorize restoration", () => {
  for (const applied of [
    "HERD-6, HERD-6 · 예전 이름",
    "HERD-9, HERD-6 · 예전 이름",
    "HERD-6 · 다른 이름",
  ]) {
    expect(planTicketTabNames([], panes, [{ id: "tab1", name: applied }], {
      tab1: { base: "예전 이름", applied },
    })).toEqual({ renames: [], ownership: {} });
  }
  for (const previous of [undefined, null, "stale", []]) {
    expect(planTicketTabNames([], panes, tabs, previous)).toEqual({ renames: [], ownership: {} });
  }
});

test("tab identifiers are plain JSON keys even when they match object prototype names", () => {
  const result = planTicketTabNames([ticket("HERD-6")],
    [{ terminal: "t1", tab: "__proto__" }], [{ id: "__proto__", name: "사용자 이름" }], {});
  expect(result.renames).toEqual([{ id: "__proto__", name: "HERD-6 · 사용자 이름" }]);
  const saved = JSON.parse(JSON.stringify(result.ownership));
  expect(Object.hasOwn(saved, "__proto__")).toBe(true);
  expect(planTicketTabNames([], [], [{ id: "__proto__", name: "HERD-6 · 사용자 이름" }], saved))
    .toEqual({ renames: [{ id: "__proto__", name: "사용자 이름" }], ownership: {} });
});
