import { expect, it } from "vitest";
import { baseType, typeArgument, typeOptions } from "./parameterType";

it.each([
  [" column(orders) ", "column", "orders", ["orders"]],
  ["choice( pending | paid )", "choice", "pending | paid", ["pending", "paid"]],
  ["keyword(count(*)|sum)", "keyword", "count(*)|sum", ["count(*)", "sum"]],
  ["list<text>", "list", undefined, []],
  ["number", "number", undefined, []],
  ["choice(", "choice", undefined, []],
  ["column(source) trailing", "column", undefined, []],
])("parses %s consistently", (type, base, argument, options) => {
  expect(baseType(type as string)).toBe(base);
  expect(typeArgument(type as string)).toBe(argument);
  expect(typeOptions(type as string)).toEqual(options);
});
