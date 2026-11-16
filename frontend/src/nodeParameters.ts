import { sourceFileName } from "./SourceFileField";
import type { FlowNode, Json, Parameter } from "./types";
import { variableReference } from "./variables";
export function sourcePreviewParams(
  draft: FlowNode,
  parameters: Parameter[],
  fileSource: boolean,
) {
  const file =
    draft.params?.file ?? parameters.find((p) => p.name === "file")?.default;
  const previewParams: Record<string, Json> | null =
    fileSource && typeof file === "string" && file && !file.includes("{{")
      ? { file: file }
      : null;
  if (previewParams)
    for (const key of [
      "delimiter",
      "header",
      "types",
      "sheet",
      "all_varchar",
    ]) {
      const value =
        draft.params?.[key] ?? parameters.find((p) => p.name === key)?.default;
      if (value !== undefined && !variableReference(value)) {
        if (key === "types" && typeof value === "string") {
          try {
            previewParams[key] = JSON.parse(value);
          } catch {
            previewParams[key] = value;
          }
        } else previewParams[key] = value;
      }
    }

  return previewParams;
}

/** Change a parameter and invalidate only the dependent values it affects. */
export function applyParameterChange(
  node: FlowNode,
  name: string,
  value: Json | undefined,
  {
    fileSource = false,
    typesInPreview = false,
    listedConnection,
    listedSchema,
    listedTable,
    parameters = [],
    settings,
  }: {
    fileSource?: boolean;
    typesInPreview?: boolean;
    listedConnection?: string | null;
    listedSchema?: string;
    listedTable?: string;
    parameters?: Parameter[];
    settings?: Record<string, Json>;
  } = {},
): FlowNode {
  const params = { ...node.params };
  if (name === "file" && fileSource) {
    const named = (file: Json | undefined) =>
      String(file || "").includes("{{")
        ? ""
        : sourceFileName(String(file || ""));
    return {
      ...node,
      label:
        !node.label || node.label === named(node.params?.file)
          ? named(value) || undefined
          : node.label,
      params: { ...params, file: value ?? "", ...settings },
    };
  }
  if (value === undefined) delete params[name];
  else params[name] = value;
  let types =
    params.types ??
    parameters.find((parameter) => parameter.name === "types")?.default;
  if (typeof types === "string") {
    try {
      types = JSON.parse(types);
    } catch {
      /* Keep an invalid draft editable. */
    }
  }
  if (
    typesInPreview &&
    (name === "delimiter" || name === "header") &&
    types &&
    typeof types === "object" &&
    !Array.isArray(types) &&
    !variableReference(types) &&
    Object.keys(types).length
  )
    params.types = {};
  if (name === listedConnection) {
    if (listedSchema) params[listedSchema] = "";
    if (listedTable) params[listedTable] = "";
  } else if (name === listedSchema && listedTable) params[listedTable] = "";
  return { ...node, params };
}
