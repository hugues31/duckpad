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

/** The columns of an input of the code being edited. */
export interface CodeInput {
  name: string;
  /** Null while unknown, with the reason. */
  columns: { name: string; type: string }[] | null;
  origin: "result" | "description" | null;
  /** The upstream node and output, when connected. */
  source?: string;
}

/** What the code being edited can reference, for suggestions, hovers and checks. */
export interface CodeContext {
  /** Node or template code, whose Duckpad directives and references are checked. */
  template?: boolean;
  /** The project file being edited, such as `flow.json`. */
  file?: string;
  inputs?: CodeInput[];
  /** The columns of the node's outputs, from its last results. */
  outputs?: CodeInput[];
  /** The node's own values of its parameters, in the selected environment. */
  parameters?: Record<string, { value?: unknown; variable?: string }>;
  /** The connections granted to the project. */
  connections?: { id: string; name: string }[];
  /** Project variables, with their value in the selected environment. */
  variables?: {
    name: string;
    type: string;
    description?: string;
    value?: unknown;
  }[];
  environment?: string;
}
