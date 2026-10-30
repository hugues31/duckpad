import { useCallback, useEffect, useRef, useState } from "react";
import { api, withQuery } from "./api";
import GitBranchesTab from "./GitBranchesTab";
import GitCompareTab, { savedSelection, type Selection } from "./GitCompareTab";
import GitReviewTab from "./GitReviewTab";
import GitSyncTab from "./GitSyncTab";
import type { Repository } from "./gitTabs";
import { useT, type TranslationKey } from "./i18n";
import { Modal } from "./modals";
import type { Json } from "./types";
import "./git.css";

type Mode = "compare" | "branches" | "sync" | "review";

const TABS: Record<Mode, TranslationKey> = {
  compare: "compareVersions",
  branches: "branches",
  sync: "gitSynchronization",
  review: "mergeReview",
};

/** Load the branches and origin state, reporting failures to the tabs that show them. */
function useRepository(base: string, onChanged: () => Promise<void>) {
  const [state, setState] = useState<{
    branches: Json[];
    remote: Json | null;
  }>({ branches: [], remote: null });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Repository["failure"]>(null);
  const sequence = useRef(0);
  const load = useCallback(
    async function load(changed = false): Promise<void> {
      const current = ++sequence.current;
      setLoading(true);
      setFailure(null);
      try {
        if (changed) await onChanged();
        const [branches, remote] = await Promise.all([
          api<Json[]>(`${base}/branches`),
          api<Json>(`${base}/remote`),
        ]);
        if (current === sequence.current) setState({ branches, remote });
      } catch (e) {
        if (current === sequence.current)
          setFailure({
            message: (e as Error).message,
            retry: () => void load(changed),
          });
      } finally {
        if (current === sequence.current) setLoading(false);
      }
    },
    [base, onChanged],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return {
    repository: { ...state, loading, failure, reload: () => load() },
    setRemote: (remote: Json) => setState((old) => ({ ...old, remote })),
    /** Refresh the workspace and the repository after a Git change. */
    refresh: () => load(true),
  };
}

export default function GitWorkspace({
  worktree,
  role,
  mode = "compare",
  commit,
  entity,
  onClose,
  onChanged,
  onOpen,
  onNewBranch,
}: {
  worktree: string;
  role: string;
  mode?: Mode;
  commit?: string;
  entity?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => void;
  /** Close this dialog and open the branch creation dialog. */
  onNewBranch: () => void;
}) {
  const t = useT();
  const open = useRef(false);
  const base = `/worktrees/${worktree}/git`;
  const storageKey = `duckpad.git.${worktree}`;
  const canEdit = role !== "reader";
  const [tab, setTab] = useState<Mode>(mode);
  // Tabs stay mounted once shown, keeping their own state and errors.
  const [visited, setVisited] = useState<Mode[]>([mode]);
  const [selection, setSelection] = useState<Selection>(() =>
    commit ? { a: `${commit}^`, b: commit } : savedSelection(storageKey),
  );
  const [ready, setReady] = useState(!commit);
  const [review, setReview] = useState<Json | null>(null);
  const [version, setVersion] = useState(0);
  const { repository, setRemote, refresh } = useRepository(base, onChanged);

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  useEffect(() => {
    if (!commit) return;
    const controller = new AbortController();
    const fallback = `${commit}^`;
    api<Json>(withQuery(`${base}/history`, { ref: commit, limit: 1 }), {
      signal: controller.signal,
    })
      .then((page) => {
        // A root commit has an empty-tree parent, and merge parents are supplied by Git.
        const parent = page.items[0]?.parents[0] || "empty";
        // Resolved once: a reference chosen meanwhile is kept.
        setSelection((current) =>
          current.a === fallback ? { a: parent, b: current.b } : current,
        );
      })
      .catch(() => {
        // The comparison reports an unusable parent itself.
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, [base, commit]);

  const show = (value: Mode) => {
    setTab(value);
    setVisited((old) => (old.includes(value) ? old : [...old, value]));
  };
  const changed = async (remote?: Json) => {
    if (remote) setRemote(remote);
    await refresh();
    setVersion((value) => value + 1);
  };
  const compare = (a: string, b: string) => {
    setSelection({ a, b });
    show("compare");
  };
  const openReview = (value: Json) => {
    setReview(value);
    show("review");
  };
  /** Actions finishing after the dialog closed must not navigate or close another dialog. */
  const openWorktree = (id: string) => {
    if (!open.current) return;
    onOpen(id);
    onClose();
  };
  const panel = (value: Mode, content: React.ReactNode) =>
    visited.includes(value) && <div hidden={tab !== value}>{content}</div>;

  return (
    <Modal title={t("gitWorkspace")} onClose={onClose} wide>
      <div className="git-workspace">
        <nav className="git-tabs" aria-label={t("gitWorkspace")}>
          {(Object.keys(TABS) as Mode[]).map((value) => (
            <button
              key={value}
              className={tab === value ? "active" : ""}
              aria-pressed={tab === value}
              disabled={value === "review" && !review}
              onClick={() => show(value)}
            >
              {t(TABS[value])}
            </button>
          ))}
        </nav>
        <div className="git-content">
          {panel(
            "compare",
            <GitCompareTab
              base={base}
              storageKey={storageKey}
              selection={selection}
              ready={ready}
              branches={repository.branches}
              entity={entity}
              version={version}
              onSelect={setSelection}
            />,
          )}
          {panel(
            "branches",
            <GitBranchesTab
              worktree={worktree}
              base={base}
              canEdit={canEdit}
              preferMain={mode === "branches"}
              repository={repository}
              onCompare={compare}
              onReview={openReview}
              onChanged={changed}
              onOpenWorktree={openWorktree}
              onNewBranch={onNewBranch}
            />,
          )}
          {panel(
            "sync",
            <GitSyncTab
              base={base}
              role={role}
              storageKey={storageKey}
              repository={repository}
              onChanged={changed}
              onReview={openReview}
              onClose={onClose}
            />,
          )}
          {review &&
            panel(
              "review",
              <GitReviewTab
                key={review.id}
                review={review}
                worktree={worktree}
                base={base}
                canEdit={canEdit}
                storageKey={storageKey}
                onCancel={() => {
                  setReview(null);
                  show("branches");
                }}
                onChanged={changed}
              />,
            )}
        </div>
      </div>
    </Modal>
  );
}
