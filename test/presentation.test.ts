import { expect, test } from "bun:test";
import { createdAge, isDarkBackground } from "../mods/herdr-ticket/presentation.js";

test("compact creation age changes at the requested minute, hour and day boundaries", () => {
  const now = 2_000_000_000;
  for (const [elapsed, label] of [
    [-1, "<1m"], [0, "<1m"], [59_999, "<1m"],
    [60_000, "1m"], [119_999, "1m"], [120_000, "2m"],
    [3_599_999, "59m"], [3_600_000, "1h"],
    [7_200_000, "2h"], [86_399_999, "23h"],
    [86_400_000, "1d"], [172_800_000, "2d"],
  ] as const) {
    expect(createdAge(now - elapsed, now)).toBe(label);
  }
});

test("priority contrast follows the resolved surface rather than shell appearance", () => {
  expect(isDarkBackground("#17191d")).toBe(true);
  expect(isDarkBackground("#ffffff")).toBe(false);
  expect(isDarkBackground("#00ffff")).toBe(false);
  expect(isDarkBackground("#0000ff")).toBe(true);
});

test("priority contrast switches at brightness 128 across native hex formats", () => {
  expect(isDarkBackground("#7f7f7f")).toBe(true);
  expect(isDarkBackground("#808080")).toBe(false);
  expect(isDarkBackground("#777")).toBe(true);
  expect(isDarkBackground("#888")).toBe(false);
  expect(isDarkBackground("#777f")).toBe(true);
  expect(isDarkBackground("#888f")).toBe(false);
  expect(isDarkBackground("#7f7f7fff")).toBe(true);
  expect(isDarkBackground("#808080ff")).toBe(false);
});
