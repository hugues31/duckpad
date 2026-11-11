// Features register services that the first editor, or theme, instantiates.
import "./monacoFeatures";
import { useEffect, useRef, useState } from "react";
import type { SqlDiagnostic } from "./types";
import {
  revealPosition,
  type CodeContext,
  type CodeEditorInstance,
} from "./codeEditing";
import {
  checkTemplate,
  EDITOR_THEMES,
  hasEditorErrors,
  prepareCodeCatalog,
  registerCodeIntelligence,
  setCodeContext,
} from "./codeIntelligence";
import { useT } from "./i18n";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
// Bundle workers and the editor locally; no CDN access is needed at runtime.
window.MonacoEnvironment = {
  getWorker: (_: string, label: string) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};
loader.config({ monaco });
// SQL is registered here, with Duckpad's directives and references.
registerCodeIntelligence();
// Disposing the last model stops Monaco's worker and rejects a diff still being
// computed with "Canceled", which Monaco leaves unhandled. Ignore it, like VS Code.
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  if (
    reason instanceof Error &&
    reason.name === "Canceled" &&
    reason.message === "Canceled"
  )
    event.preventDefault();
});
export function CodeDiff({
  before,
  after,
  language = "sql",
  onChange,
  originalLabel,
  modifiedLabel,
}: {
  before: string;
  after: string;
  language?: string;
  onChange?: (value: string) => void;
  originalLabel?: string;
  modifiedLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const models = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  const editable = !!onChange;
  const theme = editorTheme();

  useEffect(() => {
    if (!container.current) return;
    const original = monaco.editor.createModel("", language);
    const modified = monaco.editor.createModel("", language);
    models.current = { original, modified };
    const editor = monaco.editor.createDiffEditor(container.current, {
      theme,
      readOnly: !editable,
      originalEditable: false,
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflowWidgets(),
      automaticLayout: true,
      minimap: { enabled: false },
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      ignoreTrimWhitespace: false,
      originalAriaLabel: originalLabel,
      modifiedAriaLabel: modifiedLabel,
      scrollBeyondLastLine: false,
    });
    editor.setModel({ original, modified });
    const subscription = modified.onDidChangeContent(() =>
      change.current?.(modified.getValue()),
    );
    return () => {
      // Detach the models before disposing them, including on content changes.
      editor.setModel(null);
      subscription.dispose();
      editor.dispose();
      original.dispose();
      modified.dispose();
      models.current = null;
    };
  }, [language, theme, editable, originalLabel, modifiedLabel]);
  useEffect(() => {
    if (!models.current) return;
    const { original, modified } = models.current;
    if (original.getValue() !== before) original.setValue(before);
    if (modified.getValue() !== after) modified.setValue(after);
  }, [before, after, language, theme, editable, originalLabel, modifiedLabel]);

  return <div ref={container} style={{ height: 300, width: "100%" }} />;
}
/**
 * The suggestions, hovers and hints of every editor. They are fixed to the
 * viewport, which a panel's backdrop filter would replace by the panel itself.
 */
let overflowHost: HTMLElement | null = null;
function overflowWidgets() {
  if (!overflowHost) {
    overflowHost = document.createElement("div");
    overflowHost.className = "monaco-editor code-editor-overflow";
    document.body.append(overflowHost);
  }
  return overflowHost;
}

const editorTheme = () =>
  document.documentElement.dataset.theme === "dark"
    ? EDITOR_THEMES.dark
    : EDITOR_THEMES.light;

/** A problem the server reported in the saved code: `Python line 3: …` locates it. */
export interface SavedProblem {
  message: string;
}

export default function CodeEditor({
  value,
  onChange,
  language = "sql",
  readOnly = false,
  height = "380px",
  diagnostic,
  revealLine,
  onEditor,
  label,
  context,
  problems,
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string;
  diagnostic?: SqlDiagnostic | null;
  revealLine?: number;
  /** Receives the editor once mounted. */
  onEditor?: (instance: CodeEditorInstance) => void;
  /** The accessible name of the text area. */
  label?: string;
  /** What the code can reference, for suggestions, hovers and checks. */
  context?: CodeContext;
  /** Problems the server reported in this code, when it is saved as shown. */
  problems?: SavedProblem[];
}) {
  const t = useT();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);
  useEffect(() => {
    if (model) setCodeContext(model, { ...context, t });
  }, [model, context, t]);
  const template = !!context?.template && language === "sql";
  useEffect(() => {
    if (!model) return;
    if (template) checkTemplate(model, t);
    // Server problems explain what the editor checks cannot see.
    const saved = hasEditorErrors(model) ? [] : problems || [];
    monaco.editor.setModelMarkers(
      model,
      "duckpad-saved",
      saved.map(({ message }) => {
        const located = /^Python line (\d+): ([\s\S]*)$/.exec(message);
        const line = Math.min(Number(located?.[1] ?? 1), model.getLineCount());
        return {
          severity: monaco.MarkerSeverity.Error,
          message: located?.[2] ?? message,
          startLineNumber: line,
          endLineNumber: line,
          startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
          endColumn: model.getLineMaxColumn(line),
        };
      }),
    );
  }, [model, template, problems, value, t]);
  const mark = () => {
    const model = editor.current?.getModel();
    if (!model) return;
    const valid = diagnostic && value === diagnostic.source;
    monaco.editor.setModelMarkers(
      model,
      "execution",
      valid
        ? [
            {
              severity: monaco.MarkerSeverity.Error,
              message: diagnostic.message,
              startLineNumber: diagnostic.line,
              endLineNumber: diagnostic.line,
              startColumn: diagnostic.column,
              endColumn: model.getLineMaxColumn(diagnostic.line),
            },
          ]
        : [],
    );
  };
  useEffect(mark, [diagnostic, value]);
  return (
    <Editor
      onMount={(instance) => {
        editor.current = instance;
        setModel(instance.getModel());
        instance.onDidChangeModel(() => setModel(instance.getModel()));
        if (!readOnly) prepareCodeCatalog();
        mark();
        if (revealLine)
          revealPosition(instance, revealLine, diagnostic?.column || 1);
        onEditor?.(instance);
      }}
      height={height}
      language={language}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      theme={editorTheme()}
      options={{
        minimap: { enabled: false },
        // Suggestions and hovers may overflow a narrow panel.
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: overflowWidgets(),
        quickSuggestions: {
          other: true,
          comments: false,
          strings: language === "python",
        },
        fontSize: 13,
        lineHeight: 22,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        readOnly,
        automaticLayout: true,
        padding: { top: 16 },
        tabSize: 2,
        ...(label ? { ariaLabel: label } : {}),
      }}
    />
  );
}
