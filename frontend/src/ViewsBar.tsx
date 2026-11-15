import { Bookmark, Plus, X } from "lucide-react";
import { useT } from "./i18n";
import { ALL_ROWS, sameSample, type Sample, type View } from "./samples";
import { useAsyncAction } from "./useAsyncAction";

export function ViewsBar({
  views,
  active,
  sample,
  canEdit,
  onSelect,
  onSave,
  onDelete,
}: {
  views: View[];
  active?: string;
  sample: Sample;
  canEdit: boolean;
  onSelect: (sample: Sample) => void;
  onSave: () => void;
  onDelete: (name: string) => Promise<unknown>;
}) {
  const t = useT();
  const remove = useAsyncAction();
  const current = views.find((item) => item.name === active);
  const allRows = !current && sameSample(sample, ALL_ROWS);
  return (
    <div className="views-bar" role="group" aria-label={t("sharedViews")}>
      <button
        className={`view-chip ${allRows ? "active" : ""}`}
        aria-pressed={allRows}
        onClick={() => onSelect(ALL_ROWS)}
      >
        {t("allRows")}
      </button>
      {views.map((item) => {
        const selected =
          current?.name === item.name && sameSample(item, sample);
        return (
          <span
            key={item.name}
            className={`view-chip ${selected ? "active" : ""}`}
          >
            <button
              aria-pressed={selected}
              onClick={() => onSelect(item)}
              title={item.filter || item.name}
            >
              <Bookmark size={11} aria-hidden="true" />
              {item.name}
            </button>
            {canEdit && (
              <button
                className="icon"
                title={t("deleteView")}
                aria-label={`${t("deleteView")}: ${item.name}`}
                disabled={remove.pending}
                onClick={() => remove.run(() => onDelete(item.name))}
              >
                <X size={10} />
              </button>
            )}
          </span>
        );
      })}
      {canEdit && !allRows && !(current && sameSample(current, sample)) && (
        <button className="text-button" onClick={onSave}>
          <Plus size={12} aria-hidden="true" />
          {t("saveView")}
        </button>
      )}
      {remove.error && (
        <span className="notice error small">{remove.error}</span>
      )}
    </div>
  );
}
