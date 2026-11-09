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

/** State and navigation protection for explicit settings saves. The save callback
 * must publish the persisted value before resolving so clearing the draft shows it. */
export function useSettingsForm<T>(
  value: T | null,
  save: (value: T) => Promise<void>,
  options: {
    dirty?: boolean;
    discard?: () => void;
    equal?: (a: T, b: T) => boolean;
  } = {},
) {
  const [draft, setDraft] = useState<T | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const config = draft ?? value;
  const equal =
    options.equal ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const dirty =
    (draft !== null && (value === null || !equal(draft, value))) ||
    !!options.dirty;
  const discard = () => {
    setDraft(null);
    setSaved(false);
    options.discard?.();
  };
  const persist = useSettingsGuard({
    dirty,
    discard,
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
    discard,
    update: (change: (current: T) => T) => {
      if (config !== null) setDraft(change(config));
      setSaved(false);
    },
    persist,
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
