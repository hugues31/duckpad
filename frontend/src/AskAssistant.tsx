import { MessageSquare } from "lucide-react";
import { useT } from "./i18n";
import { useShell } from "./shell";

export interface DebugRequest {
  node?: string;
  run?: string;
  environment: string;
  prompt: string;
}
export const DEBUG_ASSISTANT_EVENT = "duckpad:ask-assistant";

export default function AskAssistant({
  node = "",
  run = "",
  environment,
  onOpen,
}: Omit<DebugRequest, "prompt"> & { onOpen?: () => void }) {
  const t = useT();
  const { workspace } = useShell();
  if (!workspace?.assistant?.enabled) return null;
  return (
    <button
      type="button"
      className="button secondary small"
      onClick={() => {
        onOpen?.();
        window.dispatchEvent(
          new CustomEvent<DebugRequest>(DEBUG_ASSISTANT_EVENT, {
            detail: {
              node,
              run,
              environment,
              prompt: t("assistantDebugContext")
                .replace("{run}", run || "—")
                .replace("{node}", node || "—"),
            },
          }),
        );
      }}
    >
      <MessageSquare size={14} />
      {t("assistantAsk")}
    </button>
  );
}
