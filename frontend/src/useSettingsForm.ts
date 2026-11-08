import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DraftContext } from "./useRevisionDraft";

/** Register an explicitly saved settings form with navigation and tab-close guards. */
export function useSettingsGuard({
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

/** State and navigation protection shared by explicitly saved instance settings. */
export function useSettingsForm<T>(
  value: T | null,
  save: (value: T) => Promise<void>,
  options: { dirty?: boolean; discard?: () => void } = {},
) {
  const [draft, setDraft] = useState<T | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const config = draft ?? value;
  const dirty =
    (!!draft && JSON.stringify(draft) !== JSON.stringify(value)) ||
    !!options.dirty;
  const persist = useSettingsGuard({
    dirty,
    discard: () => {
      setDraft(null);
      options.discard?.();
    },
    save: async () => {
      if (config === null) return;
      setPending(true);
      setError("");
      setSaved(false);
      try {
        await save(config);
        setDraft((current) => (current === draft ? null : current));
        setSaved(true);
      } catch (error) {
        setError((error as Error).message);
        throw error;
      } finally {
        setPending(false);
      }
    },
  });
  return {
    config,
    dirty,
    pending,
    error,
    saved,
    setSaved,
    change: (changes: Partial<T>) => {
      if (config) setDraft({ ...config, ...changes });
      setSaved(false);
    },
    submit: () => persist().catch(() => undefined),
  };
}
