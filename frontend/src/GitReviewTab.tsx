import { useState } from "react";
import { api, send } from "./api";
import ComparisonView from "./ComparisonView";
import GitDataImpact from "./GitDataImpact";
import { TabStatus, useTabAction } from "./gitTabs";
import type { MergeChoice, MergeReview } from "./gitTypes";
import { useT } from "./i18n";
import {
  ConflictHeading,
  ConflictSummary,
  FieldConflictDiff,
  FileConflictDiff,
} from "./ConflictDiff";
import { conflictPath, conflictTitle } from "./conflicts";
import { useWorktree } from "./worktree";
import { useShell } from "./shell";

export default function GitReviewTab({
  review: proposal,
  canEdit,
  storageKey,
  onCancel,
  onChanged,
  onOpenWorktree,
}: {
  review: MergeReview;
  canEdit: boolean;
  storageKey: string;
  onCancel: () => void;
  onChanged: () => Promise<void>;
  onOpenWorktree: (id: string) => boolean;
}) {
  const t = useT();
  const { snapshot, environment, settle } = useWorktree();
  const { notify, refreshWorkspace } = useShell();
  const { pending, error, run, retry } = useTabAction();
  const [review, setReview] = useState(proposal);
  const [integrated, setIntegrated] = useState<MergeReview | null>(null);

  const choose = (path: string, choice: MergeChoice) => {
    const previous = review;
    const choices = { ...review.choices, [path]: choice };
    setReview({
      ...review,
      choices,
      conflicts: review.conflicts.map((item) =>
        item.path === path ? { ...item, choice } : item,
      ),
    });
    void run(async () => {
      try {
        setReview(
          await api<MergeReview>(
            `/worktrees/${review.worktree}/git/reviews/${review.id}`,
            send({ choices }),
          ),
        );
      } catch (e) {
        setReview(previous);
        throw e;
      }
    });
  };

  return (
    <div className="git-review-panel">
      <TabStatus error={error} pending={pending} onRetry={retry} />
      <h3>
        {review.source} → {review.destination}
      </h3>
      <details>
        <summary>{t("gitDetails")}</summary>
        <p>
          {t("commonBase")}: <code>{review.base_head.slice(0, 12)}</code> ·{" "}
          {t("incoming")}: <code>{review.source_head.slice(0, 12)}</code> ·{" "}
          {t("current")}: <code>{review.target_head.slice(0, 12)}</code>
        </p>
        <p className="muted">{t("reviewMergeHint")}</p>
      </details>
      {review.conflicts.length > 0 && (
        <section>
          <h3>
            {t("fieldConflicts")} · {review.unresolved.length} {t("unresolved")}
          </h3>
          <ConflictSummary conflicts={review.conflicts} />
          {review.conflicts.map((conflict) => (
            <fieldset className="git-conflict" key={conflict.path}>
              <legend>
                <ConflictHeading
                  path={conflict.path}
                  title={conflictTitle(
                    conflict.path,
                    t,
                    [snapshot?.files || {}],
                    review.comparison.entities,
                    review.node_names,
                  )}
                />
              </legend>
              {conflictPath(conflict.path).parts.length ? (
                <FieldConflictDiff
                  conflict={conflict}
                  disabled={pending || !!integrated}
                  onChoose={(choice) => choose(conflict.path, choice)}
                />
              ) : (
                <>
                  <FileConflictDiff
                    conflict={conflict}
                    file={conflictPath(conflict.path).file}
                  />
                  <div className="conflict-file-choices">
                    {(["base", "current", "incoming"] as const).map(
                      (choice) => (
                        <label key={choice}>
                          <input
                            type="radio"
                            name={conflict.path}
                            checked={conflict.choice === choice}
                            disabled={pending || !!integrated}
                            onChange={() => choose(conflict.path, choice)}
                          />{" "}
                          {t(choice)}
                        </label>
                      ),
                    )}
                  </div>
                </>
              )}
            </fieldset>
          ))}
        </section>
      )}
      {review.diagnostics.map((d, i) => (
        <p key={i} className="notice error">
          {d.file}: {d.message}
        </p>
      ))}
      <ComparisonView
        report={review.comparison}
        storageKey={storageKey + ".reviewFilters"}
      />
      {/* Only processing changes on local branches have retained results to compare. */}
      {!integrated &&
        review.source_worktree &&
        review.comparison.impact.direct.length > 0 && (
          <GitDataImpact review={review} environment={environment} />
        )}
      {!integrated ? (
        <div className="git-controls">
          <button className="button secondary" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button
            className="button primary"
            disabled={
              pending ||
              !canEdit ||
              review.unresolved.length > 0 ||
              review.diagnostics.length > 0
            }
            onClick={() =>
              run(async () => {
                await api(
                  `/worktrees/${review.worktree}/git/reviews/${review.id}/apply`,
                  send({
                    choices: review.choices,
                    proposal_revision: review.proposal_revision,
                  }),
                );
                setIntegrated(review);
                await onChanged();
              })
            }
          >
            {t("applyReviewedMerge")}
          </button>
          <span className="muted">
            {review.unresolved.length > 0
              ? t("resolveBeforeApply")
              : review.diagnostics.length > 0
                ? t("fixBeforeApply")
                : t("noImplicitExecution")}
          </span>
        </div>
      ) : (
        <div className="notice">
          <p>{t("mergeComplete")}</p>
          {integrated.source_worktree && integrated.source !== "main" && (
            <button
              className="button secondary"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await settle();
                  // Leave the source before deleting it, including its snapshot polling.
                  if (!onOpenWorktree(integrated.worktree)) return;
                  try {
                    await api(
                      `/worktrees/${integrated.worktree}/git/cleanup`,
                      send({
                        remove_worktree: integrated.source_worktree,
                        integrated_worktree: integrated.worktree,
                        expected_head: integrated.source_head,
                      }),
                    );
                    notify(
                      t("branchDeleted").replace("{name}", integrated.source),
                    );
                    await refreshWorkspace();
                  } catch (error) {
                    // The dialog is now closed; keep failures visible on the destination.
                    notify(
                      t("branchKept")
                        .replace("{name}", integrated.source)
                        .replace("{reason}", (error as Error).message),
                      true,
                    );
                  }
                })
              }
            >
              {t("deleteBranchNamed").replace("{name}", integrated.source)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
