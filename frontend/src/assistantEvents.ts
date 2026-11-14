import type { AssistantEvent, AssistantTurn } from "./assistantTypes";
/** Apply an event without mutating the previous streamed turn. */
export function applyAssistantEvent(
  turn: AssistantTurn,
  event: AssistantEvent,
): AssistantTurn {
  if (event.type === "text") return { ...turn, text: turn.text + event.text };
  if (event.type === "tool")
    return {
      ...turn,
      tools: [
        ...turn.tools.filter((tool) => tool.id !== event.tool.id),
        event.tool,
      ],
    };
  return event.type === "done" ? event.turn : turn;
}
