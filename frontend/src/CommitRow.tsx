import type { ReactNode } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { Commit } from "./gitTypes";
import { useT } from "./i18n";
import TagBadges from "./TagBadges";

export default function CommitRow({
  commit,
  tags = commit.tags,
  children,
  comparison = false,
}: {
  commit: Commit;
  tags?: string[];
  children: ReactNode;
  comparison?: boolean;
}) {
  const t = useT();
  return (
    <div className={comparison ? "git-commit" : "history-row"}>
      {!comparison && <GitCommitHorizontal size={21} />}
      <div className={comparison ? undefined : "grow"}>
        <strong>{commit.message}</strong>
        <TagBadges names={tags} />
        <small>
          {commit.author}
          {commit.assistant ? ` ${t("assistantAttribution")}` : ""} ·{" "}
          {new Date(commit.date).toLocaleString()} ·{" "}
          {commit.commit.slice(0, comparison ? 12 : 8)}
        </small>
      </div>
      {children}
    </div>
  );
}
