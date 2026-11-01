import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Sparkles, X } from "lucide-react";
import { useT } from "./i18n";

const STORAGE_KEY = "duckpad-assistant-launcher";
const SIZE = 48;
const EDGE = 20;
const MARGIN = 16;
const GAP = 12;
// The default sits above the flow minimap in the bottom-right corner.
const DEFAULT_BOTTOM = 96;
const CHAT_HEIGHT = 620;
const MIN_CHAT_HEIGHT = 360;
const DRAG_THRESHOLD = 5;
const KEY_STEP = 40;

export interface LauncherPosition {
  side: "left" | "right";
  /** Distance between the bubble and the bottom of the viewport. */
  bottom: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function viewportSize() {
  return {
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  };
}

function savedPosition(): LauncherPosition {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (
      (saved?.side === "left" || saved?.side === "right") &&
      Number.isFinite(saved?.bottom)
    )
      return { side: saved.side, bottom: saved.bottom };
  } catch {
    // An unreadable preference falls back to the default corner.
  }
  return { side: "right", bottom: DEFAULT_BOTTOM };
}

/** The bubble position, saved per browser and kept inside the viewport. */
export function useLauncherPosition() {
  const [position, setPosition] = useState(savedPosition);
  const [viewport, setViewport] = useState(viewportSize);
  useEffect(() => {
    const resize = () => setViewport(viewportSize());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const move = (value: LauncherPosition) => {
    setPosition(value);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  };
  const bottom = clamp(
    position.bottom,
    MARGIN,
    viewport.height - SIZE - MARGIN,
  );
  return { position: { side: position.side, bottom }, viewport, move };
}

/** Opens the chat on the bubble's side, above or below it, wherever there is more room. */
export function chatPlacement(
  { side, bottom }: LauncherPosition,
  viewportHeight: number,
): CSSProperties {
  const top = viewportHeight - bottom - SIZE;
  const above = top - GAP - MARGIN;
  const below = bottom - GAP - MARGIN;
  const height = Math.min(
    CHAT_HEIGHT,
    viewportHeight - 2 * MARGIN,
    Math.max(above, below, MIN_CHAT_HEIGHT),
  );
  const upward = above >= below;
  return {
    [side]: EDGE,
    top: upward
      ? Math.max(MARGIN, top - GAP - height)
      : Math.min(viewportHeight - MARGIN - height, top + SIZE + GAP),
    height,
    transformOrigin: `${upward ? "bottom" : "top"} ${side}`,
  };
}

/** A floating bubble: click to toggle the chat, drag to move it to either side. */
export function AssistantLauncher({
  ref,
  open,
  busy,
  unread,
  position,
  viewport,
  onMove,
  onToggle,
}: {
  ref: Ref<HTMLButtonElement>;
  open: boolean;
  busy: boolean;
  unread: boolean;
  position: LauncherPosition;
  viewport: { width: number; height: number };
  onMove: (position: LauncherPosition) => void;
  onToggle: () => void;
}) {
  const t = useT();
  const drag = useRef<{
    x: number;
    y: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const dragged = useRef(false);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(
    null,
  );
  const settle = (left: number, top: number) =>
    onMove({
      side: left + SIZE / 2 < viewport.width / 2 ? "left" : "right",
      bottom: clamp(
        viewport.height - top - SIZE,
        MARGIN,
        viewport.height - SIZE - MARGIN,
      ),
    });
  const style: CSSProperties = point ?? {
    left: position.side === "left" ? EDGE : viewport.width - EDGE - SIZE,
    top: viewport.height - position.bottom - SIZE,
  };
  return (
    <button
      ref={ref}
      type="button"
      className={[
        "assistant-launcher",
        open && "open",
        busy && "busy",
        point && "dragging",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-label={t("assistantOpen")}
      aria-expanded={open}
      title={`${t("assistant")} · ${t("assistantLauncherHint")}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const box = event.currentTarget.getBoundingClientRect();
        dragged.current = false;
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          dx: event.clientX - box.left,
          dy: event.clientY - box.top,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        if (
          !current.moved &&
          Math.hypot(event.clientX - current.x, event.clientY - current.y) <
            DRAG_THRESHOLD
        )
          return;
        current.moved = true;
        setPoint({
          left: clamp(event.clientX - current.dx, 0, viewport.width - SIZE),
          top: clamp(event.clientY - current.dy, 0, viewport.height - SIZE),
        });
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        drag.current = null;
        if (!current?.moved) return;
        dragged.current = true;
        settle(event.clientX - current.dx, event.clientY - current.dy);
        setPoint(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setPoint(null);
      }}
      onClick={() => {
        // The click that ends a drag only drops the bubble.
        if (dragged.current) dragged.current = false;
        else onToggle();
      }}
      onKeyDown={(event) => {
        if (!event.altKey) return;
        const moves: Record<string, LauncherPosition> = {
          ArrowLeft: { ...position, side: "left" },
          ArrowRight: { ...position, side: "right" },
          ArrowUp: { ...position, bottom: position.bottom + KEY_STEP },
          ArrowDown: { ...position, bottom: position.bottom - KEY_STEP },
        };
        const next = moves[event.key];
        if (!next) return;
        event.preventDefault();
        onMove({
          ...next,
          bottom: clamp(next.bottom, MARGIN, viewport.height - SIZE - MARGIN),
        });
      }}
    >
      <span className="assistant-launcher-icon" aria-hidden="true">
        {open ? <X size={20} /> : <Sparkles size={21} />}
      </span>
      {unread && !open && <span className="assistant-launcher-badge" />}
    </button>
  );
}
