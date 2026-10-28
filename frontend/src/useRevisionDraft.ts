import { useEffect, useRef, useState } from "react";

/** Keep immutable edits tied to their revision and serialize explicit saves.
 * Remount the owner when switching to a different document.
 */
export function useRevisionDraft<T, Revision>(
  value: T,
  revision: Revision,
  onSave: (draft: T, base: Revision) => Promise<Revision>,
) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const base = useRef(revision);
  const dirty = useRef(false);
  const saving = useRef<{ draft: T; promise: Promise<void> } | null>(null);

  useEffect(() => {
    if (dirty.current || saving.current) return;
    latest.current = value;
    base.current = revision;
    setDraft(value);
  }, [value, revision]);

  const update = (change: (current: T) => T) => {
    latest.current = change(latest.current);
    dirty.current = true;
    setDraft(latest.current);
  };

  const persist = async (): Promise<void> => {
    if (saving.current) {
      // Blur and click can request the same save. A duplicate request must
      // not also save edits typed after that click.
      const needsFollowUp = latest.current !== saving.current.draft;
      await saving.current.promise;
      if (needsFollowUp) return persist();
      return;
    }
    if (!dirty.current) return;
    const saved = latest.current;
    const promise = Promise.resolve()
      .then(() => onSave(saved, base.current))
      .then((revision) => {
        base.current = revision;
        dirty.current = latest.current !== saved;
      })
      .finally(() => {
        saving.current = null;
      });
    saving.current = { draft: saved, promise };
    await promise;
  };

  return { draft, update, persist };
}
