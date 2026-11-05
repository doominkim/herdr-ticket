import { expect, test } from "bun:test";
import { TagSelection } from "../mods/herdr-ticket/tag-picker.js";

test("tag draft selects normalized names once, allows eight and rejects a ninth without losing selection", () => {
  const draft = new TagSelection(["bug"]);
  expect(draft.add(" BUG ")).toBe(false);
  expect(draft.names()).toEqual(["bug"]);
  for (const name of ["fix", "feat", "docs", "ui", "native", "test", "cli"]) expect(draft.add(name)).toBe(true);
  expect(draft.names()).toEqual(["bug", "fix", "feat", "docs", "ui", "native", "test", "cli"]);
  expect(draft.add("ninth")).toBe(false);
  expect(draft.names()).toEqual(["bug", "fix", "feat", "docs", "ui", "native", "test", "cli"]);
  draft.remove("bug");
  expect(draft.add(" NINTH ")).toBe(true);
  expect(draft.names()).toEqual(["fix", "feat", "docs", "ui", "native", "test", "cli", "ninth"]);
});

test("draft creation accepts only normalized ASCII tag names of 1–32 characters and removal can clear every tag", () => {
  const draft = new TagSelection([]);
  expect(draft.add("")).toBe(false);
  expect(draft.add("two words")).toBe(false);
  expect(draft.add("한글")).toBe(false);
  expect(draft.add("a".repeat(33))).toBe(false);
  expect(draft.names()).toEqual([]);
  expect(draft.add("a".repeat(32))).toBe(true);
  expect(draft.add("--fix")).toBe(true);
  for (const name of draft.names()) draft.remove(name);
  expect(draft.names()).toEqual([]);
});

test("catalog refresh keeps selected drafts, searches selected names and offers only valid unknown creates", () => {
  const draft = new TagSelection(["bug"]);
  draft.setCatalog([{ name: "bug", color: "blue" }, { name: "fix", color: "green" }]);
  expect(draft.options("BUG")).toEqual([{ name: "bug", color: "blue" }]);
  expect(draft.createName(" BUG ")).toBe(null);
  expect(draft.createName(" New-Tag ")).toBe("new-tag");
  expect(draft.createName("bad name")).toBe(null);
  draft.add("new-tag");
  draft.setCatalog([{ name: "fix", color: "green" }]);
  expect(draft.names()).toEqual(["bug", "new-tag"]);
  expect(draft.options("new")).toEqual([{ name: "new-tag", color: null }]);
  expect(draft.createName("new-tag")).toBe(null);
});

test("new drafts preview the next available colors without changing registered colors", () => {
  const draft = new TagSelection([]);
  draft.setCatalog([{ name: "bug", color: "blue" }, { name: "fix", color: "green" }]);
  expect(draft.color("bug")).toBe("blue");
  expect(draft.color("third")).toBe("yellow");
  draft.add("third");
  expect(draft.color("third")).toBe("yellow");
  expect(draft.color("fourth")).toBe("purple");
  draft.add("fourth");
  draft.remove("third");
  expect(draft.color("fourth")).toBe("yellow");
  expect(draft.color("fix")).toBe("green");
  expect(draft.catalog).toEqual([{ name: "bug", color: "blue" }, { name: "fix", color: "green" }]);
  draft.setCatalog([
    { name: "t1", color: "blue" }, { name: "t2", color: "green" },
    { name: "t3", color: "yellow" }, { name: "t4", color: "purple" },
    { name: "t5", color: "pink" }, { name: "t6", color: "red" },
    { name: "t7", color: "orange" }, { name: "t8", color: "cyan" },
    { name: "t9", color: "brown" }, { name: "t10", color: "gray" },
  ]);
  expect(draft.color("fourth")).toBe("blue");
  expect(draft.color("next")).toBe("green");
});

test("Enter targets an exact existing name before an earlier substring match", () => {
  const draft = new TagSelection(["bugfix"]);
  draft.setCatalog([{ name: "bugfix", color: "blue" }, { name: "fix", color: "green" }]);
  expect(draft.target(" FIX ")).toBe("fix");
  expect(draft.names()).toEqual(["bugfix"]);
  expect(draft.target("new-tag")).toBe("new-tag");
  expect(draft.target("not valid")).toBeNull();
});
