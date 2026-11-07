import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DraftContext } from "./useRevisionDraft";

/** Register an explicitly saved settings form with navigation and tab-close guards. */
export function useSettingsForm({
  dirty,
  save,
  discard,
}: {
  dirty: boolean;
  save: () => Promise<void>;
  discard: () => void;
}) {
  const register = useContext(DraftContext);
  const pending = useRef<Promise<void> | null>(null);
  const [saving, setSaving] = useState(false);
  const persist = () => {
    if (!pending.current) {
      setSaving(true);
      pending.current = Promise.resolve()
        .then(save)
        .finally(() => {
          pending.current = null;
          setSaving(false);
        });
    }
    return pending.current;
  };
  const actions = useRef({ persist, discard });
  useLayoutEffect(() => {
    actions.current = { persist, discard };
  });
  useEffect(() => {
    if (!dirty || !register) return;
    return register({
      scope: "page",
      // Navigation waits for a save already sent rather than offering to discard it.
      autosave: saving,
      persist: () => actions.current.persist(),
      discard: () => actions.current.discard(),
    });
  }, [dirty, register, saving]);
  return persist;
}
