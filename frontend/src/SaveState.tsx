import { useT } from "./i18n";

export default function SaveState({
  pending,
  dirty,
  error,
}: {
  pending: boolean;
  dirty: boolean;
  error?: string;
}) {
  const t = useT();
  return (
    <span
      className="editor-save-state muted small"
      role="status"
      title={t("editorAutosaveHint")}
    >
      {t(pending ? "saving" : dirty || error ? "unsavedChanges" : "saved")}
    </span>
  );
}
