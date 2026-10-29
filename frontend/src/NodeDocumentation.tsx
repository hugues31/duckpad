import Select from "./Select";
import { useState } from "react";
import { useT } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Json, Snapshot } from "./types";

type SaveDocumentation = (
  change: (documentation: Json) => void,
  base: Snapshot,
) => Promise<Snapshot>;

export default function NodeDocumentation({
  snapshot,
  fullNode,
  preview,
  onSave,
}: {
  snapshot: Snapshot;
  fullNode: string;
  preview: Json | null;
  onSave: SaveDocumentation;
}) {
  const t = useT();
  const [kind, setKind] = useState("nodes");
  const [column, setColumn] = useState("");
  const key =
    kind === "nodes" ? fullNode : fullNode + ":" + (preview?.port || "result");
  return (
    <>
      <Select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        aria-label={t("documentation")}
      >
        <option value="nodes">{t("nodeDocs")}</option>
        <option value="datasets">{t("datasetDocs")}</option>
        <option value="columns">{t("columnDocs")}</option>
      </Select>
      {kind === "columns" && (
        <Select
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          aria-label={t("chooseColumn")}
        >
          <option value="">{t("chooseColumn")}</option>
          {preview?.columns.map((c: Json) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </Select>
      )}
      <DocumentationEditor
        key={`${kind}:${key}:${column}`}
        snapshot={snapshot}
        kind={kind}
        documentKey={key}
        column={kind === "columns" ? column : ""}
        onSave={onSave}
      />
    </>
  );
}

/** Edit one documentation entry; switching entries remounts the editor. */
function DocumentationEditor({
  snapshot,
  kind,
  documentKey,
  column,
  onSave,
}: {
  snapshot: Snapshot;
  kind: string;
  documentKey: string;
  column: string;
  onSave: SaveDocumentation;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const editable =
    snapshot.role !== "reader" && (kind !== "columns" || !!column);
  const documentation = snapshot.bundle?.documentation;
  const current: string =
    (kind === "columns"
      ? documentation?.columns?.[documentKey]?.[column]
      : documentation?.[kind]?.[documentKey]) || "";
  // Switching nodes or entries saves the notes rather than dropping them.
  const { draft, update, persist, pending } = useRevisionDraft(
    current,
    snapshot,
    (text, base) =>
      onSave((value) => {
        value[kind] ??= {};
        if (kind === "columns") {
          value.columns[documentKey] ??= {};
          value.columns[documentKey][column] = text;
        } else value[kind][documentKey] = text;
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
