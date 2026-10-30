import Editor, { DiffEditor, loader } from "@monaco-editor/react";
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
  return (
    <DiffEditor
      height="300px"
      original={before}
      modified={after}
      language={language}
      theme={
        document.documentElement.dataset.theme === "dark" ? "vs-dark" : "light"
      }
      options={{
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        minimap: { enabled: false },
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
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
