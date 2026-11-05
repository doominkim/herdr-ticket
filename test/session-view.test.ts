import { expect, test } from "bun:test";
import { sessionEntry } from "../mods/herdr-ticket/session-data.js";

test("linked session uses the native tab title but only its own pane's current branch", () => {
  const program = { name: "Oh My Pi", key: "pi", agent: true };
  const agent = {
    address: "t2", pane: "p2", tab: "tab1", space_name: "herdr-ticket",
    title: "Old agent title", program, status: "done", pinned: false,
  };
  const snapshot = {
    agents: [agent],
    terminals: [{ address: "t2", state: "live" }],
    spaces: [{ tabs: [{ id: "tab1", name: "Oh My Pi", named: false }] }],
    panes: [
      { pane: "p1", tab: "tab1", terminal: "t1", title: "✦ Native live task", program, branch: "wrong-lead-branch" },
      { pane: "p2", tab: "tab1", terminal: "t2", title: "Different split", program, branch: "feature/linked" },
    ],
  };
  const entry = sessionEntry(snapshot, "t2", "priority");
  expect(entry?.agent.status).toBe("done");
  expect(entry?.name).toBe("herdr-ticket");
  expect(entry?.detail).toBe("Native live task");
  expect(entry?.branch).toBe("feature/linked");

  snapshot.spaces[0]!.tabs[0]!.name = "Explicit tab name";
  snapshot.spaces[0]!.tabs[0]!.named = true;
  expect(sessionEntry(snapshot, "t2", "grouped")?.name).toBe("Explicit tab name");
  snapshot.panes[1]!.branch = "";
  expect(sessionEntry(snapshot, "t2", "priority")?.branch).toBeNull();
  snapshot.panes.splice(1, 1);
  expect(sessionEntry(snapshot, "t2", "priority")?.branch).toBeNull();
});
