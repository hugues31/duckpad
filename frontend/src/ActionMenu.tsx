import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface ActionItem {
  id: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Shared keyboard and pointer actions for an overflow button or a context menu. */
export function ActionMenu({
  label,
  items,
  position,
  onClose,
}: {
  label: string;
  items: ActionItem[];
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState(position);
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPoint({
      x: Math.max(
        8,
        Math.min(position.x, window.innerWidth - bounds.width - 8),
      ),
      y: Math.max(
        8,
        Math.min(position.y, window.innerHeight - bounds.height - 8),
      ),
    });
  }, [position]);
  useEffect(() => {
    (
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ||
      menu.current
    )?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="node-action-menu"
      role="menu"
      tabIndex={-1}
      aria-label={label}
      style={{ left: point.x, top: point.y }}
      onContextMenu={(event) => event.preventDefault()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          onClose();
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const buttons = [
          ...menu.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[index]?.focus();
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function ActionMenuButton({
  label,
  items: getItems,
  disabled,
}: {
  label: string;
  items: () => ActionItem[];
  disabled?: boolean;
}) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const open = () => {
    setItems(getItems());
    const bounds = trigger.current!.getBoundingClientRect();
    setPosition({ x: bounds.left, y: bounds.bottom + 4 });
  };
  return (
    <>
      <button
        ref={trigger}
        className="icon"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={disabled}
        onClick={() => (position ? setPosition(null) : open())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            open();
          }
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {position && !disabled && (
        <ActionMenu
          label={label}
          items={items}
          position={position}
          onClose={() => {
            setPosition(null);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
