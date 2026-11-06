// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import QueryBuilder from "./QueryBuilder";

afterEach(cleanup);

function choose(label: string, value: string) {
  fireEvent.change(
    screen.getByLabelText(label, { selector: "input, select" }),
    {
      target: { value },
    },
  );
}

it.each([
  ["VARCHAR", "001", "'001'"],
  ["VARCHAR", "true", "'true'"],
  ["VARCHAR", "false", "'false'"],
  ["VARCHAR", "null", "'null'"],
  ["VARCHAR", "O'Brien", "'O''Brien'"],
  ["VARCHAR", " 001 ", "' 001 '"],
  ["INTEGER", "001", "001"],
  ["BIGINT", "9007199254740993", "9007199254740993"],
  ["DECIMAL(18,2)", "-1.25", "-1.25"],
  ["DOUBLE", "1e-3", "1e-3"],
  ["BOOLEAN", "TrUe", "TRUE"],
  ["BOOLEAN", "false", "FALSE"],
  ["DATE", "2026-11-03", "'2026-11-03'"],
  ["ENUM('001', '002')", "001", "'001'"],
  ["", "001", "'001'"],
  ["INTEGER", "1 OR TRUE", "'1 OR TRUE'"],
])("formats a %s filter value %j using its column type", (type, value, sql) => {
  const onChange = vi.fn();
  render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: 'order"code', type }] }}
      onChange={onChange}
    />,
  );
  choose("Column", 'order"code');
  choose("Value", value);
  expect(onChange).toHaveBeenLastCalledWith({
    condition: `"order""code" = ${sql}`,
  });
});

it("writes no filter condition before its value is entered", () => {
  const onChange = vi.fn();
  render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "amount", type: "INTEGER" }] }}
      onChange={onChange}
    />,
  );
  choose("Column", "amount");
  choose("Operator", ">");
  // An existing hand-written condition stays until the form is complete.
  expect(onChange).not.toHaveBeenCalled();
  choose("Value", "2");
  expect(onChange).toHaveBeenLastCalledWith({ condition: '"amount" > 2' });
});

it.each(["IS NULL", "IS NOT NULL"])(
  "keeps %s separate from text values",
  (op) => {
    const onChange = vi.fn();
    render(
      <QueryBuilder
        kind="filter"
        schemas={{ source: [{ name: "code", type: "VARCHAR" }] }}
        onChange={onChange}
      />,
    );
    choose("Column", "code");
    choose("Value", "null");
    choose("Operator", op);
    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ condition: `"code" ${op}` });
  },
);

it("uses the refreshed column type when the source schema changes", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "code", type: "INTEGER" }] }}
      onChange={onChange}
    />,
  );
  choose("Column", "code");
  choose("Value", "001");
  expect(onChange).toHaveBeenLastCalledWith({ condition: '"code" = 001' });
  rerender(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "code", type: "VARCHAR" }] }}
      onChange={onChange}
    />,
  );
  choose("Value", "002");
  expect(onChange).toHaveBeenLastCalledWith({ condition: "\"code\" = '002'" });
});

it("keeps typed input names available for joins", () => {
  const onChange = vi.fn();
  render(
    <QueryBuilder
      kind="join"
      schemas={{
        left: [{ name: "code", type: "VARCHAR" }],
        right: [{ name: "id", type: "VARCHAR" }],
      }}
      onChange={onChange}
    />,
  );
  choose("Left key", "code");
  choose("Right key", "id");
  expect(onChange).toHaveBeenLastCalledWith({
    condition: 'l."code" = r."id"',
  });
});

it("writes nothing until the form is complete, then each change", () => {
  const onChange = vi.fn();
  render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "amount", type: "INTEGER" }] }}
      onChange={onChange}
    />,
  );
  choose("Operator", ">");
  choose("Value", "10");
  expect(onChange).not.toHaveBeenCalled();
  choose("Column", "amount");
  expect(onChange).toHaveBeenLastCalledWith({ condition: '"amount" > 10' });
  choose("Value", "100");
  expect(onChange).toHaveBeenLastCalledWith({ condition: '"amount" > 100' });
});

it("writes aggregates once groups and measures are valid", () => {
  const onChange = vi.fn();
  render(
    <QueryBuilder
      kind="aggregate"
      schemas={{
        source: [
          { name: "region", type: "VARCHAR" },
          { name: "amount", type: "INTEGER" },
        ],
      }}
      onChange={onChange}
    />,
  );
  const groups = screen.getByLabelText("Group by columns", {
    selector: "select",
  }) as HTMLSelectElement;
  groups.options[0].selected = true;
  fireEvent.change(groups);
  expect(onChange).not.toHaveBeenCalled();
  choose("Column", "amount");
  expect(onChange).toHaveBeenLastCalledWith({
    groups: '"region"',
    measures: 'SUM("amount") AS "total"',
  });
});
