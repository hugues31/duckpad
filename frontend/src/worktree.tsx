import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, send } from "./api";
import { useT } from "./i18n";
import { useShell } from "./shell";
import type { Bundle, Environment, Json, Snapshot, Statuses } from "./types";
import { useWorktreeSnapshot } from "./useWorktreeSnapshot";

/** The working branch opened by the URL, with the actions that change it. */
export interface Worktree {
  /** Empty outside the pipeline pages, where nothing is loaded. */
  id: string;
  environment: string;
  snapshot: Snapshot | null;
  statuses: Statuses;
  /** Why the latest read of the snapshot failed. */
  loadError: string;
  canEdit: boolean;
  saving: boolean;
  /** A run is being started. */
  starting: boolean;
  /** Changes after Git operations, so Git indicators reload. */
  gitVersion: number;
  /** Reload the snapshot after a change; a failed read is left to polling. */
  refresh: () => Promise<void>;
  /** Save a change applied to a copy of the bundle of `base`. */
  save: (base: Snapshot, change: (bundle: Bundle) => void) => Promise<Snapshot>;
  saveFiles: (
    files: Record<string, string>,
    base: Snapshot,
  ) => Promise<Snapshot>;
  /** Run the pipeline or a node, asking first when the environment requires it. */
  run: (node?: string) => Promise<void>;
  /** Run after the user confirmed it for this environment. */
  runConfirmed: (environment: string, node?: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Reload what a Git operation may have changed. */
  gitChanged: () => Promise<void>;
}

const WorktreeContext = createContext<Worktree | null>(null);

export function WorktreeProvider({
  worktree: id,
  children,
}: {
  worktree: string;
  children: ReactNode;
}) {
  const t = useT();
  const {
    workspace,
    environment,
    refreshWorkspace,
    notify,
    openModal,
    closeModal,
  } = useShell();
  const [saves, setSaves] = useState(0);
  const [starting, setStarting] = useState(false);
  const [gitVersion, setGitVersion] = useState(0);
  const {
    snapshot,
    statuses,
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
  const canEdit = snapshot?.role === "admin" || snapshot?.role === "editor";
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

  async function write(base: Snapshot, change: Json) {
    if (!canEdit) throw new Error(t("readerNotice"));
    setSaves((count) => count + 1);
    try {
      return await api<Snapshot>(
        `/worktrees/${base.worktree.id}`,
        send({ revision: base.revision, ...change }, "PUT"),
      );
    } finally {
      // Show the saved revision, or the one that rejected the change.
      await refresh(base.worktree.id);
      setSaves((count) => count - 1);
    }
  }

  async function launch(environment: string, node?: string, confirmed = false) {
    setStarting(true);
    try {
      const run = await api(
        `/worktrees/${id}/runs`,
        send({ environment, node, entry_point: "ui", confirmed }),
      );
      setActive(id, run);
    } finally {
      setStarting(false);
    }
  }

  const confirmRun = (settings: Environment, node?: string) =>
    openModal({
      kind: "runConfirmation",
      worktree: id,
      environment: settings,
      node,
    });

  const value: Worktree = {
    id,
    environment,
    snapshot,
    statuses,
    loadError,
    canEdit,
    saving: saves > 0,
    starting,
    gitVersion,
    refresh: () => refresh(),
    save: (base, change) => {
      const bundle = structuredClone(base.bundle!);
      change(bundle);
      return write(base, { bundle });
    },
    saveFiles: (files, base) => write(base, { files }),
    run: async (node) => {
      if (!canEdit || starting) return;
      const settings = workspace?.catalog.environment_details.find(
        (item) => item.id === environment,
      );
      if (settings?.confirm_before_run) return confirmRun(settings, node);
      try {
        await launch(environment, node);
      } catch (e) {
        const required =
          e instanceof ApiError &&
          (e.detail as Json | undefined)?.confirmation_required;
        if (required) confirmRun(required, node);
        else notify((e as Error).message, true);
      }
    },
    runConfirmed: (environment, node) => launch(environment, node, true),
    stop: async () => {
      if (!statuses.active) return;
      try {
        const run = await api(`/runs/${statuses.active.id}/cancel`, send({}));
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
