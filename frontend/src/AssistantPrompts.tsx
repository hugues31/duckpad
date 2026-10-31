import type { QuickPrompt } from "./assistantTypes";
import { useT } from "./i18n";

export function useDefaultPrompts(): QuickPrompt[] {
  const t = useT();
  return [
    {
      label: t("assistantOptimizeLabel"),
      prompt: t("assistantOptimizePrompt"),
    },
    { label: t("assistantDebugLabel"), prompt: t("assistantDebugPrompt") },
    { label: t("assistantExplainLabel"), prompt: t("assistantExplainPrompt") },
  ];
}

export function PromptSettings({
  value,
  onChange,
}: {
  value: QuickPrompt[] | null;
  onChange: (value: QuickPrompt[] | null) => void;
}) {
  const t = useT();
  const defaults = useDefaultPrompts();
  const prompts = value ?? defaults;
  const move = (index: number, direction: number) => {
    const next = [...prompts];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange(next);
  };
  return (
    <fieldset className="assistant-provider">
      <legend>{t("assistantQuickPrompts")}</legend>
      <p className="muted">{t("assistantQuickPromptsHint")}</p>
      {prompts.map((prompt, index) => (
        <div className="assistant-prompt-setting" key={index}>
          <label className="field">
            <span>{t("assistantPromptLabel")}</span>
            <input
              required
              maxLength={100}
              value={prompt.label}
              onChange={(e) =>
                onChange(
                  prompts.map((p, i) =>
                    i === index ? { ...p, label: e.target.value } : p,
                  ),
                )
              }
            />
          </label>
          <label className="field">
            <span>{t("assistantPromptText")}</span>
            <textarea
              required
              maxLength={4000}
              rows={3}
              value={prompt.prompt}
              onChange={(e) =>
                onChange(
                  prompts.map((p, i) =>
                    i === index ? { ...p, prompt: e.target.value } : p,
                  ),
                )
              }
            />
          </label>
          <div className="assistant-action-buttons">
            <button
              type="button"
              className="button secondary small"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              {t("assistantMoveUp")}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={index === prompts.length - 1}
              onClick={() => move(index, 1)}
            >
              {t("assistantMoveDown")}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => onChange(prompts.filter((_, i) => i !== index))}
            >
              {t("delete")}
            </button>
          </div>
        </div>
      ))}
      <div className="assistant-action-buttons">
        <button
          type="button"
          className="button secondary small"
          disabled={prompts.length >= 30}
          onClick={() => onChange([...prompts, { label: "", prompt: "" }])}
        >
          {t("assistantAddPrompt")}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={value === null}
          onClick={() => onChange(null)}
        >
          {t("assistantResetPrompts")}
        </button>
      </div>
    </fieldset>
  );
}
