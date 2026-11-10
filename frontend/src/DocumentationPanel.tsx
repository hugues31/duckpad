import { useState } from "react";
import MarkdownText from "./MarkdownText";
import MarkdownEditor from "./MarkdownEditor";
import GeneratedDocumentation from "./GeneratedDocumentation";
import { useT } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Snapshot, Statuses } from "./types";

export default function DocumentationPanel({
  readOnly = false,
  snapshot,
  onSave,
  statuses,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  statuses: Statuses;
  /** Save the text on top of the given revision; resolve to the saved snapshot. */
  onSave: (text: string, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(readOnly);
  const { draft, update, persist, pending, dirty } = useRevisionDraft(
    snapshot.bundle?.documentation.project || "",
    snapshot,
    onSave,
  );
  return (
    <section className="full-panel documentation-page">
      <span className="eyebrow">{t("documentation")}</span>
      <h1>{t("projectDocs")}</h1>
      <p className="muted">{t("emptyDocumentation")}</p>
      <div className="documentation-actions">
        {!readOnly && (
          <div className="segmented">
            <button
              aria-pressed={!preview}
              className={!preview ? "active" : ""}
              onClick={() => setPreview(false)}
            >
              {t("edit")}
            </button>
            <button
              aria-pressed={preview}
              className={preview ? "active" : ""}
              onClick={() => setPreview(true)}
            >
              {t("markdownPreview")}
            </button>
          </div>
        )}
        {!readOnly && (
          <button
            className="button primary small"
            disabled={!dirty || pending}
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
        )}
        <span className="muted small" role="status">
          {message}
        </span>
      </div>
      {readOnly || preview ? (
        <section
          className="documentation-preview"
          aria-label={t("markdownPreview")}
        >
          <MarkdownText>{draft}</MarkdownText>
        </section>
      ) : (
        <MarkdownEditor
          value={draft}
          disabled={pending}
          onChange={(text) => {
            update(() => text);
            setMessage("");
          }}
        />
      )}
      <GeneratedDocumentation snapshot={snapshot} statuses={statuses} />
    </section>
  );
}
