import { Tag } from "lucide-react";
import type { GitTag } from "./gitTypes";
import { useT } from "./i18n";

/** A tag name, with its description when the caller has it. */
export type TagLabel = Pick<GitTag, "name"> & Partial<Pick<GitTag, "message">>;

export default function TagBadges({ tags = [] }: { tags?: TagLabel[] }) {
  const t = useT();
  return tags.length ? (
    <span className="tag-badges" aria-label={t("tags")}>
      {tags.map((tag) => (
        <span
          className="tag-badge"
          key={tag.name}
          title={tag.message || undefined}
        >
          <Tag size={12} aria-hidden="true" />
          {tag.name}
        </span>
      ))}
    </span>
  ) : null;
}
