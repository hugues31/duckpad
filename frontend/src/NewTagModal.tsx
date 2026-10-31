import { useRef, useState } from "react";
import { api, send } from "./api";
import type { GitTag } from "./gitTypes";
import { useT } from "./i18n";
import { Modal } from "./modals";
import { useAsyncAction } from "./useAsyncAction";

export default function NewTagModal({
  worktree,
  commit,
  onCreated,
  onClose,
}: {
  worktree: string;
  commit: string;
  onCreated: (tag: GitTag) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const { pending, error, run } = useAsyncAction();
  const submitting = useRef(false);
  return (
    <Modal title={t("createTag")} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          await run(async () => {
            const tag = await api<GitTag>(
              `/worktrees/${worktree}/git/tags`,
              send({ name, commit, message }),
            );
            onCreated(tag);
            onClose();
          });
          submitting.current = false;
        }}
      >
        <div className="modal-content">
          <p>{t("immutableTagHint")}</p>
          <p>
            {t("commit")}: <code>{commit}</code>
          </p>
          <label>
            {t("tagName")}
            <input
              data-autofocus
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="sales/2026.10.31"
            />
          </label>
          <label>
            {t("tagMessage")}
            <textarea
              required
              maxLength={10000}
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="button primary"
            disabled={pending || !name || !message.trim()}
          >
            {t(pending ? "loading" : "createTag")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
