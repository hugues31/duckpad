import { useState } from "react";
import { api, send } from "./api";
import { TabStatus, useTabAction, type Repository } from "./gitTabs";
import { useT } from "./i18n";
import Select from "./Select";
import type { Json } from "./types";

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
  onReview: (review: Json) => void;
  onChanged: () => Promise<void>;
  onOpenWorktree: (id: string) => void;
  onNewBranch: () => void;
}) {
  const t = useT();
  const { pending, error, run, retry } = useTabAction();
  const { branches } = repository;
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const sourceRef = source || branches.find((v) => v.current)?.ref || "";
  const destinationId =
    destination ||
    (preferMain && branches.find((v) => v.name === "main")?.worktree) ||
    worktree;
  const sourceBranch = branches.find((v) => v.ref === sourceRef);
  const destinationBranch = branches.find((v) => v.worktree === destinationId);

  return (
    <div className="git-branch-panel">
      <TabStatus
        error={repository.failure?.message}
        onRetry={repository.failure?.retry}
      />
      <TabStatus error={error} pending={pending} onRetry={retry} />
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
              .filter((v) => !v.remote && v.worktree)
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
                await api<Json>(
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
      {branches.map((item) => (
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
                    : await api(`${base}/open`, send({ name: item.name }));
                  await onChanged();
                  onOpenWorktree(tree.id);
                })
              }
            >
              {t("openBranch")}
            </button>
          )}
        </div>
      ))}
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
