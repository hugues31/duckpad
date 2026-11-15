import { Loader2, Play, type LucideIcon } from "lucide-react";
import type { AriaRole, ReactNode } from "react";
import { useT } from "./i18n";
import { partitionMessage } from "./partitions";
import type { RunState } from "./results";

/** A results tab with nothing to show: an icon, a title, a hint and an action. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  role,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  role?: AriaRole;
  children?: ReactNode;
}) {
  return (
    <div className="preview-empty" role={role}>
      <Icon size={25} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * The results of an output that has none yet: why, when the preview or a
 * blocked collector tells, and a Run hint with its button.
 */
export default function NoResult({
  icon,
  error,
  all,
  run: { canEdit, active, starting = false, onRun, runLabel, hint, reason },
}: {
  icon: LucideIcon;
  /** The preview error, if any. */
  error?: string;
  /** No single partition key is selected. */
  all: boolean;
  run: RunState;
}) {
  const t = useT();
  const message = error || reason || "";
  const explained = partitionMessage(t, message, all);
  return (
    <EmptyState
      icon={icon}
      title={explained || t("noResult")}
      // A translated partition message already says what to run.
      hint={
        !canEdit || explained === message
          ? canEdit
            ? hint || t("noResultHint")
            : t("readerNoResult")
          : undefined
      }
    >
      <button
        className="button secondary small"
        disabled={!canEdit || active || starting}
        aria-busy={starting}
        onClick={onRun}
      >
        {starting ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
        {runLabel || t("runNode")}
      </button>
    </EmptyState>
  );
}
