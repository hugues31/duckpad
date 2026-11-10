import {
  Ban,
  Boxes,
  Code2,
  Copy,
  Link,
  Loader2,
  Play,
  Trash2,
  Unlink,
} from "lucide-react";
import type { ActionItem } from "./ActionMenu";
import { useT } from "./i18n";

/** Keep node commands visible while the inspector's fields scroll. */
export default function InspectorActions({
  actions,
  component,
  starting,
  runDisabled,
  onRun,
}: {
  actions: ActionItem[];
  component: boolean;
  starting: boolean | undefined;
  runDisabled: boolean;
  onRun: () => void;
}) {
  const t = useT();
  const edit = actions.find((action) => action.id === "edit")!;
  const remove = actions.find((action) => action.id === "remove")!;
  const EditIcon = component ? Boxes : Code2;
  return (
    <div
      className="inspector-actions"
      role="group"
      aria-label={t("nodeActions")}
    >
      <div className="inspector-primary-actions">
        <button
          className="button primary small"
          disabled={edit.disabled}
          onClick={edit.run}
        >
          <EditIcon size={15} aria-hidden="true" />
          {edit.label}
        </button>
        <button
          className="icon danger"
          title={remove.label}
          aria-label={remove.label}
          disabled={remove.disabled}
          onClick={remove.run}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="inspector-secondary-actions">
        <button
          className="button secondary small"
          disabled={runDisabled}
          aria-busy={starting}
          onClick={onRun}
        >
          {starting ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          {t("runNode")}
        </button>
        {actions
          .filter((action) => !["edit", "remove"].includes(action.id))
          .map((action) => {
            const Icon =
              action.id === "duplicate"
                ? Copy
                : action.id === "mute"
                  ? Ban
                  : action.id === "detach"
                    ? Unlink
                    : Link;
            return (
              <button
                key={action.id}
                className="button secondary small"
                disabled={action.disabled}
                onClick={action.run}
              >
                <Icon size={14} aria-hidden="true" />
                {action.label}
              </button>
            );
          })}
      </div>
    </div>
  );
}
