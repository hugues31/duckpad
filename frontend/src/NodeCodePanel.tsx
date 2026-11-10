import { ChevronDown, ChevronRight, Eye, Link, Loader2, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  insertText,
  revealPosition,
  type CodeEditorInstance,
} from "./codeEditing";
import {
  SAMPLE_SIZES,
  type PreviewState,
  type SampleSize,
} from "./draftPreview";
import { useT } from "./i18n";
import { nodeCode, setNodeCode, templateUsage } from "./nodeCode";
import { quoteIdentifier } from "./samples";
import SaveState from "./SaveState";
import Select from "./Select";
import { useShell } from "./shell";
import type { Bundle, FlowNode, Snapshot, Statuses } from "./types";
import { useAutosavedDraft } from "./useAutosavedDraft";
import { useInputColumns } from "./useInputColumns";
import { useSaveShortcut } from "./useSaveShortcut";
import { useWorktree } from "./worktree";

const CodeEditor = lazy(() => import("./Editor"));

/** A line of the code to put the cursor on; a new key reveals it again. */
export interface CodeReveal {
  line: number;
  column?: number;
  key: number;
}

/** Whether a key event asks for a preview: Ctrl+Enter, or ⌘Enter on macOS. */
const previewShortcut = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key === "Enter";

/**
 * The code of the selected node, docked beside the canvas. It saves like the
 * inspector, after a pause in typing, and previews the code being typed on
 * samples of the node's inputs without saving or publishing anything.
 */
export default function NodeCodePanel({
  snapshot,
  node,
  parent,
  fullNode,
  label,
  environment,
  readOnly,
  statuses,
  preview,
  reveal,
  sample,
  onSample,
  onPreview,
  onDraft,
  onClose,
}: {
  snapshot: Snapshot;
  node: FlowNode;
  /** The component definition holding the node, if not the root flow. */
  parent?: string;
  fullNode: string;
  label: string;
  environment: string;
  readOnly: boolean;
  statuses: Statuses;
  /** The preview of this node, if one was requested. */
  preview: PreviewState | null;
  reveal: CodeReveal | null;
  sample: SampleSize;
  onSample: (sample: SampleSize) => void;
  onPreview: (code: string) => void;
  /** Reports the code being edited, which later previews compute. */
  onDraft: (code: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { notify } = useShell();
  const { save, starting } = useWorktree();
  const read = (bundle: Bundle) => nodeCode(bundle, node, parent) ?? "";
  const { draft, dirty, pending, update, saveNow, error } = useAutosavedDraft(
    read(snapshot.bundle!),
    snapshot,
    (text: string, base: Snapshot) =>
      save(base, (bundle) => setNodeCode(bundle, node, text, parent)),
    {
      readOnly,
      onOrphanedError: (error) => notify((error as Error).message, true),
    },
  );
  const panel = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<CodeEditorInstance | null>(null);
  const python = node.language === "python";
  useSaveShortcut(saveNow, panel);
  const reportDraft = useEffectEvent(onDraft);
  useEffect(() => {
    reportDraft(draft);
  }, [draft]);
  useEffect(() => () => reportDraft(null), []);
  const blocked = readOnly
    ? "previewReadOnly"
    : python
      ? "previewPython"
      : statuses.active || starting
        ? "previewRunActive"
        : null;
  const requestPreview = () => {
    if (!blocked) onPreview(draft);
  };
  // Shortcuts apply while the focus is inside the panel, the code included.
  const shortcuts = useEffectEvent((event: KeyboardEvent) => {
    if (!panel.current?.contains(event.target as Node)) return;
    if (previewShortcut(event)) {
      // The code editor would otherwise insert a line.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) requestPreview();
    }
  });
  useEffect(() => {
    // Capture the keys before the code editor handles them.
    window.addEventListener("keydown", shortcuts, true);
    return () => window.removeEventListener("keydown", shortcuts, true);
  }, []);
  useEffect(() => {
    if (editor && reveal) revealPosition(editor, reveal.line, reveal.column);
  }, [editor, reveal]);
  // A failed preview locates its error in the code it computed, if unchanged.
  const runDiagnostic = statuses.nodes[fullNode]?.diagnostic;
  const diagnostic =
    preview?.diagnostic?.source === draft
      ? preview.diagnostic
      : runDiagnostic?.source === draft
        ? runDiagnostic
        : undefined;
  const linked = node.template
    ? templateUsage(snapshot.bundle!, node.template)
    : 0;
  const columns = useInputColumns(snapshot, fullNode, environment, statuses);
  return (
    <aside className="code-panel" ref={panel} aria-label={t("codePanel")}>
      <div className="inspector-title">
        <span className="panel-heading">
          <span title={label}>{label}</span>
          <small className="muted">
            {python ? "Python" : "SQL"}
            {node.template && (
              <>
                {" · "}
                <Link size={11} aria-hidden="true" />
                {t(
                  linked === 1 ? "sharedTemplateOne" : "sharedTemplateCount",
                ).replace("{count}", String(linked))}
              </>
            )}
          </small>
        </span>
        <button
          className="icon"
          onClick={onClose}
          title={t("closeCodeEditor")}
          aria-label={t("closeCodeEditor")}
        >
          <X size={18} />
        </button>
      </div>
      <div className="code-panel-toolbar">
        <button
          className="button primary small"
          disabled={!!blocked}
          title={t(blocked || "previewHint")}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={requestPreview}
        >
          {preview?.pending ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : (
            <Eye size={14} aria-hidden="true" />
          )}
          {t("previewCode")}
        </button>
        <Select
          className="code-panel-sample"
          aria-label={t("previewSample")}
          title={t("previewSample")}
          value={String(sample)}
          disabled={!!blocked}
          onChange={(event) =>
            onSample(
              event.target.value === "null"
                ? null
                : (Number(event.target.value) as SampleSize),
            )
          }
        >
          {SAMPLE_SIZES.map((size) => (
            <option key={String(size)} value={String(size)}>
              {size === null
                ? t("previewAllRows")
                : t("previewSampleRows").replace(
                    "{count}",
                    size.toLocaleString(),
                  )}
            </option>
          ))}
        </Select>
        <span className="spacer" />
        {!readOnly && (
          <SaveState pending={pending} dirty={dirty} error={error} />
        )}
      </div>
      {node.template && (
        <p className="code-panel-notice muted small">
          {t("sharedTemplateHint")}
        </p>
      )}
      {error && (
        <div className="notice error code-panel-notice" role="alert">
          {error}
        </div>
      )}
      <InputColumnList
        columns={columns}
        python={python}
        disabled={readOnly || !editor}
        onInsert={(text) => editor && insertText(editor, text)}
      />
      <div className="code-panel-editor">
        <Suspense fallback={<p className="muted small">{t("loading")}</p>}>
          <CodeEditor
            value={draft}
            onChange={(text) => update(() => text)}
            language={node.language || "sql"}
            readOnly={readOnly}
            height="100%"
            diagnostic={diagnostic}
            label={t("codePanel")}
            onEditor={setEditor}
          />
        </Suspense>
      </div>
    </aside>
  );
}

/**
 * The columns of each input, from the last upstream result or described from
 * the upstream code. A click inserts a name at the cursor.
 */
function InputColumnList({
  columns,
  python,
  disabled,
  onInsert,
}: {
  columns: ReturnType<typeof useInputColumns>;
  python: boolean;
  disabled: boolean;
  onInsert: (text: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const inputs = columns.data?.inputs || [];
  if (!inputs.length && !columns.pending) return null;
  const Toggle = open ? ChevronDown : ChevronRight;
  return (
    <section className="input-columns" aria-label={t("inputColumns")}>
      <button
        className="input-columns-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Toggle size={14} aria-hidden="true" />
        {t("inputColumns")}
        {columns.pending && !columns.data && (
          <Loader2 size={12} className="spin" aria-label={t("loading")} />
        )}
        <span className="muted small">{t("inputColumnsHint")}</span>
      </button>
      {open && (
        <div className="input-columns-list">
          {inputs.map((input) => {
            const reference = python ? input.input : `{{ ${input.input} }}`;
            return (
              <div className="input-columns-group" key={input.input}>
                <div className="input-columns-name">
                  <button
                    className="column-chip input"
                    disabled={disabled}
                    title={t("insertName").replace("{name}", reference)}
                    onClick={() => onInsert(reference)}
                  >
                    {input.input}
                  </button>
                  <small className="muted">
                    {input.origin === "result"
                      ? t(
                          input.status === "valid"
                            ? "columnsFromResult"
                            : "columnsFromStaleResult",
                        )
                      : input.origin === "description"
                        ? t("columnsFromCode")
                        : t(
                            input.reason === "not_connected"
                              ? "inputNotConnected"
                              : "columnsUnavailable",
                          )}
                  </small>
                </div>
                {input.columns && (
                  <ul className="input-columns-chips">
                    {input.columns.map((column) => {
                      const text = python
                        ? column.name
                        : quoteIdentifier(column.name);
                      return (
                        <li key={column.name}>
                          <button
                            className="column-chip"
                            disabled={disabled}
                            title={t("insertName").replace("{name}", text)}
                            onClick={() => onInsert(text)}
                          >
                            <span>{column.name}</span>
                            <small>{column.type}</small>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
