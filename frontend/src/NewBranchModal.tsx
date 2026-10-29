import { useEffect, useRef, useState } from "react";
import { GitCommitHorizontal, Loader2 } from "lucide-react";
import { api, withQuery } from "./api";
import { useLanguage, useT } from "./i18n";
import { Modal } from "./modals";
import Select from "./Select";
import { useAsyncAction } from "./useAsyncAction";
import "./branch.css";

interface Revision {
  commit: string;
  message: string;
  author: string;
  date: string;
}
interface History {
  items: Revision[];
  head: string;
  next: number | null;
}

export default function NewBranchModal({
  worktree,
  branch,
  revision = "",
  submit,
  onClose,
}: {
  worktree: string;
  branch: string;
  revision?: string;
  submit: (name: string, revision?: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const [name, setName] = useState("");
  const [mode, setMode] = useState(revision ? "history" : "current");
  const [reference, setReference] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [reload, setReload] = useState(0);
  const { pending, error, run } = useAsyncAction();
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const base = `/worktrees/${worktree}/git/history`;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setHistoryError("");
    void (async () => {
      try {
        const result = await api<History>(base);
        let initial = result.items.find((item) => item.commit === revision);
        if (revision && !initial) {
          const older = await api<History>(
            withQuery(base, { ref: revision, limit: 1 }),
          );
          initial = older.items[0];
        }
        if (live) {
          setHistory(result);
          setSelected((previous) => previous || initial || null);
        }
      } catch (e) {
        if (live) setHistoryError((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [base, revision, reload]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = form.current?.closest<HTMLElement>("[role=dialog]");
    form.current
      ?.querySelector<HTMLInputElement>('input[name="branch-name"]')
      ?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ];
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", trapFocus);
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  async function loadMore() {
    if (!history || history.next === null || loading) return;
    setLoading(true);
    setHistoryError("");
    try {
      const result = await api<History>(
        withQuery(base, { ref: history.head, offset: history.next }),
      );
      setHistory({ ...result, items: [...history.items, ...result.items] });
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const search = query.trim().toLocaleLowerCase(language);
  const revisions =
    history?.items.filter((item) =>
      [item.message, item.author, item.commit].some((value) =>
        value.toLocaleLowerCase(language).includes(search),
      ),
    ) || [];
  const valid =
    name.trim() &&
    (mode === "current" || (mode === "history" ? selected : reference.trim()));
  const metadata = (item: Revision) => (
    <small>
      {item.author} ·{" "}
      <time dateTime={item.date}>
        {new Date(item.date).toLocaleString(language)}
      </time>{" "}
      · <code>{item.commit.slice(0, 8)}</code>
    </small>
  );

  return (
    <Modal
      title={t("newBranch")}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
    >
      <form
        ref={form}
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || !valid) return;
          submitting.current = true;
          const created = await run(() =>
            submit(
              name.trim(),
              mode === "current"
                ? undefined
                : mode === "history"
                  ? selected!.commit
                  : reference.trim(),
            ),
          );
          submitting.current = false;
          if (created) onClose();
        }}
      >
        <div className="modal-content new-branch-content">
          <label className="field">
            <span>{t("branchName")}</span>
            <input
              name="branch-name"
              required
              placeholder="experiment/my-change"
              aria-describedby="branch-name-hint"
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="muted" id="branch-name-hint">
            {t("branchNameHint")}
          </p>
          <label className="field">
            <span>{t("startingRevision")}</span>
            <Select
              value={mode}
              disabled={pending}
              onChange={(event) => setMode(event.target.value)}
              aria-describedby="branch-start-hint"
            >
              <option value="current">
                {t("branchLatest")} · {branch}
              </option>
              <option value="history">{t("branchChooseHistory")}</option>
              <option value="custom">{t("branchCustomReference")}</option>
            </Select>
          </label>
          <p className="muted" id="branch-start-hint">
            {t(
              mode === "current"
                ? "branchLatestHint"
                : mode === "history"
                  ? "branchHistoryHint"
                  : "branchReferenceHint",
            )}
          </p>
          {mode === "history" && (
            <>
              <label className="field">
                <span>{t("branchSearchHistory")}</span>
                <input
                  type="search"
                  value={query}
                  disabled={pending}
                  placeholder={t("branchSearchPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <fieldset className="branch-revisions" disabled={pending}>
                <legend>
                  {t("branchHistoryOf")} {branch}
                </legend>
                <div className="branch-revision-list">
                  {revisions.map((item) => (
                    <label className="branch-revision" key={item.commit}>
                      <input
                        type="radio"
                        name="branch-revision"
                        checked={selected?.commit === item.commit}
                        onChange={() => setSelected(item)}
                        aria-label={`${item.message} · ${item.commit.slice(0, 8)}`}
                      />
                      <span>
                        <strong>{item.message}</strong>
                        {metadata(item)}
                      </span>
                    </label>
                  ))}
                  {!loading && !historyError && !revisions.length && (
                    <p className="muted" role="status">
                      {t("branchNoRevisions")}
                    </p>
                  )}
                </div>
              </fieldset>
              {loading && (
                <p className="branch-loading muted" role="status">
                  <Loader2 size={16} className="spin" />
                  {t("loading")}
                </p>
              )}
              {historyError && (
                <div className="notice error" role="alert">
                  <p>{t("branchHistoryError")}</p>
                  <p>{historyError}</p>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={loading || pending}
                    onClick={() =>
                      history
                        ? void loadMore()
                        : setReload((value) => value + 1)
                    }
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
              {history?.next !== null && history && !historyError && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={loading || pending}
                  onClick={() => void loadMore()}
                >
                  {t("loadMore")}
                </button>
              )}
              {selected && (
                <div className="branch-selected" role="status">
                  <GitCommitHorizontal size={18} aria-hidden="true" />
                  <span>
                    <small>{t("branchSelectedRevision")}</small>
                    <strong>{selected.message}</strong>
                    {metadata(selected)}
                  </span>
                </div>
              )}
            </>
          )}
          {mode === "custom" && (
            <label className="field">
              <span>{t("branchReference")}</span>
              <input
                value={reference}
                required
                disabled={pending}
                placeholder="main, v1.0, a1b2c3d"
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
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
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending || !valid}>
            {pending && <Loader2 size={16} className="spin" />}
            {t(pending ? "saving" : "create")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
