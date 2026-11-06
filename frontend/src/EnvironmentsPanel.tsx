import { useState } from "react";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { ConfirmModal, Modal } from "./modals";
import type { Environment } from "./types";
import { useAsyncAction } from "./useAsyncAction";

export default function EnvironmentsPanel({
  environments,
  refresh,
}: {
  environments: Environment[];
  refresh: () => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState<Environment | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const { pending, error, setError, run } = useAsyncAction();
  function edit(environment: Environment, create = false) {
    setCreating(create);
    setEditing(environment);
    setError("");
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <h2>{t("environments")}</h2>
          <p className="muted">{t("instanceEnvironmentsHint")}</p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            edit(
              {
                id: "",
                label: "",
                color: "#31a878",
                confirm_before_run: false,
              },
              true,
            )
          }
        >
          <Plus size={16} />
          {t("addEnvironment")}
        </button>
      </div>
      <div className="environment-list">
        {environments.map((environment) => (
          <article
            className="environment-card"
            key={environment.id}
            aria-label={environment.label}
          >
            <span
              className="env-dot"
              style={{ background: environment.color }}
            />
            <div className="grow">
              <strong>{environment.label}</strong>
              <code>{environment.id}</code>
              <span className="environment-policy">
                {environment.confirm_before_run && <ShieldCheck size={14} />}
                {t(
                  environment.confirm_before_run
                    ? "confirmEveryRun"
                    : "runWithoutConfirmation",
                )}
              </span>
            </div>
            <button
              className="button secondary small"
              aria-label={`${t("edit")} · ${environment.label}`}
              onClick={() => edit(environment)}
            >
              <Pencil size={14} />
              {t("edit")}
            </button>
            <button
              className="icon danger"
              aria-label={`${t("delete")} · ${environment.label}`}
              title={
                environments.length === 1
                  ? t("keepOneEnvironment")
                  : t("deleteEnvironment")
              }
              disabled={environments.length === 1}
              onClick={() => setDeleting(environment)}
            >
              <Trash2 size={16} />
            </button>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          title={t(creating ? "addEnvironment" : "editEnvironment")}
          onClose={() => {
            if (!pending) setEditing(null);
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              if (
                await run(async () => {
                  await api(
                    creating
                      ? "/environments"
                      : `/environments/${encodeURIComponent(editing.id)}`,
                    send(editing, creating ? "POST" : "PUT"),
                  );
                  await refresh();
                })
              )
                setEditing(null);
            }}
          >
            <div className="modal-content">
              <label className="field">
                <span>{t("identifier")}</span>
                <input
                  aria-label={t("identifier")}
                  aria-describedby="environment-identifier-hint"
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9_-]*"
                  maxLength={64}
                  disabled={!creating || pending}
                  value={editing.id}
                  onChange={(event) =>
                    setEditing({ ...editing, id: event.target.value })
                  }
                />
                <small className="muted" id="environment-identifier-hint">
                  {t("environmentIdentifierHint")}
                </small>
              </label>
              <label className="field">
                <span>{t("environmentLabel")}</span>
                <input
                  required
                  maxLength={80}
                  disabled={pending}
                  value={editing.label}
                  onChange={(event) =>
                    setEditing({ ...editing, label: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("environmentColor")}</span>
                <input
                  className="environment-color"
                  type="color"
                  disabled={pending}
                  value={editing.color}
                  onChange={(event) =>
                    setEditing({ ...editing, color: event.target.value })
                  }
                />
              </label>
              <label className="environment-toggle">
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={editing.confirm_before_run}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      confirm_before_run: event.target.checked,
                    })
                  }
                />
                {t("confirmEveryRun")}
              </label>
              <p className="muted small">{t("environmentConfirmationHint")}</p>
              {creating && (
                <p className="muted small">{t("environmentConnectionHint")}</p>
              )}
              {error && (
                <div className="notice error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => setEditing(null)}
              >
                {t("cancel")}
              </button>
              <button className="button primary" disabled={pending}>
                {t(pending ? "saving" : "save")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {deleting && (
        <ConfirmModal
          title={t("deleteEnvironment")}
          confirmLabel={t("delete")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/environments/${encodeURIComponent(deleting.id)}`, {
              method: "DELETE",
            });
            await refresh();
          }}
        >
          <p>
            <strong>{deleting.label}</strong> ({deleting.id})
          </p>
          <p>{t("deleteEnvironmentHint")}</p>
        </ConfirmModal>
      )}
    </section>
  );
}
