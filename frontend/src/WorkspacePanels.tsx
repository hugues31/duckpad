import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "./i18n";

// The code panel takes the inspector's place, with its own width.
const PANELS = ["palette", "inspector", "preview", "code", "lineage"] as const;
export type Panel = (typeof PANELS)[number];
type Sizes = Partial<Record<Panel, number>>;
const WIDE_LAYOUT = "(min-width: 1100px)";
const storageKey = "duckpad-panel-sizes";
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function usePanelSizes() {
  const [preferences, setPreferences] = useState<Sizes>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return Object.fromEntries(
        PANELS.filter(
          (key) =>
            typeof saved?.[key] === "number" && Number.isFinite(saved[key]),
        ).map((key) => [key, saved[key]]),
      );
    } catch {
      return {};
    }
  });
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  useEffect(() => {
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  }, [preferences]);
  const { width, height } = viewport;
  const desktop = width >= 1100;
  const mobile = width <= 600;
  let palette = clamp(
    preferences.palette ??
      (width >= 1700 ? 224 : width > 1200 || !desktop ? 208 : 180),
    180,
    Math.min(420, width - 36),
  );
  let inspector = clamp(
    preferences.inspector ?? (width >= 1700 ? 350 : width <= 1200 ? 290 : 320),
    260,
    mobile ? Math.min(560, width) : Math.min(560, width - 320),
  );
  if (desktop && palette + inspector > width - 360) {
    const ratio = (width - 360 - 440) / (palette + inspector - 440);
    palette = Math.round(180 + (palette - 180) * ratio);
    inspector = Math.round(260 + (inspector - 260) * ratio);
  }
  // Code needs more room than the inspector; the canvas keeps at least 360 pixels.
  const codeMax = desktop
    ? Math.max(360, Math.min(1100, width - palette - 360))
    : mobile
      ? width
      : Math.max(360, width - 320);
  const code = clamp(
    preferences.code ?? clamp(width * 0.4, 440, 760),
    Math.min(360, codeMax),
    codeMax,
  );
  const headerHeight = mobile ? 198 : width <= 800 ? 132 : 96;
  // Keep room for the graph, its breadcrumb and navigation controls.
  const previewMax = Math.max(180, height - headerHeight - 300);
  const preview = clamp(
    preferences.preview ?? (mobile ? 220 : clamp(height * 0.4, 240, 420)),
    180,
    previewMax,
  );
  const lineage = clamp(
    preferences.lineage ?? 540,
    Math.min(360, codeMax),
    codeMax,
  );
  const sizes = { palette, inspector, preview, code, lineage };
  const limits: Record<Panel, [number, number]> = {
    palette: [
      180,
      Math.min(420, desktop ? width - inspector - 360 : width - 36),
    ],
    inspector: [
      260,
      Math.min(
        560,
        desktop ? width - palette - 360 : mobile ? width : width - 320,
      ),
    ],
    preview: [180, previewMax],
    code: [Math.min(360, codeMax), codeMax],
    lineage: [Math.min(360, codeMax), codeMax],
  };
  return {
    sizes,
    limits,
    resize: (panel: Panel, value: number) =>
      setPreferences((previous) => ({
        ...previous,
        [panel]: clamp(value, ...limits[panel]),
      })),
    reset: (panel: Panel) =>
      setPreferences((previous) => {
        const next = { ...previous };
        delete next[panel];
        return next;
      }),
  };
}

export type PanelSizes = ReturnType<typeof usePanelSizes>;

/** Whether the screen leaves room for the node library beside the canvas. */
export const isWideLayout = () => window.matchMedia(WIDE_LAYOUT).matches;

/** A panel that can be hidden; the code panel shows in the inspector's place. */
type FloatingPanel = Exclude<Panel, "code" | "lineage">;

/** Which floating panels of the flow are open. */
export function usePanelVisibility() {
  const [open, setOpen] = useState<Record<FloatingPanel, boolean>>(() => ({
    palette: isWideLayout(),
    inspector: true,
    preview: true,
  }));
  const set = useCallback(
    (change: Partial<Record<FloatingPanel, boolean>>) =>
      setOpen((current) => ({ ...current, ...change })),
    [],
  );
  return useMemo(() => ({ open, set }), [open, set]);
}
export type PanelVisibility = ReturnType<typeof usePanelVisibility>;

/** The resize handles of the panels that are shown. */
export function PanelResizeHandles({
  panels,
  shown,
}: {
  panels: PanelSizes;
  shown: Partial<Record<Panel, boolean>>;
}) {
  return PANELS.filter((panel) => shown[panel]).map((panel) => (
    <PanelResizeHandle
      key={panel}
      panel={panel}
      value={panels.sizes[panel]}
      limits={panels.limits[panel]}
      onResize={(value) => panels.resize(panel, value)}
      onReset={() => panels.reset(panel)}
    />
  ));
}

function PanelResizeHandle({
  panel,
  value,
  limits,
  onResize,
  onReset,
}: {
  panel: Panel;
  value: number;
  limits: [number, number];
  onResize: (value: number) => void;
  onReset: () => void;
}) {
  const t = useT();
  const horizontal = panel === "preview";
  // The code panel is resized from the inspector's edge.
  const side = panel === "code" || panel === "lineage" ? "inspector" : panel;
  const drag = useRef<{
    pointer: number;
    coordinate: number;
    value: number;
  } | null>(null);
  const [active, setActive] = useState(false);
  const label = t(
    panel === "palette"
      ? "resizeNodes"
      : panel === "inspector"
        ? "resizeInspector"
        : panel === "lineage"
          ? "resizeLineage"
          : panel === "code"
            ? "resizeCodePanel"
            : "resizePreview",
  );
  return (
    <div
      className={`panel-resizer resize-${side}${active ? " active" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      title={`${label}. ${t("resizeHint")}`}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-controls={
        side === "palette"
          ? "node-palette"
          : side === "inspector"
            ? "node-inspector"
            : "data-preview"
      }
      aria-valuemin={Math.round(limits[0])}
      aria-valuemax={Math.round(limits[1])}
      aria-valuenow={Math.round(value)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          coordinate: horizontal ? event.clientY : event.clientX,
          value,
        };
        setActive(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        const delta =
          (horizontal ? event.clientY : event.clientX) -
          drag.current.coordinate;
        onResize(drag.current.value + delta * (panel === "palette" ? 1 : -1));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        setActive(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (drag.current) onResize(drag.current.value);
        drag.current = null;
        setActive(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          onResize(limits[event.key === "Home" ? 0 : 1]);
          return;
        }
        const negative = horizontal
          ? "ArrowDown"
          : panel === "palette"
            ? "ArrowLeft"
            : "ArrowRight";
        const positive = horizontal
          ? "ArrowUp"
          : panel === "palette"
            ? "ArrowRight"
            : "ArrowLeft";
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        onResize(
          value +
            (event.shiftKey ? 48 : 16) * (event.key === positive ? 1 : -1),
        );
      }}
    />
  );
}
