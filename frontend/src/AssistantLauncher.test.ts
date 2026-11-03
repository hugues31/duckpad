import { expect, it } from "vitest";
import { chatPlacement } from "./AssistantLauncher";

it("opens the chat above a low bubble, on the bubble's side", () => {
  expect(chatPlacement({ side: "right", bottom: 96 }, 900)).toEqual({
    right: 20,
    top: 124,
    height: 620,
    transformOrigin: "bottom right",
  });
});

it("opens the chat below a high bubble and keeps it inside the viewport", () => {
  expect(chatPlacement({ side: "left", bottom: 600 }, 720)).toEqual({
    left: 20,
    top: 132,
    height: 572,
    transformOrigin: "top left",
  });
});

it("keeps a usable height when the bubble sits mid-height on a short window", () => {
  const placement = chatPlacement({ side: "right", bottom: 276 }, 600);
  expect(placement.height).toBe(360);
  expect(placement.top).toBe(16);
});
