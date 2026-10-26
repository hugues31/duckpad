import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import type { Snapshot } from "./types";

export default function DocumentationPanel({
  readOnly = false,
  snapshot,
  onSave,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  /** Save the text on top of the given revision; resolve to the saved snapshot. */
  onSave: (text: string, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const [text, setText] = useState(
    snapshot.bundle?.documentation.project || "",
  );
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  // The revision being edited; it advances with each save and, while there
  // are no unsaved edits, with external changes.
  const base = useRef(snapshot);
  const latest = useRef(text);
  const dirty = useRef(false);
  const edit = (value: string) => {
    latest.current = value;
    dirty.current = true;
    setText(value);
  };
  useEffect(() => {
    if (dirty.current) return;
    base.current = snapshot;
    edit(snapshot.bundle?.documentation.project || "");
    dirty.current = false;
  }, [snapshot]);
  return (
    <section className="full-panel documentation-page">
      <span className="eyebrow">{t("documentation")}</span>
      <h1>{t("projectDocs")}</h1>
      <p className="muted">{t("emptyDocumentation")}</p>
      <textarea
        readOnly={readOnly}
        className="project-documentation"
        value={text}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => edit(e.target.value)}
      />
      <div className="row gap">
        <button
          className="button primary"
          disabled={readOnly || pending}
          onClick={async () => {
            if (saving.current || readOnly) return;
            saving.current = true;
            setPending(true);
            setMessage("");
            const saved = text;
            try {
              base.current = await onSave(saved, base.current);
              // Keep edits typed while the save was in flight.
              dirty.current = latest.current !== saved;
              setMessage(t("saved"));
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              saving.current = false;
              setPending(false);
            }
          }}
        >
          {t(pending ? "saving" : "save")}
        </button>
        <span className="muted small">{message}</span>
      </div>
    </section>
  );
}
