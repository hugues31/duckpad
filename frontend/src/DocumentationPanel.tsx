import { useState } from "react";
import { useT } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
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
  const [message, setMessage] = useState("");
  const { draft, update, persist, pending } = useRevisionDraft(
    snapshot.bundle?.documentation.project || "",
    snapshot,
    onSave,
  );
  return (
    <section className="full-panel documentation-page">
      <span className="eyebrow">{t("documentation")}</span>
      <h1>{t("projectDocs")}</h1>
      <p className="muted">{t("emptyDocumentation")}</p>
      <textarea
        readOnly={readOnly}
        className="project-documentation"
        value={draft}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => update(() => e.target.value)}
      />
      <div className="row gap">
        <button
          className="button primary"
          disabled={readOnly || pending}
          onClick={async () => {
            setMessage("");
            try {
              await persist();
              setMessage(t("saved"));
            } catch (e) {
              setMessage((e as Error).message);
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
