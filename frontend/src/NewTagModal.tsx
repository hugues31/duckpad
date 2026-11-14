import { useState } from "react";
import { api, send } from "./api";
import type { GitTag } from "./gitTypes";
import { useT } from "./i18n";
import { ModalForm } from "./modals";

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
  return (
    <ModalForm
      title={t("createTag")}
      onClose={onClose}
      submitLabel={t("createTag")}
      pendingLabel="loading"
      disabled={!name || !message.trim()}
      onSubmit={async () => {
        const tag = await api<GitTag>(
          `/worktrees/${worktree}/git/tags`,
          send({ name, commit, message }),
        );
        onCreated(tag);
      }}
    >
      <p>{t("immutableTagHint")}</p>
      <p>
        {t("commit")}: <code>{commit}</code>
      </p>
      <label className="field">
        <span>{t("tagName")}</span>
        <input
          data-autofocus
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="sales/2026.10.31"
        />
      </label>
      <label className="field">
        <span>{t("tagMessage")}</span>
        <textarea
          required
          maxLength={10000}
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
    </ModalForm>
  );
}
