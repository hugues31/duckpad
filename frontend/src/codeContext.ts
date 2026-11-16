import type { CodeContext } from "./codeEditing";
import type { InputColumns } from "./draftPreview";
import type { Translate } from "./i18n";
import { displayNodeName } from "./nodeNames";
import type { Diagnostic, FlowNode, NodeResult, Snapshot } from "./types";

/** The project's variables with their value in an environment. */
export function codeVariables(
  snapshot: Snapshot,
  environment: string,
): NonNullable<CodeContext["variables"]> {
  return Object.entries(snapshot.variables?.declarations || {}).map(
    ([name, variable]) => ({
      name,
      type: variable.type,
      description: variable.description,
      value: variable.values[environment]?.value,
    }),
  );
}

/** What a node's code can reference: its inputs' columns and its own values. */
export function nodeCodeContext(
  snapshot: Snapshot,
  node: FlowNode,
  columns: InputColumns | null | undefined,
  environment: string,
  t: Translate,
  results?: NodeResult,
): CodeContext {
  const variables = snapshot.variables?.declarations || {};
  return {
    template: true,
    outputs: Object.entries(results?.outputs || {}).map(([port, result]) => ({
      name: port,
      columns: result.columns,
      origin: "result",
    })),
    environment,
    connections: snapshot.connections.map(({ id, name }) => ({ id, name })),
    inputs: (columns?.inputs || []).map((input) => ({
      name: input.input,
      columns: input.columns,
      origin: input.origin,
      source: input.node
        ? displayNodeName(snapshot.node_names?.[input.node], input.node, t) +
          (input.port && input.port !== "result" ? ` · ${input.port}` : "")
        : undefined,
    })),
    parameters: Object.fromEntries(
      Object.entries(node.params || {}).map(([name, value]) => {
        const variable =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)["$var"]
            : undefined;
        return [
          name,
          typeof variable === "string"
            ? {
                variable,
                value: variables[variable]?.values[environment]?.value,
              }
            : { value },
        ];
      }),
    ),
  };
}

/** The server's problems in a saved file, if the text shown is the saved one. */
export const savedProblems = (
  snapshot: Snapshot,
  path: string,
  text: string,
): Pick<Diagnostic, "message">[] =>
  snapshot.files[path] === text
    ? snapshot.diagnostics.filter(
        // A Python contract error names its node, but is about the file.
        (diagnostic) =>
          diagnostic.file === path &&
          (!diagnostic.node || diagnostic.code === "python_contract"),
      )
    : [];
