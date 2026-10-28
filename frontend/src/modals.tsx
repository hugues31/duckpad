import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "./i18n";
import type { Json } from "./types";
import { useAsyncAction } from "./useAsyncAction";

const CodeEditor = lazy(() => import("./Editor"));

export function ConfirmModal({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const { pending, error, run } = useAsyncAction();
  const submitting = useRef(false);
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
    >
      <div className="modal-content">
        {children}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer>
        <button
          autoFocus
          className="button secondary"
          disabled={pending}
          onClick={onClose}
        >
          {t("cancel")}
        </button>
        <button
          className="button primary"
          disabled={pending}
          onClick={async () => {
            if (submitting.current) return;
            submitting.current = true;
            if (await run(onConfirm)) onClose();
            submitting.current = false;
          }}
        >
          {pending ? t("loading") : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

/** The visible dialog opened last, which receives keyboard dismissal and focus cycling. */
export function topDialog() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((dialog) => dialog.getClientRects().length > 0)
    .at(-1);
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const t = useT();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && topDialog() === dialog.current) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function EditorModal({
  title,
  description,
  value,
  language = "sql",
  onSave,
  onClose,
  readOnly = false,
}: {
  title: string;
  description?: string;
  value: string;
  language?: string;
  onSave?: (v: string) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const { pending, error, run } = useAsyncAction();
  return (
    <Modal title={title} onClose={onClose} wide>
      {description && <p className="modal-description">{description}</p>}
      <Suspense fallback={<p>{t("loading")}</p>}>
        <CodeEditor
          value={text}
          onChange={setText}
          language={language}
          readOnly={readOnly}
          height="460px"
        />
      </Suspense>
      {error && <div className="notice error">{error}</div>}
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("close")}
        </button>
        {onSave && !readOnly && (
          <button
            className="button primary"
            disabled={pending}
            onClick={async () => {
              if (await run(() => onSave(text))) onClose();
            }}
          >
            {t(pending ? "saving" : "save")}
          </button>
        )}
      </footer>
    </Modal>
  );
}

export interface FormField {
  key: string;
  label: string;
  value?: string;
  multiline?: boolean;
  required?: boolean;
}

export function FormModal({
  title,
  fields,
  onSubmit,
  onClose,
  description,
}: {
  title: string;
  fields: FormField[];
  onSubmit: (values: Json) => Promise<void>;
  onClose: () => void;
  description?: string;
}) {
  const t = useT();
  const [values, setValues] = useState<Json>(
    Object.fromEntries(fields.map((f) => [f.key, f.value || ""])),
  );
  const { pending, error, run } = useAsyncAction();
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => onSubmit(values))) onClose();
        }}
      >
        <div className="modal-content">
          {description && <p className="muted">{description}</p>}
          {fields.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea
                  rows={5}
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              ) : (
                <input
                  autoFocus={f === fields[0]}
                  required={f.required !== false}
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          {error && <div className="notice error">{error}</div>}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending}>
            {t(pending ? "saving" : "create")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
