import { expect, test } from "bun:test";
import { planSessionLabels } from "../mods/herdr-ticket/session-label-state.js";

const pane = [{ terminal: "t1", tab: "tab1" }];
const ticket = (ref: string, status = "in_progress") => ({ ref, status, session: { terminal: "t1" } });
const tab = (name: string, named = true) => [{ id: "tab1", name, named }];
const step = (rows: ReturnType<typeof ticket>[], tabs: ReturnType<typeof tab>, state: unknown, now: number, owner = "one") =>
  planSessionLabels(rows, pane, tabs, state, { now, owner });

function active(refs = ["HERD-10", "HERD-11"]) {
  const rows = refs.map(ref => ticket(ref));
  const first = step(rows, tab("원래 이름"), null, 10_000);
  const name = first.renames[0]!.name;
  const observed = step(rows, tab(name), first.state, 12_000);
  return { rows, name, state: observed.state };
}

test("a failed queued restore retains ownership and retries until a native snapshot confirms the original name", () => {
  const a = active();
  const restore = step([], tab(a.name), a.state, 14_000);
  expect(restore.renames).toEqual([{ id: "tab1", name: "원래 이름" }]);
  const unavailable = step([], tab(a.name), restore.state, 16_000);
  expect(unavailable.renames).toEqual([{ id: "tab1", name: "원래 이름" }]);
  const reconnected = step([], tab("원래 이름"), unavailable.state, 18_000);
  expect(reconnected.renames).toEqual([]);
  expect(step([ticket("HERD-12")], tab("원래 이름"), reconnected.state, 20_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-12 · 원래 이름" }]);
});

test("a second runtime cannot turn the old native snapshot into a manual base while a prefix reduction is queued", () => {
  const a = active();
  const rows = [ticket("HERD-11")];
  const first = step(rows, tab(a.name), a.state, 14_000);
  expect(first.renames).toEqual([{ id: "tab1", name: "HERD-11 · 원래 이름" }]);
  const second = step(rows, tab(a.name), first.state, 14_001, "two");
  expect(second.renames).toEqual([]);
  const applied = step(rows, tab("HERD-11 · 원래 이름"), second.state, 16_000);
  expect(applied.renames).toEqual([]);
  expect(step([], tab("HERD-11 · 원래 이름"), applied.state, 18_000).renames)
    .toEqual([{ id: "tab1", name: "원래 이름" }]);
});

test("pending state survives serialization and a replacement writer continues after the bounded lease", () => {
  const a = active(["HERD-10"]);
  const requested = step([], tab(a.name), a.state, 14_000);
  const saved = JSON.parse(JSON.stringify(requested.state));
  expect(step([], tab(a.name), saved, 14_001, "replacement").renames).toEqual([]);
  const resumed = step([], tab(a.name), saved, 21_000, "replacement");
  expect(resumed.renames).toEqual([{ id: "tab1", name: "원래 이름" }]);
  expect(step([], tab("원래 이름"), resumed.state, 23_000, "replacement").renames).toEqual([]);
});

test("an automatic tab restores automatic naming at its current position, not the old number as a manual name", () => {
  const rows = [ticket("HERD-10")];
  const first = step(rows, tab("1", false), null, 10_000);
  expect(first.renames).toEqual([{ id: "tab1", name: "HERD-10 · 1" }]);
  const applied = step(rows, tab("HERD-10 · 1"), first.state, 12_000);
  const restore = step([], tab("HERD-10 · 1"), applied.state, 14_000);
  expect(restore.renames).toEqual([{ id: "tab1", name: "" }]);
  const moved = step([], tab("3", false), restore.state, 16_000);
  expect(moved.renames).toEqual([]);
  expect(step(rows, tab("3", false), moved.state, 18_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-10 · 3" }]);
});

test("a manual rename during a pending update becomes the preserved base even if an older queued target is observed", () => {
  const rows = [ticket("HERD-10")];
  const first = step(rows, tab("원래 이름"), null, 10_000);
  const manual = step(rows, tab("직접 변경"), first.state, 12_000);
  expect(manual.renames).toEqual([{ id: "tab1", name: "HERD-10 · 직접 변경" }]);
  const older = step(rows, tab("HERD-10 · 원래 이름"), manual.state, 14_000);
  expect(older.renames).toEqual([{ id: "tab1", name: "HERD-10 · 직접 변경" }]);
  const observed = step(rows, tab("HERD-10 · 직접 변경"), older.state, 16_000);
  expect(step([], tab("HERD-10 · 직접 변경"), observed.state, 18_000).renames)
    .toEqual([{ id: "tab1", name: "직접 변경" }]);
});

test("closing a tab while a request is pending never renames a different tab", () => {
  const first = step([ticket("HERD-10")], tab("원래 이름"), null, 10_000);
  const closed = planSessionLabels([], [], [{ id: "another", name: "별도 탭", named: true }], first.state,
    { now: 12_000, owner: "one" });
  expect(closed.renames).toEqual([]);
  expect(planSessionLabels([], [], [], closed.state, { now: 14_000, owner: "one" }).renames).toEqual([]);
});

test("a manual name observed during the final restore is protected against that older restore arriving later", () => {
  const a = active(["HERD-10"]);
  const restore = step([], tab(a.name), a.state, 14_000);
  const manual = step([], tab("직접 변경"), restore.state, 16_000);
  expect(manual.renames).toEqual([]);
  const older = step([], tab("원래 이름"), manual.state, 18_000);
  expect(older.renames).toEqual([{ id: "tab1", name: "직접 변경" }]);
  const observed = step([], tab("직접 변경"), older.state, 20_000);
  expect(observed.renames).toEqual([]);
  expect(step([ticket("HERD-12")], tab("직접 변경"), observed.state, 22_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-12 · 직접 변경" }]);
});

test("finishing during the first prefix request cannot leave that old prefix on a manually renamed tab", () => {
  const first = step([ticket("HERD-10")], tab("원래 이름"), null, 10_000);
  const manual = step([], tab("직접 변경"), first.state, 12_000);
  expect(manual.renames).toEqual([]);
  expect(step([], tab("HERD-10 · 원래 이름"), manual.state, 14_000).renames)
    .toEqual([{ id: "tab1", name: "직접 변경" }]);
});

test("a manual switch to automatic naming survives an older queued restore", () => {
  const a = active(["HERD-10"]);
  const restore = step([], tab(a.name), a.state, 14_000);
  const automatic = step([], tab("3", false), restore.state, 16_000);
  expect(automatic.renames).toEqual([]);
  const older = step([], tab("원래 이름"), automatic.state, 18_000);
  expect(older.renames).toEqual([{ id: "tab1", name: "" }]);
  const observed = step([], tab("4", false), older.state, 20_000);
  expect(observed.renames).toEqual([]);
  expect(step([ticket("HERD-12")], tab("4", false), observed.state, 22_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-12 · 4" }]);
});

test("a guarded manual name can acquire new tickets without waiting for an obsolete request to arrive", () => {
  const a = active(["HERD-10"]);
  const restore = step([], tab(a.name), a.state, 14_000);
  const manual = step([], tab("직접 변경"), restore.state, 16_000);
  expect(step([ticket("HERD-12")], tab("직접 변경"), manual.state, 18_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-12 · 직접 변경" }]);
});

test("a manual name survives an older automatic restore even when its displayed tab number changes", () => {
  const rows = [ticket("HERD-10")];
  const first = step(rows, tab("1", false), null, 10_000);
  const prefixed = first.renames[0]!.name;
  const active = step(rows, tab(prefixed), first.state, 12_000);
  const restore = step([], tab(prefixed), active.state, 14_000);
  expect(restore.renames).toEqual([{ id: "tab1", name: "" }]);
  const manual = step([], tab("직접 변경"), restore.state, 16_000);
  expect(manual.renames).toEqual([]);
  const older = step([], tab("3", false), manual.state, 18_000);
  expect(older.renames).toEqual([{ id: "tab1", name: "직접 변경" }]);
  const observed = step([], tab("직접 변경"), older.state, 20_000);
  expect(step([ticket("HERD-12")], tab("직접 변경"), observed.state, 22_000).renames)
    .toEqual([{ id: "tab1", name: "HERD-12 · 직접 변경" }]);
});

test("an explicit numeric restore does not match a newer automatic tab number", () => {
  const rows = [ticket("HERD-10")];
  const first = step(rows, tab("1"), null, 10_000);
  const prefixed = first.renames[0]!.name;
  const active = step(rows, tab(prefixed), first.state, 12_000);
  const restore = step([], tab(prefixed), active.state, 14_000);
  expect(restore.renames).toEqual([{ id: "tab1", name: "1" }]);
  const manual = step([], tab("직접 변경"), restore.state, 16_000);
  const automatic = step([], tab("1", false), manual.state, 18_000);
  expect(automatic.renames).toEqual([]);
  expect(step([], tab("1"), automatic.state, 20_000).renames)
    .toEqual([{ id: "tab1", name: "" }]);
});
