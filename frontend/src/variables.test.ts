import { describe, expect, it } from "vitest";
import {
  completeReference,
  partialReference,
  referencedVariables,
  usableInExpressions,
} from "./variables";

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
