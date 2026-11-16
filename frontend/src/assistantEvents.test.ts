import { expect, it } from "vitest";
import { applyAssistantEvent } from "./assistantEvents";
import type { AssistantTurn } from "./assistantTypes";

it("applies assistant deltas without changing prior turns and replaces tool updates by identity", () => {
  const turn = {
    text: "Hello",
    tools: [{ id: "tool", status: "running" }],
  } as AssistantTurn;
  const text = applyAssistantEvent(turn, { type: "text", text: " world" });
  expect(text.text).toBe("Hello world");
  expect(turn.text).toBe("Hello");
  const tool = { ...turn.tools[0], status: "success" };
  const updated = applyAssistantEvent(text, { type: "tool", tool });
  expect(updated.tools).toEqual([tool]);
  expect(turn.tools[0].status).toBe("running");
  expect(
    applyAssistantEvent(updated, { type: "start", conversation: "id" }),
  ).toBe(updated);
  expect(applyAssistantEvent(updated, { type: "done", turn })).toBe(turn);
});
