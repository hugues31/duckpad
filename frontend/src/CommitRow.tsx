import type { ReactNode } from "react";
import { GitCommitHorizontal, Tag } from "lucide-react";
import type { Commit } from "./gitTypes";
import { useT } from "./i18n";
import TagBadges, { type TagLabel } from "./TagBadges";

export default function CommitRow({
  commit,
  tags = commit.tags?.map((name) => ({ name })),
  children,
  comparison = false,
}: {
  commit: Commit;
  tags?: TagLabel[];
  children: ReactNode;
  comparison?: boolean;
}) {
  const t = useT();
  const tagged = !!tags?.length;
  const described = (tags || []).filter((tag) => tag.message?.trim());
  return (
    <div
      className={
        comparison ? "git-commit" : `history-row${tagged ? " tagged" : ""}`
      }
    >
      {!comparison &&
        (tagged ? (
          <span className="history-icon tag">
            <Tag size={16} aria-hidden="true" />
          </span>
        ) : (
          <span className="history-icon commit">
            <GitCommitHorizontal size={18} aria-hidden="true" />
          </span>
        ))}
      <div className={comparison ? undefined : "grow"}>
        <div className="commit-title">
          <strong>{commit.message}</strong>
          <TagBadges tags={tags} />
        </div>
        <small>
          {commit.author}
          {commit.assistant ? ` ${t("assistantAttribution")}` : ""} ·{" "}
          {new Date(commit.date).toLocaleString()} ·{" "}
          {commit.commit.slice(0, comparison ? 12 : 8)}
        </small>
        {!comparison &&
          described.map((tag) => (
            <p className="tag-description" key={tag.name} title={tag.message}>
              {described.length > 1 && <strong>{tag.name}</strong>}
              {tag.message}
            </p>
          ))}
      </div>
      {children}
    </div>
  );
}
