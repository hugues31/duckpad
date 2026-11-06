import { useState } from "react";
import { api, send } from "./api";
import {
  ConflictHeading,
  ConflictSummary,
  FieldConflictDiff,
  FileConflictDiff,
} from "./ConflictDiff";
import {
  combinedFiles,
  conflictDrafts,
  conflictPath,
  conflictTitle,
  valueText,
} from "./conflicts";
import { useT, type Translate } from "./i18n";
import { Modal } from "./modals";
import { useShell } from "./shell";
import type { Conflict } from "./types";
import { useAsyncAction } from "./useAsyncAction";
import { useWorktree } from "./worktree";

/** Name both sides as the resolution buttons do. */
const saveLabels = (t: Translate) => ({
  current: t("fileVersion"),
  incoming: t("myProposal"),
});

export function ConflictDialog({
  conflict,
  onClose,
}: {
  conflict: Conflict;
  onClose: () => void;
}) {
  const t = useT();
  const labels = saveLabels(t);
  const { openModal } = useShell();
  const { id, refresh } = useWorktree();
  const { pending, error, run } = useAsyncAction();
  const choose = async (choice: "current" | "proposal") => {
    if (
      await run(async () => {
        try {
          await api(`/conflicts/${conflict.id}/resolve`, send({ choice }));
        } finally {
          await refresh();
        }
      })
    )
      onClose();
  };
  return (
    <Modal title={t("conflict")} onClose={onClose} wide>
      <div className="modal-content conflict-content">
        <ConflictSummary conflicts={conflict.fields} />
        <p className="muted">{t("conflictHint")}</p>
        {conflict.fields.map((field) => {
          const { file, parts } = conflictPath(field.path);
          return (
            <section className="conflict-card" key={field.path}>
              <h3>
                <ConflictHeading
                  path={field.path}
                  title={conflictTitle(
                    field.path,
                    t,
                    [conflict.current, conflict.proposal, conflict.base],
                    [],
                    conflict.node_names,
                  )}
                />
              </h3>
              {parts.length ? (
                <FieldConflictDiff conflict={field} labels={labels} />
              ) : (
                <FileConflictDiff
                  conflict={field}
                  file={file}
                  labels={labels}
                />
              )}
            </section>
          );
        })}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer>
        <button
          className="button secondary"
          disabled={pending}
          onClick={() =>
            openModal({
              kind: "combinedResolution",
              worktree: id,
              conflict: conflict.id,
            })
          }
        >
          {t("combined")}
        </button>
        {(["current", "proposal"] as const).map((choice) => (
          <button
            key={choice}
            className={`button ${choice === "proposal" ? "primary" : "secondary"}`}
            disabled={pending}
            onClick={() => choose(choice)}
          >
            {t(choice === "current" ? "keepCurrent" : "keepProposal")}
          </button>
        ))}
      </footer>
    </Modal>
  );
}

export function CombinedResolutionDialog({
  conflict,
  onClose,
}: {
  conflict: Conflict;
  onClose: () => void;
}) {
  const t = useT();
  const labels = saveLabels(t);
  const { openModal } = useShell();
  const { id, refresh } = useWorktree();
  const [base] = useState(conflict);
  const [drafts, setDrafts] = useState(() => conflictDrafts(conflict));
  const { pending, error, run } = useAsyncAction();
  const stale = base.revision !== conflict.revision;
  const review = () =>
    openModal({ kind: "conflict", worktree: id, conflict: conflict.id });
  const save = async () => {
    if (
      await run(async () => {
        let files: Record<string, string>;
        try {
          files = combinedFiles(base, drafts);
        } catch {
          throw new Error(t("conflictInvalidValue"));
        }
        try {
          await api(
            `/conflicts/${base.id}/resolve`,
            send({ choice: "combined", files }),
          );
        } finally {
          await refresh();
        }
      })
    )
      onClose();
  };
  return (
    <Modal title={t("combined")} onClose={onClose} wide>
      <div className="modal-content conflict-content">
        <ConflictSummary conflicts={base.fields} />
        <p className="muted">{t("combinedConflictHint")}</p>
        {base.fields.map((field) => {
          const { file, parts } = conflictPath(field.path);
          const draft = drafts[field.path];
          const title = conflictTitle(
            field.path,
            t,
            [base.current, base.proposal, base.base],
            [],
            base.node_names,
          );
          const update = (change: Partial<typeof draft>) =>
            setDrafts((old) => ({
              ...old,
              [field.path]: { ...old[field.path], ...change },
            }));
          return (
            <section className="conflict-card" key={field.path}>
              <h3>
                <ConflictHeading title={title} path={field.path} />
              </h3>
              {parts.length ? (
                <>
                  <FieldConflictDiff conflict={field} labels={labels} />
                  <label className="conflict-result">
                    {t("combinedValue")}
                    <textarea
                      aria-label={`${title} · ${t("combinedValue")}`}
                      value={draft.text}
                      disabled={!draft.present || pending || stale}
                      onChange={(event) => update({ text: event.target.value })}
                    />
                  </label>
                </>
              ) : (
                <FileConflictDiff
                  conflict={field}
                  file={file}
                  labels={labels}
                  text={draft.text}
                  onChange={
                    draft.present && !pending && !stale
                      ? (text) => update({ text })
                      : undefined
                  }
                />
              )}
              {(!field.current.present || !field.incoming.present) && (
                <label className="conflict-presence">
                  <input
                    type="checkbox"
                    checked={draft.present}
                    disabled={pending || stale}
                    onChange={(event) =>
                      update({
                        present: event.target.checked,
                        // Keeping content deleted by the proposal starts from the saved version.
                        ...(event.target.checked &&
                          !draft.text && { text: valueText(field.current) }),
                      })
                    }
                  />{" "}
                  {t("conflictKeepContent")}
                </label>
              )}
            </section>
          );
        })}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {stale && (
          <div className="notice" role="status">
            {t("conflictRefreshed")}
          </div>
        )}
      </div>
      <footer>
        <button
          className="button secondary"
          onClick={review}
          disabled={pending}
        >
          {stale ? t("reviewChanges") : t("cancel")}
        </button>
        <button
          className="button primary"
          onClick={save}
          disabled={pending || stale}
        >
          {t("save")}
        </button>
      </footer>
    </Modal>
  );
}
