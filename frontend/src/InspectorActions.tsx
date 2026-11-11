import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { ActionMenu } from "./ActionMenu";
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const removal = others.filter(
    (action) => action.id === "remove" || action.id === "removeReconnect",
  );
  const openRemoval = (trigger: HTMLButtonElement) => {
    const bounds = trigger.getBoundingClientRect();
    setMenu({ x: bounds.left, y: bounds.bottom + 4, trigger });
  };
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
        {others
          .filter((action) => action.id !== "removeReconnect")
          .map((action) => (
            <button
              key={action.id}
              className={
                action.danger ? "danger" : action.active ? "active" : undefined
              }
              aria-label={action.label}
              data-tooltip={action.label}
              disabled={action.disabled}
              aria-haspopup={action.id === "remove" ? "menu" : undefined}
              aria-expanded={action.id === "remove" ? !!menu : undefined}
              onClick={(event) =>
                action.id === "remove"
                  ? openRemoval(event.currentTarget)
                  : action.run()
              }
              onKeyDown={(event) => {
                if (action.id === "remove" && event.key === "ArrowDown") {
                  event.preventDefault();
                  openRemoval(event.currentTarget);
                }
              }}
            >
              <action.icon size={15} aria-hidden="true" />
            </button>
          ))}
      </div>
      {menu && (
        <ActionMenu
          label={t("deleteNode")}
          items={removal}
          position={menu}
          onClose={() => {
            setMenu(null);
            menu.trigger.focus();
          }}
        />
      )}
    </div>
  );
}
