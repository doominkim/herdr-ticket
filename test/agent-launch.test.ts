import { expect, test } from "bun:test";
import { buildAgentCommand } from "../mods/herdr-ticket/agent-launch.js";

const task = "Continue ticket HERD-10. First read its latest handoff.";

test("each supported CLI receives the selected model as one literal argument", () => {
  expect(buildAgentCommand(["claude"], " opus ", task)).toEqual(["claude", "--model=opus", task]);
  expect(buildAgentCommand(["codex"], "gpt-custom", task)).toEqual(["codex", "--model=gpt-custom", task]);
  expect(buildAgentCommand(["omp"], "openai-codex/gpt-custom", task)).toEqual(["omp", "--model=openai-codex/gpt-custom", task]);
  expect(buildAgentCommand(["omp"], "--literal", task)).toEqual(["omp", "--model=--literal", task]);
});

test("an empty model preserves the configured launcher default and never mutates its argv", () => {
  const configured = ["/usr/local/bin/claude", "--model=sonnet", "--permission-mode", "default"];
  expect(buildAgentCommand(configured, "  ", task)).toEqual([...configured, task]);
  expect(configured).toEqual(["/usr/local/bin/claude", "--model=sonnet", "--permission-mode", "default"]);
});

test("an explicit model replaces only prior model options and stays before an option terminator", () => {
  expect(buildAgentCommand(["claude", "--model", "old", "--permission-mode", "default"], "new", task))
    .toEqual(["claude", "--permission-mode", "default", "--model=new", task]);
  expect(buildAgentCommand(["codex", "-m", "old", "--sandbox", "workspace-write"], "new", task))
    .toEqual(["codex", "--sandbox", "workspace-write", "--model=new", task]);
  expect(buildAgentCommand(["omp", "--model=old", "--profile=work"], "provider/new", task))
    .toEqual(["omp", "--profile=work", "--model=provider/new", task]);
  expect(buildAgentCommand(["codex", "--"], "new", task)).toEqual(["codex", "--model=new", "--", task]);
});

test("an unsupported executable cannot silently launch Claude or accept model flags", () => {
  expect(() => buildAgentCommand(["other-agent"], "model", task)).toThrow();
  expect(() => buildAgentCommand([], "model", task)).toThrow();
});

test("explicit model replacement preserves operands after the option terminator", () => {
  const configured = ["/opt/bin/codex", "--model=old", "-m", "older", "--sandbox", "workspace-write", "--", "--model=literal", "input"];
  expect(buildAgentCommand(configured, "chosen model", task)).toEqual([
    "/opt/bin/codex", "--sandbox", "workspace-write", "--model=chosen model", "--", "--model=literal", "input", task,
  ]);
  expect(configured).toEqual(["/opt/bin/codex", "--model=old", "-m", "older", "--sandbox", "workspace-write", "--", "--model=literal", "input"]);
});

test("other CLI short flags are preserved and blank models retain the terminator", () => {
  expect(buildAgentCommand(["omp", "-m", "configured", "--"], "selected", task))
    .toEqual(["omp", "-m", "configured", "--model=selected", "--", task]);
  expect(buildAgentCommand(["codex", "-m", "configured", "--"], "", task))
    .toEqual(["codex", "-m", "configured", "--", task]);
});

test("wrapper executables and empty commands are rejected even without an override", () => {
  expect(() => buildAgentCommand(["env", "claude"], "", task)).toThrow();
  expect(() => buildAgentCommand([""], "", task)).toThrow();
  expect(() => buildAgentCommand([], "", task)).toThrow();
});
