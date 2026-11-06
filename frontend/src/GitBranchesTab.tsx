import { useState } from "react";
import { api, send, withQuery } from "./api";
import { TabStatus, useTabAction, type Repository } from "./gitTabs";
import type { Branch, MergeReview } from "./gitTypes";
import { useT } from "./i18n";
import Select from "./Select";
import type { Worktree } from "./types";
import { useApiResource } from "./useApiResource";
import { useShell } from "./shell";
import { ConfirmModal } from "./modals";

export default function GitBranchesTab({
  worktree,
  base,
  canEdit,
  preferMain,
  repository,
  onCompare,
  onReview,
  onChanged,
  onOpenWorktree,
  onNewBranch,
}: {
  worktree: string;
  base: string;
  canEdit: boolean;
  /** Propose the main branch as the merge destination. */
  preferMain: boolean;
  repository: Repository;
  onCompare: (a: string, b: string) => void;
  onReview: (review: MergeReview) => void;
  onChanged: () => Promise<void>;
  onOpenWorktree: (id: string) => void;
  onNewBranch: () => void;
}) {
  const t = useT();
  const { notify } = useShell();
  const { pending, error, run, retry } = useTabAction();
  const { branches } = repository;
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [removing, setRemoving] = useState<Branch | null>(null);
  const sourceRef = source || branches.find((v) => v.current)?.ref || "";
  const destinationId =
    destination ||
    (preferMain && branches.find((v) => v.name === "main")?.worktree) ||
    worktree;
  const sourceBranch = branches.find((v) => v.ref === sourceRef);
  const destinationBranch = branches.find((v) => v.worktree === destinationId);
  const cleanup = useApiResource<Branch[]>(
    canEdit
      ? withQuery(`${base}/branches`, { integrated_worktree: destinationId })
      : null,
    { interval: 5000, refresh: JSON.stringify(branches) },
  );
  const cleanupReason = (item: Branch) => {
    if (item.name === "main") return t("branchCleanupMain");
    if (item.current) return t("branchCleanupCurrent");
    if (item.worktree === destinationId) return t("branchCleanupDestination");
    return item.cleanup_error;
  };

  return (
    <div className="git-branch-panel">
      <TabStatus
        error={repository.failure?.message}
        onRetry={repository.failure?.retry}
      />
      <TabStatus error={error} pending={pending} onRetry={retry} />
      <TabStatus error={cleanup.error} onRetry={cleanup.reload} />
      {!canEdit && <p className="notice">{t("gitReaderHint")}</p>}
      <div className="git-controls">
        <label>
          {t("sourceBranch")}{" "}
          <Select value={sourceRef} onChange={(e) => setSource(e.target.value)}>
            {branches.map((v) => (
              <option key={v.ref} value={v.ref}>
                {v.name}
                {v.remote ? ` (${t("remote")})` : ""}
              </option>
            ))}
          </Select>
        </label>
        <span>→</span>
        <label>
          {t("destinationBranch")}{" "}
          <Select
            value={destinationId}
            onChange={(e) => setDestination(e.target.value)}
          >
            {branches
              .filter(
                (v): v is Branch & { worktree: string } =>
                  !v.remote && !!v.worktree,
              )
              .map((v) => (
                <option key={v.ref} value={v.worktree}>
                  {v.name}
                </option>
              ))}
          </Select>
        </label>
        <button
          className="button secondary"
          disabled={!sourceBranch || !destinationBranch}
          onClick={() => onCompare(destinationBranch!.head, sourceBranch!.head)}
        >
          {t("compareVersions")}
        </button>
        <button
          className="button primary"
          disabled={
            !canEdit ||
            pending ||
            !sourceRef ||
            sourceBranch?.worktree === destinationId
          }
          onClick={() =>
            run(async () =>
              onReview(
                await api<MergeReview>(
                  `/worktrees/${destinationId}/git/reviews`,
                  send({ source: sourceRef }),
                ),
              ),
            )
          }
        >
          {t("reviewMerge")}
        </button>
      </div>
      <p className="muted">{t("reviewMergeHint")}</p>
      {(cleanup.data || branches).map((item) => (
        <div className="git-commit" key={item.ref}>
          <div>
            <strong>
              {item.name} {item.current ? `· ${t("current")}` : ""}
            </strong>
            <small>
              {item.remote ? t("remoteBranch") : t("localBranch")} ·{" "}
              {item.head.slice(0, 12)} · {t(item.state)}
              {item.upstream &&
                ` · origin/${item.upstream} · ${item.ahead ?? "—"} ↑ / ${item.behind ?? "—"} ↓`}
            </small>
            {!item.remote && canEdit && cleanupReason(item) && (
              <small>{cleanupReason(item)}</small>
            )}
          </div>
          <button
            className="button secondary small"
            onClick={() => onCompare("HEAD", item.head)}
          >
            {t("compareVersions")}
          </button>
          {!item.remote && !item.current && (
            <button
              className="button secondary small"
              disabled={pending || (!canEdit && !item.worktree)}
              onClick={() =>
                run(async () => {
                  const tree = item.worktree
                    ? { id: item.worktree }
                    : await api<Worktree>(
                        `${base}/open`,
                        send({ name: item.name }),
                      );
                  await onChanged();
                  onOpenWorktree(tree.id);
                })
              }
            >
              {t("openBranch")}
            </button>
          )}
          {!item.remote && (
            <button
              className="button secondary small"
              disabled={
                !canEdit ||
                pending ||
                cleanup.pending ||
                !!cleanup.error ||
                item.cleanup_error === undefined ||
                !!cleanupReason(item)
              }
              onClick={() => setRemoving(item)}
            >
              {t("delete")}
            </button>
          )}
        </div>
      ))}
      {removing && (
        <ConfirmModal
          title={t("deleteBranchNamed").replace("{name}", removing.name)}
          confirmLabel={t("delete")}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const tree = removing.worktree
              ? { id: removing.worktree }
              : await api<Worktree>(
                  `${base}/open`,
                  send({ name: removing.name }),
                );
            await api(
              `${base}/cleanup`,
              send({
                remove_worktree: tree.id,
                integrated_worktree: destinationId,
                expected_head: removing.head,
              }),
            );
            setRemoving(null);
            if (source === removing.ref) setSource("");
            notify(t("branchDeleted").replace("{name}", removing.name));
            cleanup.reload();
            await onChanged();
          }}
        >
          <p>{t("confirmDeleteBranch").replace("{name}", removing.name)}</p>
        </ConfirmModal>
      )}
      <div className="git-controls">
        <button
          className="button primary"
          disabled={!canEdit}
          onClick={onNewBranch}
        >
          {t("newBranch")}
        </button>
      </div>
    </div>
  );
}
