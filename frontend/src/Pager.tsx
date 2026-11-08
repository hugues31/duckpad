import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "./i18n";

export default function Pager({
  offset,
  total,
  pageSize,
  onOffset,
  disabled = false,
  count,
  className = "row",
  between = false,
}: {
  offset: number;
  total: number;
  pageSize: number;
  onOffset: (offset: number) => void;
  disabled?: boolean;
  count?: ReactNode;
  className?: string;
  between?: boolean;
}) {
  const t = useT();
  const label = (
    <span>
      {total ? `${offset + 1}–${Math.min(offset + pageSize, total)}` : "0"} /{" "}
      {count ?? total.toLocaleString()}
    </span>
  );
  return (
    <div className={className}>
      {!between && label}
      <button
        type="button"
        className="icon"
        disabled={disabled || offset === 0}
        title={t("previous")}
        aria-label={t("previous")}
        onClick={() => onOffset(Math.max(0, offset - pageSize))}
      >
        <ChevronLeft size={15} />
      </button>
      {between && label}
      <button
        type="button"
        className="icon"
        disabled={disabled || offset + pageSize >= total}
        title={t("next")}
        aria-label={t("next")}
        onClick={() => onOffset(offset + pageSize)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
