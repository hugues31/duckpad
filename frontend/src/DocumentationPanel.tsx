import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import GeneratedDocumentation from "./GeneratedDocumentation";
import { useT } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Snapshot, Statuses } from "./types";

export default function DocumentationPanel({
  readOnly = false,
  snapshot,
  onSave,
  statuses = { nodes: {}, active: null },
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  statuses?: Statuses;
  /** Save the text on top of the given revision; resolve to the saved snapshot. */
  onSave: (text: string, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(readOnly);
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
      {preview ? (
        <div
          className="documentation-preview"
          aria-label={t("markdownPreview")}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>
        </div>
      ) : (
        <textarea
          aria-label={t("projectDocs")}
          readOnly={readOnly}
          className="project-documentation"
          value={draft}
          placeholder={t("documentationPlaceholder")}
          onChange={(e) => update(() => e.target.value)}
        />
      )}
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
      <GeneratedDocumentation snapshot={snapshot} statuses={statuses} />
    </section>
  );
}
