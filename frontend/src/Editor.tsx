import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
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
  const theme =
    document.documentElement.dataset.theme === "dark" ? "vs-dark" : "light";

  useEffect(() => {
    if (!container.current) return;
    const original = monaco.editor.createModel("", language);
    const modified = monaco.editor.createModel("", language);
    models.current = { original, modified };
    const editor = monaco.editor.createDiffEditor(container.current, {
      theme,
      readOnly: !editable,
      originalEditable: false,
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
export default function CodeEditor({
  value,
  onChange,
  language = "sql",
  readOnly = false,
  height = "380px",
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string;
}) {
  return (
    <Editor
      height={height}
      language={language}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      theme={
        document.documentElement.dataset.theme === "dark" ? "vs-dark" : "light"
      }
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 22,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        readOnly,
        automaticLayout: true,
        padding: { top: 16 },
        tabSize: 2,
      }}
    />
  );
}
