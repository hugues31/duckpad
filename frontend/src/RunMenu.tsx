import { ChevronDown, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionMenu, type ActionItem } from "./ActionMenu";
import { useT } from "./i18n";
import { PartitionRunOptions } from "./PartitionRunMenu";
import { useLoadedWorktree } from "./worktree";

/**
 * What the Run button does not do, behind the arrow beside it: computing every node
 * again instead of keeping valid results, and the key options of a partitioned flow.
 */
export function RunMenu() {
  const t = useT();
  const { snapshot, environment, canEdit, starting, run } = useLoadedWorktree();
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [options, setOptions] = useState(false);
  const items: ActionItem[] = [
    {
      id: "everything",
      icon: RefreshCw,
      label: t("runEverything"),
      hint: t("runEverythingHint"),
      run: () => void run(undefined, { reuse: false }),
    },
  ];
  if (snapshot.partitions?.[environment]?.dimension)
    items.push({
      id: "options",
      icon: SlidersHorizontal,
      label: t("partitionRunOptions"),
      run: () => setOptions(true),
    });
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
          // The menu hangs from the arrow, its right edge on the button's.
          const bounds = trigger.current!.getBoundingClientRect();
          setPosition({ x: bounds.right, y: bounds.bottom + 4 });
        }}
      >
        <ChevronDown size={15} />
      </button>
      {position && (
        <ActionMenu
          label={t("runOptions")}
          position={position}
          align="end"
          items={items}
          onClose={() => {
            setPosition(null);
            trigger.current?.focus();
          }}
        />
      )}
      {options &&
        createPortal(
          <PartitionRunOptions onClose={() => setOptions(false)} />,
          document.body,
        )}
    </>
  );
}
