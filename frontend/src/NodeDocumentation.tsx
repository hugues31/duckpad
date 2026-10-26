import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import type { Json, Snapshot } from "./types";

export default function NodeDocumentation({
  snapshot,
  fullNode,
  preview,
  onSave,
}: {
  snapshot: Snapshot;
  fullNode: string;
  preview: Json | null;
  onSave: (
    change: (documentation: Json) => void,
    base: Snapshot,
  ) => Promise<void>;
}) {
  const t = useT();
  const [kind, setKind] = useState("nodes");
  const [column, setColumn] = useState("");
  const key =
    kind === "nodes" ? fullNode : fullNode + ":" + (preview?.port || "result");
  const current =
    kind === "columns"
      ? snapshot.bundle?.documentation.columns?.[key]?.[column] || ""
      : snapshot.bundle?.documentation[kind]?.[key] || "";
  const [value, setValue] = useState(current);
  const [message, setMessage] = useState("");
  const base = useRef(snapshot);
  useEffect(() => {
    setValue(current);
    base.current = snapshot;
  }, [kind, column, key, current]);
  async function save() {
    try {
      await onSave((documentation) => {
        documentation[kind] ??= {};
        if (kind === "columns") {
          documentation.columns[key] ??= {};
          documentation.columns[key][column] = value;
        } else documentation[kind][key] = value;
      }, base.current);
      setMessage(t("saved"));
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        aria-label={t("documentation")}
      >
        <option value="nodes">{t("nodeDocs")}</option>
        <option value="datasets">{t("datasetDocs")}</option>
        <option value="columns">{t("columnDocs")}</option>
      </select>
      {kind === "columns" && (
        <select
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          aria-label={t("chooseColumn")}
        >
          <option value="">{t("chooseColumn")}</option>
          {preview?.columns.map((c: Json) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      )}
      <textarea
        readOnly={snapshot.role === "reader"}
        className="documentation-editor"
        value={value}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="button primary full"
        onClick={save}
        disabled={snapshot.role === "reader" || (kind === "columns" && !column)}
      >
        {t("save")}
      </button>
      {message && <p className="muted small">{message}</p>}
    </>
  );
}
