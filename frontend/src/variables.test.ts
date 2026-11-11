import { describe, expect, it } from "vitest";
import type { Translate } from "./i18n";
import en from "./locales/en.json";
import {
  changedEnvironments,
  completeReference,
  partialReference,
  referencedVariables,
  resolveValue,
  usableInExpressions,
  variableDefaultError,
  variableNameError,
  variableProblems,
} from "./variables";

const t: Translate = (key) => en[key];

describe("computed declarations", () => {
  const computed = {
    type: "number",
    from: { node: "control", column: "amount" },
  };

  it("does not restore an ordinary fallback from a computed declaration", () => {
    expect(
      resolveValue(
        { ...computed, default: 1, environments: { prod: 2 } },
        "prod",
      ),
    ).toEqual({});
  });

  it("reports source changes in every environment and ignores descriptions", () => {
    expect(
      changedEnvironments(
        computed,
        { ...computed, from: { node: "control", column: "limit" } },
        ["dev", "prod"],
      ),
    ).toEqual(["dev", "prod"]);
    expect(
      changedEnvironments(computed, { ...computed, description: "A limit" }, [
        "dev",
        "prod",
      ]),
    ).toEqual([]);
  });

  it("reports a type change but not an inferred port spelled out", () => {
    expect(
      changedEnvironments(computed, { ...computed, type: "text" }, ["dev"]),
    ).toEqual(["dev"]);
    expect(
      changedEnvironments(
        computed,
        {
          ...computed,
          from: { node: "control", port: "result", column: "amount" },
        },
        ["dev"],
      ),
    ).toEqual([]);
  });
});

describe("expression references", () => {
  it("lists referenced variables once, in order", () => {
    expect(
      referencedVariables(
        "day >= {{var.start}} AND amount >= {{ var.threshold }} AND day < {{ var.start }} + 1",
      ),
    ).toEqual(["start", "threshold"]);
    expect(referencedVariables("{{ threshold }} AND {{ var. }}")).toEqual([]);
  });

  it("finds the reference being typed before the caret", () => {
    expect(partialReference("amount >= {{ var.")).toEqual({
      start: 10,
      prefix: "",
    });
    expect(partialReference("amount >= {{var.thr")).toEqual({
      start: 10,
      prefix: "thr",
    });
    expect(partialReference("amount >= {{ var.threshold }}")).toBeNull();
    expect(partialReference("amount >= {{ threshold")).toBeNull();
  });

  it("completes a reference and keeps the rest of the expression", () => {
    expect(completeReference("amount >= {{ var.th", 19, "threshold")).toEqual({
      text: "amount >= {{ var.threshold }}",
      caret: 29,
    });
    // A name and closing braces already written after the caret are replaced.
    expect(
      completeReference("a >= {{ var.t }} AND b", 12, "threshold"),
    ).toEqual({ text: "a >= {{ var.threshold }} AND b", caret: 24 });
    expect(completeReference("a >= 1", 6, "threshold")).toBeNull();
  });

  it("accepts only scalar variable types in expressions", () => {
    expect(
      ["text", "number", "boolean", "date", "choice(a|b)"].every(
        usableInExpressions,
      ),
    ).toBe(true);
    expect(
      ["identifier", "list<text>", "list<number>"].some(usableInExpressions),
    ).toBe(false);
  });
});

it("shares variable validation between declaration, rename and creation", () => {
  expect(variableNameError("bad name", [], t)).toBe(en.invalidVariableName);
  expect(variableNameError("amount", ["amount"], t)).toBe(en.variableExists);
  expect(variableDefaultError("number", "oops", t)).toContain(en.defaultValue);
  expect(
    variableProblems(
      {
        name: "amount",
        type: "choice(a|a)",
        default: "b",
        environments: { prod: "c" },
      },
      null,
      [],
      t,
    ),
  ).toEqual([
    en.choiceOptionsRequired,
    `${en.defaultValue}: ${en.invalidVariableValue.replace("{type}", "choice(a|a)")}`,
    `prod: ${en.invalidVariableValue.replace("{type}", "choice(a|a)")}`,
  ]);
  expect(
    variableProblems(
      { name: "amount", type: "number", from: { node: "", column: "amount" } },
      "amount",
      [],
      t,
    ),
  ).toContain(en.valueSourceRequired);
});

it("checks names only on creation and values only for literal declarations", () => {
  // An edited declaration keeps its own name, which the taken list includes.
  expect(
    variableProblems(
      { name: "amount", type: "number" },
      "amount",
      ["amount"],
      t,
    ),
  ).toEqual([]);
  expect(
    variableProblems({ name: "amount", type: "number" }, null, ["amount"], t),
  ).toEqual([en.variableExists]);
  // A computed value ignores the literal default and environment values it replaces.
  expect(
    variableProblems(
      {
        name: "amount",
        type: "number",
        default: "oops",
        environments: { prod: "oops" },
        from: { node: "control", column: "amount" },
      },
      "amount",
      [],
      t,
    ),
  ).toEqual([]);
});
