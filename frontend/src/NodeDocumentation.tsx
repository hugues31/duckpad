import { useRef, useState } from "react";
import { useSaveShortcut } from "./useSaveShortcut";
import { retainedConflict } from "./api";
import { useT } from "./i18n";
import { useIdleSave, useRevisionDraft } from "./useRevisionDraft";
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
  const editor = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  const editable =
    !snapshot.worktree.read_only &&
    (snapshot.role === "admin" || snapshot.role === "editor");
  const current = snapshot.bundle?.documentation?.nodes?.[fullNode] || "";
  // Notes are saved after a pause in typing, on blur, and when the tab closes.
  const { draft, dirty, update, persist, rejected, rejection } =
    useRevisionDraft(
      current,
      snapshot,
      (text, base) =>
        onSave((value) => {
          (value.nodes ??= {})[fullNode] = text;
        }, base),
      { autosave: editable },
    );
  async function save() {
    if (!editable) return;
    setError("");
    try {
      await persist();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useIdleSave(draft, dirty && editable, () => {
    if (!rejected()) void save();
  });
  useSaveShortcut(() => {
    if (!retainedConflict(rejection())) return save();
  }, editor);
  return (
    <>
      <textarea
        ref={editor}
        readOnly={!editable}
        className="documentation-editor"
        aria-label={t("nodeDocs")}
        value={draft}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => update(() => e.target.value)}
        onBlur={() => void save()}
      />
      {error && <div className="notice error">{error}</div>}
    </>
  );
}
