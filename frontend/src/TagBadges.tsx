import { Tag } from "lucide-react";
import { useT } from "./i18n";

export default function TagBadges({ names = [] }: { names?: string[] }) {
  const t = useT();
  return names.length ? (
    <span className="row gap" aria-label={t("tags")}>
      {names.map((name) => (
        <span className="badge" key={name}>
          <Tag size={12} aria-hidden="true" /> {name}
        </span>
      ))}
    </span>
  ) : null;
}
