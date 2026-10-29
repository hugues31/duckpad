import {
  Boxes,
  ChevronRight,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Workflow,
} from "lucide-react";
import type { PathPart } from "./graph";
import { useT } from "./i18n";

/** Breadcrumb of opened components, panel toggles and the grouping action. */
export default function CanvasHeader({
  projectName,
  path,
  hasNode,
  paletteOpen,
  previewOpen,
  inspectorOpen,
  selectionCount,
  onNavigate,
  onTogglePalette,
  onTogglePreview,
  onToggleInspector,
  onGroup,
  onEditDefinition,
}: {
  projectName: string;
  path: PathPart[];
  hasNode: boolean;
  paletteOpen: boolean;
  previewOpen: boolean;
  inspectorOpen: boolean;
  selectionCount: number;
  /** Open the flow (depth 0) or the component at that breadcrumb depth. */
  onNavigate: (depth: number) => void;
  onTogglePalette: () => void;
  onTogglePreview: () => void;
  onToggleInspector: () => void;
  onGroup: () => void;
  onEditDefinition: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="canvas-breadcrumb">
        <button
          className="icon panel-toggle"
          title={t("toggleNodes")}
          aria-label={t("toggleNodes")}
          aria-expanded={paletteOpen}
          aria-controls="node-palette"
          onClick={onTogglePalette}
        >
          <PanelLeft size={17} />
        </button>
        <button onClick={() => onNavigate(0)}>
          <Workflow size={13} />
          {projectName}
        </button>
        {path.map((part, index) => (
          <span key={part.instance} className="row gap">
            <ChevronRight size={12} />
            <button onClick={() => onNavigate(index + 1)}>{part.label}</button>
          </span>
        ))}
        <span className="spacer" />
        {hasNode && (
          <>
            <button
              className="icon panel-toggle"
              title={t("togglePreview")}
              aria-label={t("togglePreview")}
              aria-expanded={previewOpen}
              aria-controls="data-preview"
              onClick={onTogglePreview}
            >
              <PanelBottom size={17} />
            </button>
            <button
              className="icon panel-toggle"
              title={t("toggleInspector")}
              aria-label={t("toggleInspector")}
              aria-expanded={inspectorOpen}
              aria-controls="node-inspector"
              onClick={onToggleInspector}
            >
              <PanelRight size={17} />
            </button>
          </>
        )}
        {selectionCount > 0 && (
          <button className="group-button" onClick={onGroup}>
            <Boxes size={13} />
            {t("group")} ({selectionCount})
          </button>
        )}
      </div>
      {path.length > 0 && (
        <div className="component-notice">
          {t("sharedComponentHint")}
          <button onClick={onEditDefinition}>{t("definition")}</button>
        </div>
      )}
    </>
  );
}
