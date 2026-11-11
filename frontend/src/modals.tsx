import { X } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT } from "./i18n";
import { shownDialogs } from "./searchShortcuts";
import { useAsyncAction } from "./useAsyncAction";

const CodeEditor = lazy(() => import("./Editor"));

type FormState = Pick<
  ReturnType<typeof useAsyncAction>,
  "pending" | "error" | "setError"
>;
type FormContent = React.ReactNode | ((state: FormState) => React.ReactNode);

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
  return (
    <ModalForm
      title={title}
      submitLabel={confirmLabel}
      pendingLabel="loading"
      onSubmit={onConfirm}
      onClose={onClose}
      cancelAutoFocus
    >
      {children}
    </ModalForm>
  );
}

/** A native form with one in-flight submission and guarded dismissal. */
export function ModalForm({
  title,
  children,
  onSubmit,
  onClose,
  submitLabel,
  pendingLabel = "saving",
  cancelLabel = "cancel",
  cancelAutoFocus = false,
  disabled = false,
  wide = false,
  className,
  actions,
}: {
  title: string;
  children: FormContent;
  onSubmit: (form: HTMLFormElement) => Promise<unknown>;
  onClose: () => void;
  submitLabel: string;
  pendingLabel?: "saving" | "loading";
  cancelLabel?: "cancel" | "close";
  cancelAutoFocus?: boolean;
  disabled?: boolean;
  wide?: boolean;
  className?: string;
  actions?: FormContent;
}) {
  const t = useT();
  const { pending, error, setError, run } = useAsyncAction();
  const state = { pending, error, setError };
  const submitting = useRef(false);
  const close = () => {
    if (!submitting.current) onClose();
  };
  return (
    <Modal title={title} onClose={close} wide={wide}>
      <form
        className={className}
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || submitting.current) return;
          const form = event.currentTarget;
          submitting.current = true;
          try {
            let submitted = false;
            if (
              (await run(async () => {
                submitted = (await onSubmit(form)) !== false;
              })) &&
              submitted
            )
              onClose();
          } finally {
            submitting.current = false;
          }
        }}
      >
        <div className="modal-content">
          {typeof children === "function" ? children(state) : children}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          {typeof actions === "function" ? actions(state) : actions}
          <button
            type="button"
            autoFocus={cancelAutoFocus}
            className="button secondary"
            disabled={pending}
            onClick={close}
          >
            {t(cancelLabel)}
          </button>
          <button className="button primary" disabled={disabled || pending}>
            {pending ? t(pendingLabel) : submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** The last visible blocking dialog receives keyboard dismissal and focus cycling. */
function topDialog() {
  return shownDialogs('[role="dialog"]:not([aria-modal="false"])').at(-1);
}

const TABBABLE =
  "a[href], button, input, select, textarea, summary, [tabindex]";

/** Controls of a container reached with Tab, in document order. */
function tabbable(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => {
      if (
        element.tabIndex < 0 ||
        element.matches(":disabled") ||
        !element.getClientRects().length
      )
        return false;
      if (
        !(element instanceof HTMLInputElement) ||
        element.type !== "radio" ||
        !element.name
      )
        return true;
      // Tab enters a radio group once, through its checked option or else its first one.
      const group = [
        ...container.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(element.name)}"]`,
        ),
      ];
      return element === (group.find((radio) => radio.checked) ?? group[0]);
    },
  );
}

/** Keep Tab and Shift+Tab cycling through the controls of a modal container. */
export function trapFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  container: HTMLElement,
) {
  if (event.key !== "Tab") return;
  const controls = tabbable(container);
  const active = document.activeElement;
  const outside = active === container || !container.contains(active);
  if (outside || active === (event.shiftKey ? controls[0] : controls.at(-1))) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
}

/**
 * A modal dialog that traps the focus while it is the top dialog, and returns
 * it to its opener when closed. The focus starts on the element marked with
 * `data-autofocus`, a child using `autoFocus`, or else the first control.
 */
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
  // Read while rendering, before a child with autoFocus takes the focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const active = document.activeElement as HTMLElement | null;
    // A dialog replacing another one returns to the control its predecessor restored.
    const returnTo = opener?.isConnected
      ? opener
      : element.contains(active)
        ? null
        : active;
    if (!element.contains(active))
      (
        element.querySelector<HTMLElement>("[data-autofocus]") ??
        tabbable(element)[0]
      )?.focus();
    return () => {
      const current = document.activeElement;
      if (
        returnTo?.isConnected &&
        (current === document.body || element.contains(current))
      )
        returnTo.focus();
    };
  }, [opener]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const element = dialog.current;
      if (!element || topDialog() !== element) return;
      if (event.key === "Escape") onClose();
      else trapFocus(event, element);
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

/** Edit a text in a dialog and save it explicitly; the dialog closes once saved. */
export function EditorModal({
  title,
  value,
  language = "sql",
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  language?: string;
  onSave: (v: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const { pending, error, run } = useAsyncAction();
  return (
    <Modal title={title} onClose={onClose} wide>
      <Suspense fallback={<p>{t("loading")}</p>}>
        <CodeEditor
          value={text}
          onChange={setText}
          language={language}
          height="460px"
        />
      </Suspense>
      {error && <div className="notice error">{error}</div>}
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("close")}
        </button>
        <button
          className="button primary"
          disabled={pending}
          onClick={async () => {
            if (await run(() => onSave(text))) onClose();
          }}
        >
          {t(pending ? "saving" : "save")}
        </button>
      </footer>
    </Modal>
  );
}

interface FormField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
}

export function FormModal({
  title,
  fields,
  onSubmit,
  onClose,
  description,
  submitLabel,
}: {
  title: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
  description?: string;
  /** The submit button label; "Create" by default. */
  submitLabel?: string;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value || ""])),
  );
  return (
    <ModalForm
      title={title}
      onClose={onClose}
      onSubmit={() => onSubmit(values)}
      submitLabel={submitLabel || t("create")}
    >
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
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.target.value })
              }
            />
          )}
        </label>
      ))}
    </ModalForm>
  );
}
