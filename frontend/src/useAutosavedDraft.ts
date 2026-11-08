import { useState } from "react";
import { useIdleSave, useRevisionDraft } from "./useRevisionDraft";

/** Revision-aware autosave, with explicit retries and an inline error. */
export function useAutosavedDraft<T, Revision>(
  value: T,
  revision: Revision,
  onSave: (draft: T, base: Revision) => Promise<Revision>,
  {
    readOnly = false,
    ...options
  }: Omit<
    NonNullable<Parameters<typeof useRevisionDraft<T, Revision>>[3]>,
    "autosave"
  > & { readOnly?: boolean } = {},
) {
  const draft = useRevisionDraft(value, revision, onSave, {
    ...options,
    autosave: !readOnly,
  });
  const [error, setError] = useState("");
  const saveNow = async () => {
    if (readOnly) return true;
    setError("");
    try {
      await draft.persist();
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  };
  useIdleSave(draft.draft, draft.dirty && !readOnly, () => {
    if (!draft.rejected()) void saveNow();
  });
  return { ...draft, error: draft.dirty ? error : "", saveNow };
}
