import { Loader2, Play } from "lucide-react";
import { useT } from "./i18n";
import type { NodeAction } from "./nodeActions";

/**
 * The selected node's commands, above the inspector's tabs: its main action as
 * a button, then running and the other actions as one row of named icons.
 */
export default function InspectorActions({
  actions: [main, ...others],
  starting,
  runDisabled,
  onRun,
}: {
  actions: NodeAction[];
  starting: boolean | undefined;
  runDisabled: boolean;
  onRun: () => void;
}) {
  const t = useT();
  return (
    <div
      className="inspector-actions"
      role="group"
      aria-label={t("nodeActions")}
    >
      <button
        className="button primary small"
        disabled={main.disabled}
        onClick={main.run}
      >
        <main.icon size={15} aria-hidden="true" />
        {main.label}
      </button>
      <div className="inspector-toolbar">
        <button
          className="run-node"
          aria-label={t("runNode")}
          data-tooltip={t("runNode")}
          disabled={runDisabled}
          aria-busy={starting}
          onClick={onRun}
        >
          {starting ? (
            <Loader2 size={15} className="spin" aria-hidden="true" />
          ) : (
            <Play size={15} aria-hidden="true" />
          )}
        </button>
        {others.map((action) => (
          <button
            key={action.id}
            className={
              action.danger ? "danger" : action.active ? "active" : undefined
            }
            aria-label={action.label}
            data-tooltip={action.label}
            disabled={action.disabled}
            onClick={action.run}
          >
            <action.icon size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
