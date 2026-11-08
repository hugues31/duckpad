import type { editor } from "monaco-editor/esm/vs/editor/editor.api";

// Only types come from Monaco here: modules outside the lazily loaded editor
// use these helpers without bundling it.

/** A mounted code editor, to insert text at its cursor or reveal a line. */
export type CodeEditorInstance = editor.IStandaloneCodeEditor;

/** Replace the selection of an editor with text, then give it the focus. */
export function insertText(instance: CodeEditorInstance, text: string) {
  const selection = instance.getSelection();
  if (!selection) return;
  instance.executeEdits("insert", [
    { range: selection, text, forceMoveMarkers: true },
  ]);
  instance.pushUndoStop();
  instance.focus();
}

/** Put the cursor on a line, centered in view, and focus the editor. */
export function revealPosition(
  instance: CodeEditorInstance,
  line: number,
  column = 1,
) {
  instance.setPosition({ lineNumber: line, column });
  instance.revealLineInCenter(line);
  instance.focus();
}
