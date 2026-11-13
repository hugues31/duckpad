import { ArrowUp, Square } from "lucide-react";
import { useT } from "./i18n";

export default function AssistantComposer({
  submit,
  busy,
  input,
  draft,
  undoing,
  setDraft,
  selectedKey,
  setModel,
  choices,
  providerName,
  stop,
  awaitingApproval,
  selected,
  worktree,
}: {
  submit: (message?: string) => Promise<void>;
  busy: boolean;
  input: import("react").RefObject<HTMLTextAreaElement | null>;
  draft: string;
  undoing: boolean;
  setDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  selectedKey: string;
  setModel: import("react").Dispatch<import("react").SetStateAction<string>>;
  choices: {
    provider: string;
    kind: import("./assistantTypes").ProviderKind;
    model: string;
  }[];
  providerName: (kind: import("./assistantTypes").ProviderKind) => string;
  stop: () => Promise<void>;
  awaitingApproval: boolean;
  selected: {
    provider: string;
    kind: import("./assistantTypes").ProviderKind;
    model: string;
  };
  worktree: import("./worktree").Worktree;
}) {
  const t = useT();
  return (
    <form
      className="assistant-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={`assistant-input${busy ? " busy" : ""}`}>
        <textarea
          id="assistant-prompt"
          ref={input}
          rows={2}
          maxLength={16000}
          value={draft}
          disabled={undoing}
          aria-label={t("assistantMessage")}
          placeholder={t(
            worktree.id
              ? "assistantMessageHint"
              : "assistantMessageHintAnywhere",
          )}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <footer>
          <select
            aria-label={t("assistantModel")}
            disabled={busy || undoing}
            value={selectedKey}
            onChange={(e) => setModel(e.target.value)}
          >
            {choices.map((m) => (
              <option
                key={`${m.provider}/${m.model}`}
                value={JSON.stringify([m.provider, m.model])}
              >
                {providerName(m.kind)} · {m.model}
              </option>
            ))}
          </select>
          {busy ? (
            <button
              className="assistant-send stop"
              type="button"
              title={t("assistantStop")}
              aria-label={t("assistantStop")}
              onClick={() => void stop()}
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="assistant-send"
              title={t("assistantSend")}
              aria-label={t("assistantSend")}
              disabled={
                awaitingApproval ||
                !draft.trim() ||
                !selected ||
                undoing ||
                (!!worktree.id && !worktree.snapshot)
              }
            >
              <ArrowUp size={17} />
            </button>
          )}
        </footer>
      </div>
    </form>
  );
}
