// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GuidedParameter from "./GuidedParameter";
import type { Json } from "./types";

afterEach(cleanup);
const schemas = {
  orders: [
    { name: "id", type: "BIGINT" },
    { name: "amount", type: "INTEGER" },
    { name: "status", type: "VARCHAR" },
  ],
  customers: [{ name: "key", type: "BIGINT" }],
};

it("allows SQL entry before columns are available", () => {
  const change = vi.fn();
  render(
    <GuidedParameter
      type="ordering(orders)"
      name="order"
      value={[]}
      schemas={{}}
      worktree="worktree"
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByText("Advanced SQL"));
  expect(change).toHaveBeenCalledWith("");
});

function Form({ type, saved }: { type: string; saved: Json }) {
  const [value, setValue] = useState(saved);
  return (
    <>
      <GuidedParameter
        type={type}
        name="custom_rules"
        value={value}
        schemas={schemas}
        onChange={setValue}
      />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}

it("restores nested conditions from saved parameters and edits them without a template ID", () => {
  render(
    <Form
      type="conditions(orders)"
      saved={{
        mode: "and",
        conditions: [
          {
            mode: "or",
            conditions: [{ column: "status", operator: "=", value: "paid" }],
          },
        ],
      }}
    />,
  );
  expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(
    "paid",
  );
  fireEvent.change(screen.getByLabelText("Value"), {
    target: { value: "001" },
  });
  expect(screen.getByRole("status").textContent).toContain('"value":"001"');
  fireEvent.click(screen.getAllByText("Add condition")[1]);
  expect(
    screen.getAllByLabelText("Column", { selector: "select" }),
  ).toHaveLength(2);
});

it("uses the two declared input ports for any join parameter", () => {
  render(
    <Form
      type="join_keys(orders,customers)"
      saved={[{ left: "id", right: "key" }]}
    />,
  );
  expect(
    (
      screen.getByLabelText("Left key", {
        selector: "select",
      }) as HTMLInputElement
    ).value,
  ).toBe("id");
  expect(
    (
      screen.getByLabelText("Right key", {
        selector: "select",
      }) as HTMLInputElement
    ).value,
  ).toBe("key");
  fireEvent.click(screen.getByText("Add key pair"));
  expect(
    screen.getAllByLabelText("Left key", { selector: "select" }),
  ).toHaveLength(2);
  expect(
    screen.getAllByLabelText("Right key", { selector: "select" })[1]
      .textContent,
  ).not.toContain("amount");
});

it("offers numeric columns for SUM and preserves aliases", () => {
  render(
    <Form
      type="measures(orders)"
      saved={[{ function: "SUM", column: "amount", alias: "revenue" }]}
    />,
  );
  expect(
    (screen.getByLabelText("Output column name") as HTMLInputElement).value,
  ).toBe("revenue");
  expect(
    screen.getByLabelText("Column", { selector: "select" }).textContent,
  ).not.toContain("status");
  fireEvent.click(screen.getByText("Add a measure"));
  expect(
    screen.getAllByLabelText("Function", { selector: "select" }),
  ).toHaveLength(2);
});

it("keeps advanced SQL editable without silently replacing it with form state", () => {
  const change = vi.fn();
  render(
    <GuidedParameter
      type="conditions(orders)"
      name="custom"
      value="amount > 5"
      schemas={schemas}
      onChange={change}
    />,
  );
  expect(
    (screen.getByLabelText(/Advanced SQL/) as HTMLInputElement).value,
  ).toBe("amount > 5");
  fireEvent.change(screen.getByLabelText(/Advanced SQL/), {
    target: { value: "amount > 10" },
  });
  expect(change).toHaveBeenCalledWith("amount > 10");
  expect(screen.queryByText("Add condition")).toBeNull();
});

it("chooses columns with checkboxes, in the order they are checked", () => {
  render(<Form type="group_columns(orders)" saved={["missing"]} />);
  // A saved name the input lacks stays listed so it can be unchecked.
  fireEvent.click(screen.getByRole("checkbox", { name: "missing" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^status/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^id/ }));
  expect(screen.getByRole("status").textContent).toBe('["status","id"]');
  expect(screen.queryByRole("checkbox", { name: "missing" })).toBeNull();
});

it("offers the variables of the environment as a condition value", () => {
  const change = vi.fn();
  const variable = (type: string, value: Json) => ({
    type,
    description: "",
    environments: {},
    errors: [],
    warnings: [],
    values: { dev: { value } },
    usages: [],
  });
  render(
    <GuidedParameter
      type="conditions(orders)"
      name="condition"
      value={{ column: "amount", operator: ">=", value: "10" }}
      schemas={schemas}
      expressionVariables={{
        environment: "dev",
        summary: {
          file_error: null,
          undeclared: {},
          diagnostics: [],
          warnings: [],
          declarations: {
            threshold: variable("number", 20),
            schema_name: variable("identifier", "DEMO"),
          },
        },
      }}
      onChange={change}
    />,
  );
  const source = screen.getByLabelText("Value source") as HTMLSelectElement;
  // Only variables an expression can bind are offered, with their value.
  expect([...source.options].map((o) => o.textContent)).toEqual([
    "Fixed value",
    "threshold · 20",
  ]);
  fireEvent.change(source, { target: { value: "threshold" } });
  expect(change).toHaveBeenCalledWith({
    column: "amount",
    operator: ">=",
    value: "{{ var.threshold }}",
  });
});
