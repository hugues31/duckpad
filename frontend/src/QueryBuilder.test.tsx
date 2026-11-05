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

function apply() {
  fireEvent.click(screen.getByRole("button", { name: "Apply to parameters" }));
}

it.each([
  ["VARCHAR", "001", "'001'"],
  ["VARCHAR", "true", "'true'"],
  ["VARCHAR", "false", "'false'"],
  ["VARCHAR", "null", "'null'"],
  ["VARCHAR", "O'Brien", "'O''Brien'"],
  ["VARCHAR", "", "''"],
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
  const onApply = vi.fn();
  render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: 'order"code', type }] }}
      onApply={onApply}
    />,
  );
  choose("Column", 'order"code');
  choose("Value", value);
  apply();
  expect(onApply).toHaveBeenLastCalledWith({
    condition: `"order""code" = ${sql}`,
  });
});

it.each(["IS NULL", "IS NOT NULL"])(
  "keeps %s separate from text values",
  (op) => {
    const onApply = vi.fn();
    render(
      <QueryBuilder
        kind="filter"
        schemas={{ source: [{ name: "code", type: "VARCHAR" }] }}
        onApply={onApply}
      />,
    );
    choose("Column", "code");
    choose("Value", "null");
    choose("Operator", op);
    expect(screen.queryByLabelText("Value")).toBeNull();
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ condition: `"code" ${op}` });
  },
);

it("uses the refreshed column type when the source schema changes", () => {
  const onApply = vi.fn();
  const { rerender } = render(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "code", type: "INTEGER" }] }}
      onApply={onApply}
    />,
  );
  choose("Column", "code");
  choose("Value", "001");
  apply();
  expect(onApply).toHaveBeenLastCalledWith({ condition: '"code" = 001' });
  rerender(
    <QueryBuilder
      kind="filter"
      schemas={{ source: [{ name: "code", type: "VARCHAR" }] }}
      onApply={onApply}
    />,
  );
  apply();
  expect(onApply).toHaveBeenLastCalledWith({ condition: "\"code\" = '001'" });
});

it("keeps typed input names available for joins", () => {
  const onApply = vi.fn();
  render(
    <QueryBuilder
      kind="join"
      schemas={{
        left: [{ name: "code", type: "VARCHAR" }],
        right: [{ name: "id", type: "VARCHAR" }],
      }}
      onApply={onApply}
    />,
  );
  choose("Left key", "code");
  choose("Right key", "id");
  apply();
  expect(onApply).toHaveBeenLastCalledWith({
    condition: 'l."code" = r."id"',
  });
});
