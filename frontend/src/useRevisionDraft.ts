import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** The navigation that unmounts a draft: leaving its page or its worktree. */
export type DraftScope = "page" | "worktree";

interface Draft {
  scope: DraftScope;
  discard: () => void;
}

/** Registers an unsaved draft and returns its unregistration. */
export const DraftContext = createContext<
  ((draft: Draft) => () => void) | null
>(null);

export type DraftRegistry = ReturnType<typeof useDraftRegistry>;

/** Collect the unsaved drafts of mounted editors for navigation and unload guards. */
export function useDraftRegistry() {
  const [drafts, setDrafts] = useState<ReadonlySet<Draft>>(() => new Set());
  const register = useCallback((draft: Draft) => {
    setDrafts((current) => new Set(current).add(draft));
    return () =>
      setDrafts((current) => {
        const next = new Set(current);
        next.delete(draft);
        return next;
      });
  }, []);
  return useMemo(() => {
    const matching = (scope?: DraftScope) =>
      [...drafts].filter((draft) => !scope || draft.scope === scope);
    return {
      register,
      /** Whether an editor holds unsaved changes, optionally only of one scope. */
      dirty: (scope?: DraftScope) => matching(scope).length > 0,
      /** Discard unsaved changes, optionally only those of one scope. */
      discard: (scope?: DraftScope) =>
        matching(scope).forEach((draft) => draft.discard()),
    };
  }, [drafts, register]);
}

interface DraftOptions<T> {
  /** Which navigation must confirm before discarding the draft. */
  scope?: DraftScope;
  /** Save pending edits when the editor closes instead of dropping them. */
  autosave?: boolean;
  equal?: (a: T, b: T) => boolean;
}

/** Keep immutable edits tied to their revision and serialize explicit saves.
 * Incoming values replace the draft only while it holds no unsaved edits.
 * Unsaved drafts are registered with the enclosing navigation guard.
 * Remount the owner when switching to a different document.
 */
export function useRevisionDraft<T, Revision>(
  value: T,
  revision: Revision,
  onSave: (draft: T, base: Revision) => Promise<Revision>,
  { scope = "page", autosave = false, equal = Object.is }: DraftOptions<T> = {},
) {
  const [state, setState] = useState({ draft: value, saved: value });
  const [pending, setPending] = useState(false);
  const latest = useRef(value);
  // The value of the base revision, which the draft is compared with.
  const saved = useRef(value);
  const base = useRef(revision);
  const incoming = useRef({ value, revision });
  const saving = useRef<{ draft: T; promise: Promise<void> } | null>(null);
  // A rejected draft was already reported; closing the editor must not resend it.
  const rejected = useRef<{ draft: T } | null>(null);
  // Discarding invalidates the result of a save still in flight.
  const generation = useRef(0);
  const dirty = !equal(state.draft, state.saved);
  const unsaved = () => !equal(latest.current, saved.current);
  const show = (draft: T, savedValue: T) => {
    latest.current = draft;
    saved.current = savedValue;
    setState({ draft, saved: savedValue });
  };

  const receive = useEffectEvent((value: T, revision: Revision) => {
    incoming.current = { value, revision };
    if (unsaved() || saving.current) return;
    base.current = revision;
    show(value, value);
  });
  useEffect(() => {
    receive(value, revision);
  }, [value, revision]);

  const update = (change: (current: T) => T) => {
    show(change(latest.current), saved.current);
  };

  const discard = () => {
    generation.current++;
    rejected.current = null;
    base.current = incoming.current.revision;
    show(incoming.current.value, incoming.current.value);
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
    if (!unsaved()) return;
    const draft = latest.current;
    const started = generation.current;
    const promise = Promise.resolve()
      .then(() => onSave(draft, base.current))
      .then(
        (revision) => {
          if (started !== generation.current) return;
          base.current = revision;
          rejected.current = null;
          // Keep edits typed while the save was in flight.
          show(latest.current, draft);
        },
        (error) => {
          rejected.current = { draft };
          throw error;
        },
      )
      .finally(() => {
        saving.current = null;
        setPending(false);
      });
    saving.current = { draft, promise };
    setPending(true);
    await promise;
  };

  const close = () => {
    if (!autosave || !unsaved() || rejected.current?.draft === latest.current)
      return;
    // The owner reports save failures; nothing is left to display them here.
    persist().catch(() => undefined);
  };
  const register = useContext(DraftContext);
  // The registry and the unmount use the actions of the latest render.
  const actions = useRef({ discard, close });
  useLayoutEffect(() => {
    actions.current = { discard, close };
  });
  useEffect(() => {
    if (!dirty || !register) return;
    return register({ scope, discard: () => actions.current.discard() });
  }, [dirty, register, scope]);
  useEffect(() => () => actions.current.close(), []);

  return {
    draft: state.draft,
    /** The value of the revision being edited. */
    saved: state.saved,
    dirty,
    pending,
    update,
    persist,
    discard,
  };
}
