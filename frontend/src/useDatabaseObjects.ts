import { withQuery } from "./api";
import { baseType, typeArgument } from "./parameterType";
import type { DatabaseObjects, FlowNode, Parameter, Snapshot } from "./types";
import { useApiResource } from "./useApiResource";
export function useDatabaseObjects(
  parameters: Parameter[],
  draft: FlowNode,
  connections: Snapshot["connections"],
  enabled: boolean,
  worktree: string,
  environment: string,
) {
  // Schema and table names are listed from the database connection of the first schema
  // parameter. Fields bound to another connection get no suggestions.
  const valueOf = (name?: string) => {
    const parameter = parameters.find((p) => p.name === name);
    const value = draft.params?.[name ?? ""] ?? parameter?.default;
    return typeof value === "string" ? value : "";
  };
  const argumentOf = (name?: string) =>
    typeArgument(parameters.find((p) => p.name === name)?.type || "");
  const listedSchema = parameters.find((p) =>
    p.type.startsWith("schema_name("),
  )?.name;
  const listedConnection = argumentOf(listedSchema);
  const database = valueOf(listedConnection);
  const objects = useApiResource<DatabaseObjects>(
    enabled &&
      connections.some((c) => c.id === database && c.family === "database")
      ? withQuery(
          `/worktrees/${worktree}/connections/${encodeURIComponent(database)}/objects`,
          { environment },
        )
      : null,
  );
  const objectNames = (parameter: { name: string; type: string }) => {
    if (!listedConnection) return undefined;
    const base = baseType(parameter.type);
    const argument = argumentOf(parameter.name);
    // The listing's progress and error show once, under the first schema field.
    const status = {
      ...(parameter.name === listedSchema
        ? { pending: objects.pending, error: objects.error }
        : { pending: false, error: "" }),
      // Without a complete listing, names are typed instead of chosen.
      complete: objects.pending || !!(objects.data && !objects.data.truncated),
    };
    if (base === "schema_name" && argument === listedConnection)
      return { names: objects.data?.schemas ?? [], ...status };
    if (base === "table_name" && argumentOf(argument) === listedConnection)
      return {
        names: (objects.data?.tables ?? [])
          .filter((table) => table.schema === valueOf(argument))
          .map((table) => table.name),
        ...status,
      };
    return undefined;
  };

  return { valueOf, listedSchema, listedConnection, database, objectNames };
}
