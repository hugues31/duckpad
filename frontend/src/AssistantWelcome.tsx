import { Sparkles } from "lucide-react";
import { useT } from "./i18n";

export default function AssistantWelcome({
  options,
  defaultPrompts,
  busy,
  undoing,
  selected,
  submit,
  branchOpen,
}: {
  /** Whether the page has an open branch, the only place the assistant edits. */
  branchOpen: boolean;
  options: import("./assistantTypes").AssistantOptions;
  defaultPrompts: import("./assistantTypes").QuickPrompt[];
  busy: boolean;
  undoing: boolean;
  selected: {
    provider: string;
    kind: import("./assistantTypes").ProviderKind;
    model: string;
  };
  submit: (message?: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <div className="assistant-welcome">
      <span className="assistant-welcome-mark" aria-hidden="true">
        <Sparkles size={24} />
      </span>
      <h3>{t(branchOpen ? "assistantWelcome" : "assistantWelcomeAnywhere")}</h3>
      <p>
        {t(
          branchOpen ? "assistantWelcomeHint" : "assistantWelcomeHintAnywhere",
        )}
      </p>
      <div className="assistant-quick-prompts">
        {(options.quick_prompts ?? defaultPrompts).map((prompt, index) => (
          <button
            key={index}
            type="button"
            className="assistant-chip"
            disabled={busy || undoing || !selected}
            onClick={() => void submit(prompt.prompt)}
          >
            {prompt.label}
          </button>
        ))}
      </div>
      <small>
        {t(options.allow_data ? "assistantDataOn" : "assistantDataOff")}
      </small>
    </div>
  );
}
