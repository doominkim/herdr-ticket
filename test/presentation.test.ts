import { expect, test } from "bun:test";
import { createdAge } from "../mods/herdr-ticket/presentation.js";

test("creation age clamps future dates and changes units at minute, hour, and day boundaries", () => {
  const now = 2_000_000_000;
  for (const [elapsed, label] of [
    [-1, "just now"], [0, "just now"], [59_999, "just now"],
    [60_000, "1 minute ago"], [119_999, "1 minute ago"], [120_000, "2 minutes ago"],
    [3_599_999, "59 minutes ago"], [3_600_000, "1 hour ago"],
    [7_200_000, "2 hours ago"], [86_399_999, "23 hours ago"],
    [86_400_000, "1 day ago"], [172_800_000, "2 days ago"],
  ] as const) {
    expect(createdAge(now - elapsed, now)).toBe(label);
  }
});
