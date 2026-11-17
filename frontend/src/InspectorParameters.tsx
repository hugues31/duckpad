import { useT } from "./i18n";
import { applyParameterChange } from "./nodeParameters";
import ParameterField from "./ParameterField";
import { baseType, typeArgument } from "./parameterType";
import ResourceBrowser from "./ResourceBrowser";
import {
  databaseSource,
  openingFolder,
  storageSource,
} from "./resourceBrowsing";
import { useMemo, useState, type RefObject } from "react";
import type {
  Column,
  DatabaseObjects,
  Diagnostic,
  FlowNode,
  Json,
  Parameter,
  Snapshot,
} from "./types";
import { BoundVariable, VariablePicker } from "./VariableBinding";
import {
  bindTo,
  variableReference,
  variableSummary,
  variableTypeFor,
  type Declaration,
} from "./variables";

export default function InspectorParameters({
  parameters,
  typesInPreview,
  draft,
  bindable,
  snapshot,
  readOnly,
  setParameter,
  persist,
  declared,
  rejection,
  worktree,
  environment,
  nodeProblems,
  update,
  fileSource,
  folderSource,
  listedConnection,
  listedSchema,
  listedTable,
  blur,
  connections,
  locations,
  valueOf,
  csvSource,
  objectNames,
  database,
  databaseObjects,
  inputColumns,
  schemas,
}: {
  parameters: Parameter[];
  typesInPreview: boolean;
  draft: FlowNode;
  bindable: boolean;
  snapshot: Snapshot;
  readOnly: boolean;
  setParameter: (name: string, value: Json | undefined) => void;
  persist: () => Promise<boolean>;
  declared: RefObject<Record<string, Declaration>>;
  rejection: () => unknown;
  worktree: string;
  environment: string;
  nodeProblems: Diagnostic[];
  update: (change: (current: FlowNode) => FlowNode) => void;
  fileSource: boolean;
  /** The node reads a table folder: its path is typed, never picked among uploads. */
  folderSource?: boolean;
  listedConnection: string | undefined;
  listedSchema: string | undefined;
  listedTable: string | undefined;
  blur: () => void;
  connections: Snapshot["connections"];
  locations: Set<string | undefined>;
  valueOf: (name?: string) => string;
  csvSource: boolean;
  objectNames: (parameter: {
    name: string;
    type: string;
  }) =>
    | { complete: boolean; pending: boolean; error: string; names: string[] }
    | undefined;
  /** The database connection whose schemas and tables are listed, and its listing once loaded. */
  database: string;
  databaseObjects: DatabaseObjects | null;
  inputColumns: Record<string, Column[]>;
  schemas: Record<string, string[]>;
}) {
  const t = useT();
  // The parameter whose connection is being browsed.
  const [browsed, setBrowsed] = useState<string | null>(null);
  const browsedParameter = parameters.find((p) => p.name === browsed);
  const browsedFile =
    !!browsedParameter && baseType(browsedParameter.type) === "file";
  const storage = browsedFile
    ? valueOf(typeArgument(browsedParameter!.type))
    : "";
  const source = useMemo(
    () =>
      storage
        ? storageSource(worktree, storage, environment)
        : databaseObjects && databaseSource(databaseObjects),
    [storage, worktree, environment, databaseObjects],
  );
  const connectionName = (id: string) =>
    connections.find((c) => c.id === id)?.name ?? id;
  const chooseFile = (path: string) => {
    update((current) =>
      applyParameterChange(current, browsed!, path, {
        fileSource,
        typesInPreview,
        listedConnection,
        listedSchema,
        listedTable,
        parameters,
      }),
    );
    setBrowsed(null);
    blur();
  };
  const filePath = browsedFile ? valueOf(browsed!) : "";
  return (
    <>
      {browsedParameter && source && browsedFile && (
        <ResourceBrowser
          title={t("browseChooseFile")}
          family="storage"
          root={connectionName(storage)}
          source={source}
          initialPath={openingFolder(filePath)}
          current={filePath.split("/").filter(Boolean)}
          onChoose={(entry) => chooseFile(entry.path.join("/"))}
          onChooseFolder={(path) => chooseFile(path.join("/"))}
          onClose={() => setBrowsed(null)}
        />
      )}
      {browsedParameter && source && !browsedFile && databaseObjects && (
        <ResourceBrowser
          title={t("browseChooseTable")}
          family="database"
          root={connectionName(database)}
          source={source}
          initialPath={
            databaseObjects.schemas.includes(valueOf(listedSchema))
              ? [valueOf(listedSchema)]
              : databaseObjects.schemas.length === 1
                ? databaseObjects.schemas
                : []
          }
          current={[valueOf(listedSchema), valueOf(listedTable)]}
          onChoose={(entry) => {
            const [schema, table] = entry.path;
            update((current) => ({
              ...current,
              params: {
                ...current.params,
                [listedSchema!]: schema,
                [listedTable!]: table,
              },
            }));
            setBrowsed(null);
            blur();
          }}
          onClose={() => setBrowsed(null)}
        />
      )}
      {parameters
        .filter((p) => !(typesInPreview && p.name === "types"))
        .map((parameter) => {
          const value = draft.params?.[parameter.name] ?? parameter.default;
          const type = parameter.type || "text";
          const reference = variableReference(value);
          const variableType = bindable ? variableTypeFor(type) : null;
          // Column parameters name the input port they choose from.
          const port = typeArgument(parameter.type);
          const folder = !!folderSource && type.startsWith("file");
          const base = baseType(type);
          // A file below a storage connection, or a table of the listed database.
          const browsable =
            base === "file"
              ? connections.some(
                  (c) => c.id === valueOf(port) && c.family === "storage",
                )
              : parameter.name === listedTable &&
                !!objectNames(parameter) &&
                !!databaseObjects;
          return (
            <ParameterField
              key={parameter.name}
              worktree={snapshot.worktree.id}
              parameter={
                folder
                  ? { ...parameter, description: t("tableFolderHint") }
                  : parameter
              }
              value={value}
              variable={
                variableType || reference
                  ? {
                      control: variableType && (
                        <VariablePicker
                          snapshot={snapshot}
                          parameter={parameter.name}
                          parameterType={type}
                          variableType={variableType}
                          value={reference ? undefined : value}
                          disabled={readOnly}
                          onBind={(name) => {
                            setParameter(parameter.name, bindTo(name));
                            void persist();
                          }}
                          onCreate={async (name, declaration) => {
                            declared.current[name] = declaration;
                            setParameter(parameter.name, bindTo(name));
                            if (!(await persist())) throw rejection();
                          }}
                        />
                      ),
                      bound: reference && (
                        <BoundVariable
                          snapshot={snapshot}
                          worktree={worktree}
                          environment={environment}
                          parameter={parameter.name}
                          parameterType={type}
                          name={reference}
                          problem={
                            nodeProblems.find(
                              (item) => item.parameter === parameter.name,
                            )?.message
                          }
                          disabled={readOnly}
                          onUnbind={() => {
                            // Keep computing the same value, now written in the node.
                            const current = variableSummary(snapshot, reference)
                              ?.values[environment];
                            setParameter(parameter.name, current?.value);
                            void persist();
                          }}
                        />
                      ),
                    }
                  : undefined
              }
              onChange={(value, settings) =>
                update((current) =>
                  applyParameterChange(current, parameter.name, value, {
                    fileSource,
                    typesInPreview,
                    listedConnection,
                    listedSchema,
                    listedTable,
                    parameters,
                    settings,
                  }),
                )
              }
              onBlur={blur}
              expressionVariables={
                bindable
                  ? { summary: snapshot.variables, environment }
                  : undefined
              }
              connections={connections}
              location={type === "connection" && locations.has(parameter.name)}
              projectFile={type.startsWith("file") && !valueOf(port) && !folder}
              csv={csvSource}
              objects={objectNames(parameter)}
              onBrowse={
                browsable ? () => setBrowsed(parameter.name) : undefined
              }
              inputColumns={inputColumns}
              columns={port ? inputColumns[port] : undefined}
              schemas={(port && schemas[port]) || Object.values(schemas).flat()}
            />
          );
        })}
    </>
  );
}
