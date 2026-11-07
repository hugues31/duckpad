import { useNavigate } from "react-router";
import { worktreeUrl } from "./navigation";
import { useApiResource } from "./useApiResource";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  PartitionPage,
  PartitionContext,
  PartitionEntry,
  PartitionLaunchOptions,
} from "./partitions";
import { api, ApiError, errorDetail, send, withQuery } from "./api";
import { outputSource } from "./graph";
import { useT } from "./i18n";
import { useShell } from "./shell";
import type {
  Bundle,
  Diagnostic,
  Environment,
  Run,
  Snapshot,
  Statuses,
} from "./types";
import { useWorktreeSnapshot } from "./useWorktreeSnapshot";

/** How many saves of a working branch can be undone. */
const HISTORY_LIMIT = 100;

/** Commits to revert: saves to undo, and undos to redo. */
interface History {
  undo: string[];
  redo: string[];
}

/** The working branch opened by the URL, with the actions that change it. */
export interface Worktree {
  partition: PartitionContext | null;
  partitionEntry: PartitionEntry | null;
  selectPartition: (entry: PartitionEntry | null) => void;
  /** Loaded for pipeline pages and partition settings; empty elsewhere. */
  id: string;
  assistantNode: string;
  assistantFile: string;
  setAssistantNode: (node: string) => void;
  setAssistantFile: (file: string) => void;
  environment: string;
  snapshot: Snapshot | null;
  statuses: Statuses;
  /** Whether statuses were read since the branch opened; before that, it has none. */
  statusesLoaded: boolean;
  /** Why the latest read of the snapshot failed. */
  loadError: string;
  canEdit: boolean;
  saving: boolean;
  /** A run is being started. */
  starting: boolean;
  /** Diagnostics revealed by the latest rejected run, scoped to this branch. */
  runDiagnostics: Diagnostic[];
  /** Changes after Git operations, so Git indicators reload. */
  gitVersion: number;
  /** Reload the snapshot after a change; a failed read is left to polling. */
  refresh: () => Promise<void>;
  /** Wait for saves already started by the canvas or an editor. */
  flush: () => Promise<void>;
  /** Save the open drafts, then wait for every save started so far. */
  settle: () => Promise<void>;
  /** Save a change applied to a copy of the bundle of `base`; it can be undone. */
  save: (base: Snapshot, change: (bundle: Bundle) => void) => Promise<Snapshot>;
  /** Finish drafts, then commit against the current revision with undo support. */
  commit: <T extends Snapshot>(
    request: (base: Snapshot) => Promise<T>,
    options?: { conflict?: string },
  ) => Promise<T>;
  /**
   * Revert the latest change saved in this session, or the given one, by a
   * commit that keeps later independent edits. Resolves false if there is none.
   */
  undo: (change?: string) => Promise<boolean>;
  /** Revert the latest undo of this session; resolves false if there is none. */
  redo: () => Promise<boolean>;
  saveFiles: (
    files: Record<string, string>,
    base: Snapshot,
  ) => Promise<Snapshot>;
  /** Run the pipeline or a node, asking first when the environment requires it. */
  run: (node?: string, options?: PartitionLaunchOptions) => Promise<void>;
  /** Run after the user confirmed it for this environment. */
  runConfirmed: (
    environment: string,
    node?: string,
    options?: PartitionLaunchOptions,
  ) => Promise<void>;
  stop: () => Promise<void>;
  /** Reload what a Git operation may have changed. */
  gitChanged: () => Promise<void>;
}

const WorktreeContext = createContext<Worktree | null>(null);

/** Whether two diagnostics report the same unconnected input. */
export const sameInput = (a: Diagnostic, b: Diagnostic) =>
  a.code === b.code && a.node === b.node && a.port === b.port;

/** Unconnected inputs that made the server refuse a run started from the UI. */
const refusedInputs = (error: unknown): Diagnostic[] =>
  error instanceof ApiError &&
  error.status === 422 &&
  Array.isArray(error.detail)
    ? (error.detail as Diagnostic[]).filter(
        (item) => item.code === "missing_input",
      )
    : [];

export function WorktreeProvider({
  worktree: id,
  children,
}: {
  worktree: string;
  children: ReactNode;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [validation, setValidation] = useState<{
    worktree: string;
    diagnostics: Diagnostic[];
  }>({ worktree: id, diagnostics: [] });
  const {
    workspace,
    environment,
    refreshWorkspace,
    notify,
    openModal,
    closeModal,
    drafts,
  } = useShell();
  const [assistantSelection, setAssistantSelection] = useState({
    worktree: id,
    node: "",
    file: "",
  });
  const setAssistantNode = useCallback(
    (node: string) =>
      setAssistantSelection((value) => ({
        worktree: id,
        node,
        file: value.worktree === id ? value.file : "",
      })),
    [id],
  );
  const setAssistantFile = useCallback(
    (file: string) =>
      setAssistantSelection((value) => ({
        worktree: id,
        file,
        node: value.worktree === id ? value.node : "",
      })),
    [id],
  );
  const [saves, setSaves] = useState(0);
  const pendingWrites = useRef(new Set<Promise<Snapshot>>());
  const pendingCommits = useRef(new Set<Promise<Snapshot>>());
  const commits = useRef<Promise<unknown>>(Promise.resolve());
  // The commits of the session's saves by working branch, which undo reverts.
  const histories = useRef(new Map<string, History>());
  // Undos and redos run one after another, each on the history the last one left.
  const reverts = useRef<Promise<unknown>>(Promise.resolve());
  const [starting, setStarting] = useState(false);
  const launching = useRef(false);
  const [gitVersion, setGitVersion] = useState(0);
  const {
    snapshot,
    statuses,
    statusesLoaded,
    loadError,
    refresh: reload,
    setActive,
  } = useWorktreeSnapshot(id, environment, {
    enabled: true,
    onUnavailable: () => {
      closeModal();
      return refreshWorkspace();
    },
  });
  // Once connected, an input is only reported again by the next refused run.
  const unresolved = snapshot
    ? validation.diagnostics.filter((item) =>
        snapshot.diagnostics.some((current) => sameInput(current, item)),
      )
    : validation.diagnostics;
  if (unresolved.length !== validation.diagnostics.length)
    setValidation({ ...validation, diagnostics: unresolved });
  const manifest = snapshot?.partitions?.[environment]?.manifest?.id;
  const dimension = snapshot?.partitions?.[environment]?.dimension;
  const partitionScope = JSON.stringify([
    id,
    environment,
    dimension?.name,
    dimension?.type,
    dimension?.values,
  ]);
  const [selectedPartition, setSelectedPartition] = useState<{
    scope: string;
    manifest?: string;
    entry: PartitionEntry | null;
  }>({ scope: "", entry: null });
  const selected =
    selectedPartition.scope === partitionScope ? selectedPartition.entry : null;
  const remapped = useApiResource<PartitionPage>(
    selected?.key_hash && manifest && selectedPartition.manifest !== manifest
      ? withQuery(`/worktrees/${id}/partitions`, {
          environment,
          manifest,
          key_hash: selected.key_hash,
          limit: 1,
        })
      : null,
  );
  if (
    selected &&
    selectedPartition.manifest !== manifest &&
    remapped.data &&
    manifest &&
    remapped.data.manifest?.id === manifest
  ) {
    setSelectedPartition({
      scope: partitionScope,
      manifest,
      entry: remapped.data.entries[0] || null,
    });
  }
  const partitionEntry =
    selectedPartition.manifest === manifest || remapped.pending
      ? selected
      : remapped.data?.entries[0] || null;
  const partition: PartitionContext | null = manifest
    ? {
        manifest:
          remapped.pending && selected ? selectedPartition.manifest! : manifest,
        ...(partitionEntry
          ? { partition_id: partitionEntry.partition_id }
          : { partition_mode: "all" as const }),
      }
    : null;
  const canEdit =
    !snapshot?.worktree.read_only &&
    (snapshot?.role === "admin" || snapshot?.role === "editor");
  const refresh = useCallback(
    (worktree?: string) => reload(worktree).catch(() => undefined),
    [reload],
  );
  // Stable, because the Git dialog reloads its repository when it changes.
  const gitChanged = useCallback(async () => {
    setGitVersion((version) => version + 1);
    await refreshWorkspace();
    await refresh();
  }, [refreshWorkspace, refresh]);

  async function write<T extends Snapshot>(
    worktree: string,
    request: () => Promise<T>,
  ) {
    if (!canEdit) throw new Error(t("readerNotice"));
    setSaves((count) => count + 1);
    const pending = Promise.resolve()
      .then(request)
      .finally(async () => {
        // Show the saved revision, or the one that rejected the change.
        await refresh(worktree);
        pendingWrites.current.delete(pending);
        setSaves((count) => count - 1);
      });
    pendingWrites.current.add(pending);
    return pending;
  }

  const put = (
    base: Snapshot,
    change: { bundle: Bundle } | { files: Record<string, string> },
  ) =>
    write(base.worktree.id, async () =>
      remember(
        base.worktree.id,
        await api<Snapshot>(
          `/worktrees/${base.worktree.id}`,
          send({ revision: base.revision, ...change }, "PUT"),
        ),
      ),
    );

  const history = (worktree: string) => {
    let entry = histories.current.get(worktree);
    if (!entry)
      histories.current.set(worktree, (entry = { undo: [], redo: [] }));
    return entry;
  };

  function remember<T extends Snapshot>(worktree: string, result: T): T {
    if (result.change) {
      const entry = history(worktree);
      entry.undo.push(result.change);
      entry.undo.splice(0, Math.max(0, entry.undo.length - HISTORY_LIMIT));
      entry.redo.length = 0;
    }
    return result;
  }

  function commit<T extends Snapshot>(
    request: (base: Snapshot) => Promise<T>,
    { conflict }: { conflict?: string } = {},
  ) {
    // Track preparation too: navigation and runs must wait even before the POST.
    setSaves((count) => count + 1);
    const pending = commits.current
      .catch(() => undefined)
      .then(async () => {
        await flushWrites();
        // A resolution already contains the retained proposal. Retrying its
        // rejected editor draft would create another conflict before resolving it.
        if (!conflict) await drafts.persist();
        await flushWrites();
        return write(id, async () => {
          const base = await api<Snapshot>(`/worktrees/${id}`);
          const result = await request(base);
          if (conflict)
            drafts.discardRejected(
              (error) =>
                error instanceof ApiError &&
                error.status === 409 &&
                errorDetail(error).id === conflict,
            );
          return remember(id, result);
        });
      })
      .finally(() => {
        pendingCommits.current.delete(pending);
        setSaves((count) => count - 1);
      });
    commits.current = pending;
    pendingCommits.current.add(pending);
    return pending;
  }

  async function revertNow(direction: keyof History, change?: string) {
    if (!canEdit) return false;
    // Pending edits are saved first, so they are the latest change.
    await settle();
    const commits = history(id)[direction];
    const index = change ? commits.lastIndexOf(change) : commits.length - 1;
    if (index < 0) return false;
    const [commit] = commits.splice(index, 1);
    try {
      const result = await write(id, () =>
        api<Snapshot>(`/worktrees/${id}/revert`, send({ commit })),
      );
      if (result.change)
        history(id)[direction === "undo" ? "redo" : "undo"].push(result.change);
      return true;
    } catch (error) {
      // A conflict retains both versions for resolution, which settles the change.
      if (!(error instanceof ApiError && error.status === 409))
        commits.splice(index, 0, commit);
      throw error;
    }
  }

  function revert(direction: keyof History, change?: string) {
    const next = reverts.current
      .catch(() => undefined)
      .then(() => revertNow(direction, change));
    reverts.current = next;
    return next;
  }

  async function flushWrites() {
    while (pendingWrites.current.size)
      await Promise.all([...pendingWrites.current]);
  }

  async function flush() {
    while (pendingWrites.current.size || pendingCommits.current.size)
      await Promise.all([...pendingWrites.current, ...pendingCommits.current]);
  }

  async function settle() {
    // Observe failures from saves already in flight before persisting drafts.
    await flush();
    await drafts.persist();
    await flush();
  }

  async function launch(
    environment: string,
    node?: string,
    confirmed = false,
    options?: PartitionLaunchOptions,
  ) {
    if (launching.current) return;
    launching.current = true;
    setStarting(true);
    try {
      await settle();
      const run = await api<Run>(
        `/worktrees/${id}/runs`,
        send({ environment, node, entry_point: "ui", confirmed, ...options }),
      );
      setActive(id, run);
      setValidation({ worktree: id, diagnostics: [] });
    } catch (error) {
      const missing = refusedInputs(error);
      if (missing.length) {
        // The banner now shows these inputs; select the first node to connect.
        setValidation({ worktree: id, diagnostics: missing });
        void navigate(
          worktreeUrl(id, "flow", environment, { node: missing[0].node! }),
        );
      }
      throw error;
    } finally {
      launching.current = false;
      setStarting(false);
    }
  }

  const confirmRun = (
    settings: Environment,
    node?: string,
    options?: PartitionLaunchOptions,
  ) =>
    openModal({
      kind: "runConfirmation",
      options,
      worktree: id,
      environment: settings,
      node,
    });

  const value: Worktree = {
    partition,
    partitionEntry,
    selectPartition: (entry) =>
      setSelectedPartition({ scope: partitionScope, manifest, entry }),
    id,
    assistantNode:
      assistantSelection.worktree === id ? assistantSelection.node : "",
    assistantFile:
      assistantSelection.worktree === id ? assistantSelection.file : "",
    setAssistantNode,
    setAssistantFile,
    environment,
    snapshot,
    statuses,
    statusesLoaded,
    loadError,
    runDiagnostics: validation.worktree === id ? validation.diagnostics : [],
    canEdit,
    saving: saves > 0,
    starting,
    gitVersion,
    refresh: () => refresh(),
    flush,
    settle,
    commit,
    save: async (base, change) => {
      const bundle = structuredClone(base.bundle!);
      change(bundle);
      return put(base, { bundle });
    },
    saveFiles: (files, base) => put(base, { files }),
    undo: (change) => revert("undo", change),
    redo: () => revert("redo"),
    run: async (node, options) => {
      if (node && !options && partitionEntry)
        options = {
          partitions: {
            mode: "selected",
            keys: [
              {
                type: partitionEntry.key.type,
                value: partitionEntry.key.value,
              },
            ],
          },
        };
      if (!canEdit || starting) return;
      const settings = workspace?.catalog.environment_details.find(
        (item) => item.id === environment,
      );
      if (settings?.confirm_before_run)
        return confirmRun(settings, node, options);
      try {
        await launch(environment, node, false, options);
      } catch (e) {
        const required = errorDetail(e).confirmation_required as
          Environment | undefined;
        if (required) confirmRun(required, node, options);
        else if (!refusedInputs(e).length) notify((e as Error).message, true);
      }
    },
    runConfirmed: (environment, node, options) =>
      launch(environment, node, true, options),
    stop: async () => {
      if (!statuses.active) return;
      try {
        const run = await api<Run>(
          `/runs/${statuses.active.id}/cancel`,
          send({}),
        );
        setActive(id, run);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    gitChanged,
  };
  return (
    <WorktreeContext.Provider value={value}>
      {children}
    </WorktreeContext.Provider>
  );
}

export function useWorktree() {
  const worktree = useContext(WorktreeContext);
  if (!worktree) throw new Error("useWorktree is only available inside App");
  return worktree;
}

/** The working branch of a pipeline tab, which renders once it is loaded. */
export function useLoadedWorktree() {
  const worktree = useWorktree();
  const { snapshot } = worktree;
  if (!snapshot) throw new Error("The working branch is not loaded");
  return { ...worktree, snapshot };
}

export const useOptionalWorktree = () => useContext(WorktreeContext);

export function usePartitionQuery(node: string, port = "result") {
  const worktree = useOptionalWorktree();
  const source = worktree?.snapshot?.bundle
    ? outputSource(worktree.snapshot.bundle, node, port)
    : { node, port };
  return worktree?.snapshot?.partitions?.[worktree.environment]?.nodes[
    source.node
  ]?.partitioned
    ? { ...worktree.partition }
    : {};
}
