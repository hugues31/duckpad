import { ChevronDown, Play, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { ActionMenu } from "./ActionMenu";
import { useT } from "./i18n";
import { PartitionRunMenu } from "./PartitionRunMenu";
import { useLoadedWorktree } from "./worktree";

/** Room for the widest action and its hint, in pixels. */
const MENU_WIDTH = 250;

/**
 * The other ways to run the flow, beside its Run button: computing every node again
 * instead of keeping valid results, or the options of a partitioned flow.
 */
export function RunMenu() {
  const t = useT();
  const { snapshot, environment, canEdit, starting, run } = useLoadedWorktree();
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  // A partitioned flow computes its whole scope: its menu holds the key options.
  if (snapshot.partitions?.[environment]?.dimension)
    return <PartitionRunMenu />;
  return (
    <>
      <button
        ref={trigger}
        className="button primary run-options-trigger"
        aria-label={t("runOptions")}
        title={t("runOptions")}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={!canEdit || starting || !snapshot.bundle}
        onClick={() => {
          // The menu opens under the split button, aligned with its right edge.
          const bounds = trigger.current!.getBoundingClientRect();
          setPosition({ x: bounds.right - MENU_WIDTH, y: bounds.bottom + 4 });
        }}
      >
        <ChevronDown size={15} />
      </button>
      {position && (
        <ActionMenu
          label={t("runOptions")}
          position={position}
          items={[
            {
              id: "changes",
              icon: Play,
              label: t("runChanges"),
              hint: t("runChangesHint"),
              run: () => void run(),
            },
            {
              id: "everything",
              icon: RefreshCw,
              label: t("runEverything"),
              hint: t("runEverythingHint"),
              run: () => void run(undefined, { reuse: false }),
            },
          ]}
          onClose={() => {
            setPosition(null);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
