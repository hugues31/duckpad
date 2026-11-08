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
  autosave: boolean;
  discard: () => void;
  persist: () => Promise<void>;
  rejection?: () => unknown;
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
      /** Whether navigation needs a choice about edits that are saved explicitly. */
      requiresConfirmation: (scope?: DraftScope) =>
        matching(scope).some((draft) => !draft.autosave),
      /** Finish autosaving the editors that navigation will close. */
      autosave: async (scope?: DraftScope) => {
        for (const draft of matching(scope))
          if (draft.autosave) await draft.persist();
      },
      /** Discard unsaved changes, optionally only those of one scope. */
      discard: (scope?: DraftScope) =>
        matching(scope).forEach((draft) => draft.discard()),
      /** Accept a reviewed proposal without dropping edits typed since its rejection. */
      discardRejected: (matches: (error: unknown) => boolean) =>
        matching().forEach((draft) => {
          if (matches(draft.rejection?.())) draft.discard();
        }),
      /** Save each editor against its own base, stopping on a rejected save. */
      persist: async () => {
        for (const draft of matching()) await draft.persist();
      },
    };
  }, [drafts, register]);
}

/** How long edits pause before they are saved, in milliseconds. */
export const AUTOSAVE_DELAY = 800;

/**
 * Call `save` once `value` has not changed for `delay` while `enabled`.
 * Drafts call it with their `persist` unless the draft was `rejected`.
 */
export function useIdleSave(
  value: unknown,
  enabled: boolean,
  save: () => void,
  delay = AUTOSAVE_DELAY,
) {
  const onIdle = useEffectEvent(save);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => onIdle(), delay);
    return () => clearTimeout(timer);
  }, [value, enabled, delay]);
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
  const rejected = useRef<{ draft: T; submitted: T; error: unknown } | null>(
    null,
  );
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
          rejected.current = { draft, submitted: draft, error };
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
  const flush = async () => {
    try {
      do {
        await persist();
      } while (unsaved());
    } catch (error) {
      // The navigation reports the failure, edits typed meanwhile included.
      rejected.current = {
        draft: latest.current,
        submitted: rejected.current?.submitted ?? latest.current,
        error,
      };
      throw error;
    }
  };
  const register = useContext(DraftContext);
  // The registry and the unmount use the actions of the latest render.
  const actions = useRef({ discard, close, flush });
  useLayoutEffect(() => {
    actions.current = { discard, close, flush };
  });
  useEffect(() => {
    if (!dirty || !register) return;
    return register({
      scope,
      autosave,
      discard: () => actions.current.discard(),
      persist: () => actions.current.flush(),
      rejection: () =>
        rejected.current?.submitted === latest.current
          ? rejected.current?.error
          : undefined,
    });
  }, [dirty, register, scope, autosave]);
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
    /** Whether a failed save already reported the current draft; only an explicit save resends it. */
    rejected: () => rejected.current?.draft === latest.current,
    /** Why the current draft was rejected, if it was. */
    rejection: () =>
      rejected.current?.draft === latest.current
        ? rejected.current.error
        : undefined,
  };
}
