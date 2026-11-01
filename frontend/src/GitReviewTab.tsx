import { useState } from "react";
import { api, send } from "./api";
import ComparisonView from "./ComparisonView";
import { TabStatus, useTabAction } from "./gitTabs";
import type { MergeChoice, MergeReview } from "./gitTypes";
import { useT } from "./i18n";
import { conflictLabel } from "./variables";

export default function GitReviewTab({
  review: proposal,
  worktree,
  base,
  canEdit,
  storageKey,
  onCancel,
  onChanged,
}: {
  review: MergeReview;
  worktree: string;
  base: string;
  canEdit: boolean;
  storageKey: string;
  onCancel: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
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
      <p>
        {t("commonBase")}: <code>{review.base_head.slice(0, 12)}</code> ·{" "}
        {t("incoming")}: <code>{review.source_head.slice(0, 12)}</code> ·{" "}
        {t("current")}: <code>{review.target_head.slice(0, 12)}</code>
      </p>
      <p className="muted">{t("reviewMergeHint")}</p>
      {review.conflicts.length > 0 && (
        <section>
          <h3>
            {t("fieldConflicts")} · {review.unresolved.length} {t("unresolved")}
          </h3>
          {review.conflicts.map((conflict) => (
            <fieldset className="git-conflict" key={conflict.path}>
              <legend>
                {conflictLabel(conflict.path, t) ?? conflict.path}
                {conflictLabel(conflict.path, t) && (
                  <code className="muted">{conflict.path}</code>
                )}
              </legend>
              <div className="git-conflict-values">
                {(["base", "current", "incoming"] as const).map((choice) => (
                  <label key={choice}>
                    <span>
                      <input
                        type="radio"
                        name={conflict.path}
                        checked={conflict.choice === choice}
                        disabled={pending || !!integrated}
                        onChange={() => choose(conflict.path, choice)}
                      />{" "}
                      {t(choice)}
                    </span>
                    <pre>
                      {conflict[choice].present
                        ? typeof conflict[choice].value === "string"
                          ? conflict[choice].value
                          : JSON.stringify(conflict[choice].value, null, 2)
                        : t("absent")}
                    </pre>
                  </label>
                ))}
              </div>
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
          {integrated.source_worktree &&
            integrated.source_worktree !== worktree &&
            integrated.source !== "main" && (
              <button
                className="button secondary"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await api(
                      `${base}/cleanup`,
                      send({
                        remove_worktree: integrated.source_worktree,
                        integrated_worktree: integrated.worktree,
                        expected_head: integrated.source_head,
                      }),
                    );
                    setIntegrated({ ...integrated, source_worktree: null });
                    await onChanged();
                  })
                }
              >
                {t("removeIntegratedBranch")} {integrated.source}
              </button>
            )}
        </div>
      )}
    </div>
  );
}
