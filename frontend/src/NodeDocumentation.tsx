import { useState } from "react";
import { useT } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Documentation, Snapshot } from "./types";

/**
 * The node's own documentation. Its datasets and columns are documented in the
 * results panel's Columns tab, where they are visible.
 */
export default function NodeDocumentation({
  snapshot,
  fullNode,
  onSave,
}: {
  snapshot: Snapshot;
  fullNode: string;
  onSave: (
    change: (documentation: Documentation) => void,
    base: Snapshot,
  ) => Promise<Snapshot>;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const editable =
    !snapshot.worktree.read_only &&
    (snapshot.role === "admin" || snapshot.role === "editor");
  const current = snapshot.bundle?.documentation?.nodes?.[fullNode] || "";
  // Switching nodes or tabs saves the notes rather than dropping them.
  const { draft, update, persist, pending } = useRevisionDraft(
    current,
    snapshot,
    (text, base) =>
      onSave((value) => {
        (value.nodes ??= {})[fullNode] = text;
      }, base),
    { autosave: editable },
  );
  async function save() {
    setMessage("");
    try {
      await persist();
      setMessage(t("saved"));
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <textarea
        readOnly={!editable}
        className="documentation-editor"
        aria-label={t("nodeDocs")}
        value={draft}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => update(() => e.target.value)}
      />
      <button
        className="button primary full"
        onClick={save}
        disabled={!editable || pending}
      >
        {t(pending ? "saving" : "save")}
      </button>
      {message && <p className="muted small">{message}</p>}
    </>
  );
}
