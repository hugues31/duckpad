import { useEffect, useRef, useState } from "react";
import { FolderPlus, Loader2, Workflow } from "lucide-react";
import { useT } from "./i18n";
import { Modal } from "./modals";
import { useAsyncAction } from "./useAsyncAction";

export default function NewProjectModal({
  createEmpty,
  createExample,
  onClose,
}: {
  createEmpty: (name: string) => Promise<void>;
  createExample: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [template, setTemplate] = useState<"empty" | "example">("empty");
  const [name, setName] = useState("");
  const { pending, error, setError, run } = useAsyncAction();
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = form.current?.closest<HTMLElement>("[role=dialog]");
    dialog?.querySelector<HTMLInputElement>("input:checked")?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked:not(:disabled)',
        ),
      );
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", trapFocus);
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <Modal
      title={t("newProject")}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
    >
      <form
        ref={form}
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || (template === "empty" && !name.trim()))
            return;
          submitting.current = true;
          const created = await run(() =>
            template === "empty" ? createEmpty(name.trim()) : createExample(),
          );
          submitting.current = false;
          if (created) onClose();
        }}
      >
        <div className="modal-content new-project-content">
          <fieldset className="project-templates" disabled={pending}>
            <legend>{t("projectStartingPoint")}</legend>
            {(["empty", "example"] as const).map((value) => {
              const Icon = value === "empty" ? FolderPlus : Workflow;
              return (
                <label className="project-template" key={value}>
                  <input
                    type="radio"
                    name="project-template"
                    value={value}
                    checked={template === value}
                    aria-labelledby={`project-template-${value}`}
                    aria-describedby={`project-template-${value}-description`}
                    onChange={() => {
                      setTemplate(value);
                      setError("");
                    }}
                  />
                  <Icon size={22} aria-hidden="true" />
                  <strong id={`project-template-${value}`}>
                    {t(value === "empty" ? "emptyProject" : "fromExample")}
                  </strong>
                  <span id={`project-template-${value}-description`}>
                    {t(
                      value === "empty"
                        ? "emptyProjectDescription"
                        : "exampleDescription",
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {template === "empty" ? (
            <label className="field">
              <span>{t("name")}</span>
              <input
                required
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          ) : (
            <p className="muted">{t("exampleProjectHint")}</p>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="button secondary"
            disabled={pending}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className="button primary"
            disabled={pending || (template === "empty" && !name.trim())}
          >
            {pending && <Loader2 className="spin" size={16} />}
            {t(pending ? "creatingProject" : "create")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
