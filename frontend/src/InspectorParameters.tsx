import { applyParameterChange } from "./nodeParameters";
import ParameterField from "./ParameterField";
import { typeArgument } from "./parameterType";
import type { RefObject } from "react";
import type {
  Column,
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
  listedConnection,
  listedSchema,
  listedTable,
  blur,
  connections,
  locations,
  valueOf,
  csvSource,
  objectNames,
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
  inputColumns: Record<string, Column[]>;
  schemas: Record<string, string[]>;
}) {
  return (
    <>
      {parameters
        .filter((p) => !(typesInPreview && p.name === "types"))
        .map((parameter) => {
          const value = draft.params?.[parameter.name] ?? parameter.default;
          const type = parameter.type || "text";
          const reference = variableReference(value);
          const variableType = bindable ? variableTypeFor(type) : null;
          // Column parameters name the input port they choose from.
          const port = typeArgument(parameter.type);
          return (
            <ParameterField
              key={parameter.name}
              worktree={snapshot.worktree.id}
              parameter={parameter}
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
              projectFile={type.startsWith("file") && !valueOf(port)}
              csv={csvSource}
              objects={objectNames(parameter)}
              columns={port ? inputColumns[port] : undefined}
              schemas={(port && schemas[port]) || Object.values(schemas).flat()}
            />
          );
        })}
    </>
  );
}
