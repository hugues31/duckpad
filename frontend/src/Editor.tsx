import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
// Bundle workers and the editor locally; no CDN access is needed at runtime.
(globalThis as any).MonacoEnvironment = {
  getWorker: (_: string, label: string) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};
loader.config({ monaco });
export function CodeDiff({
  before,
  after,
  language = "sql",
}: {
  before: string;
  after: string;
  language?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const theme =
    document.documentElement.dataset.theme === "dark" ? "vs-dark" : "light";

  useEffect(() => {
    if (!container.current) return;
    const original = monaco.editor.createModel(before, language);
    const modified = monaco.editor.createModel(after, language);
    const editor = monaco.editor.createDiffEditor(container.current, {
      theme,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      minimap: { enabled: false },
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      scrollBeyondLastLine: false,
    });
    editor.setModel({ original, modified });
    return () => {
      // Detach the models before disposing them, including on content changes.
      editor.setModel(null);
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [before, after, language, theme]);

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
