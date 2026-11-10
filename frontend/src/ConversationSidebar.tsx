import type { Conversation } from "./assistantTypes";
import { useT } from "./i18n";

export default function ConversationSidebar({
  conversations,
  busy,
  undoing,
  conversation,
  resume,
  nextOffset,
  list,
  setError,
}: {
  conversations: Conversation[];
  busy: boolean;
  undoing: boolean;
  conversation: Conversation | null;
  resume: (item: Conversation) => Promise<void>;
  nextOffset: number | null;
  list: (offset?: number) => Promise<void>;
  setError: import("react").Dispatch<import("react").SetStateAction<string>>;
}) {
  const t = useT();
  return (
    <aside
      className="assistant-history"
      aria-label={t("assistantConversations")}
    >
      <h3>{t("assistantConversations")}</h3>
      {conversations.length === 0 && (
        <p className="muted">{t("assistantNoConversations")}</p>
      )}
      {conversations.map((item) => (
        <button
          key={item.id}
          disabled={busy || undoing}
          className={item.id === conversation?.id ? "active" : ""}
          onClick={() => void resume(item)}
        >
          <strong>{item.title}</strong>
          <small>{item.branch}</small>
        </button>
      ))}
      {nextOffset !== null && (
        <button
          onClick={() =>
            void list(nextOffset).catch((e: Error) => setError(e.message))
          }
        >
          {t("assistantMore")}
        </button>
      )}
    </aside>
  );
}
