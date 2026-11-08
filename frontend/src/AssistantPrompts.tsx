import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
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

const blank = (prompt: QuickPrompt) =>
  !prompt.label.trim() && !prompt.prompt.trim();

/** One line per prompt; a single prompt at a time opens for editing. */
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
  const [editing, setEditing] = useState<number | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  /** Close the open prompt, unless it is incomplete; an untouched one is dropped. */
  const close = (next: number | null) => {
    const current = editing === null ? undefined : prompts[editing];
    if (editing !== null && current && blank(current)) {
      const rest = prompts.filter((_, i) => i !== editing);
      // Cancelling an addition to the defaults keeps them language-aware.
      onChange(JSON.stringify(rest) === JSON.stringify(defaults) ? null : rest);
      setEditing(next !== null && next > editing ? next - 1 : next);
      return;
    }
    const invalid = editor.current?.querySelector<HTMLInputElement>(":invalid");
    if (invalid) invalid.reportValidity();
    else setEditing(next);
  };
  const move = (index: number, direction: number) => {
    const next = [...prompts];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange(next);
    if (editing === index) setEditing(index + direction);
    else if (editing === index + direction) setEditing(index);
  };
  const remove = (index: number) => {
    onChange(prompts.filter((_, i) => i !== index));
    if (editing === index) setEditing(null);
    else if (editing !== null && editing > index) setEditing(editing - 1);
  };
  const edit = (index: number, values: Partial<QuickPrompt>) =>
    onChange(prompts.map((p, i) => (i === index ? { ...p, ...values } : p)));
  return (
    <div className="assistant-prompts">
      {prompts.length ? (
        <ol className="assistant-prompt-list">
          {prompts.map((prompt, index) => (
            <li className="assistant-prompt-setting" key={index}>
              {editing === index ? (
                <div className="assistant-prompt-editor" ref={editor}>
                  <label className="field">
                    <span>{t("assistantPromptLabel")}</span>
                    <input
                      required
                      autoFocus
                      maxLength={100}
                      value={prompt.label}
                      onChange={(e) => edit(index, { label: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("assistantPromptText")}</span>
                    <textarea
                      required
                      maxLength={4000}
                      rows={3}
                      value={prompt.prompt}
                      onChange={(e) => edit(index, { prompt: e.target.value })}
                    />
                  </label>
                  <div className="assistant-action-buttons">
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => close(null)}
                    >
                      {t("close")}
                    </button>
                    <PromptActions
                      index={index}
                      count={prompts.length}
                      onMove={move}
                      onRemove={remove}
                    />
                  </div>
                </div>
              ) : (
                <div className="assistant-prompt-row">
                  <div className="assistant-prompt-summary">
                    <strong>{prompt.label}</strong>
                    <span className="muted">{prompt.prompt}</span>
                  </div>
                  <button
                    type="button"
                    className="icon"
                    aria-label={t("edit")}
                    data-tooltip={t("edit")}
                    onClick={() => close(index)}
                  >
                    <Pencil size={14} />
                  </button>
                  <PromptActions
                    index={index}
                    count={prompts.length}
                    onMove={move}
                    onRemove={remove}
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t("assistantNoQuickPrompts")}</p>
      )}
      <div className="assistant-action-buttons">
        <button
          type="button"
          className="button secondary small"
          disabled={prompts.length >= 30}
          onClick={() => {
            const invalid =
              editor.current?.querySelector<HTMLInputElement>(":invalid");
            if (invalid) return invalid.reportValidity();
            onChange([...prompts, { label: "", prompt: "" }]);
            setEditing(prompts.length);
          }}
        >
          <Plus size={13} />
          {t("assistantAddPrompt")}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={value === null}
          onClick={() => {
            onChange(null);
            setEditing(null);
          }}
        >
          {t("assistantResetPrompts")}
        </button>
      </div>
    </div>
  );
}

function PromptActions({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  onMove: (index: number, direction: number) => void;
  onRemove: (index: number) => void;
}) {
  const t = useT();
  return (
    <span className="assistant-prompt-actions">
      <button
        type="button"
        className="icon"
        aria-label={t("assistantMoveUp")}
        data-tooltip={t("assistantMoveUp")}
        disabled={index === 0}
        onClick={() => onMove(index, -1)}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className="icon"
        aria-label={t("assistantMoveDown")}
        data-tooltip={t("assistantMoveDown")}
        disabled={index === count - 1}
        onClick={() => onMove(index, 1)}
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        className="icon"
        aria-label={t("delete")}
        data-tooltip={t("delete")}
        onClick={() => onRemove(index)}
      >
        <Trash2 size={14} />
      </button>
    </span>
  );
}
