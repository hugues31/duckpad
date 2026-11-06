// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ParameterField from "./ParameterField";

afterEach(cleanup);

const connections = [
  {
    id: "finance_share",
    name: "Finance share",
    family: "storage" as const,
    capabilities: ["read" as const],
  },
  {
    id: "warehouse",
    name: "Warehouse",
    family: "database" as const,
    capabilities: ["read" as const],
  },
];

it("names a file node's connection Location and lists only file storage", () => {
  const onChange = vi.fn();
  render(
    <ParameterField
      parameter={{ name: "connection", type: "connection", default: "" }}
      value=""
      onChange={onChange}
      connections={connections}
      location
    />,
  );
  const location = screen.getByRole("combobox", { name: "Location" });
  expect(location).toHaveProperty("value", "");
  expect(
    Array.from(location.querySelectorAll("option"), (o) => o.textContent),
  ).toEqual(["Project files", "Finance share"]);
  fireEvent.change(location, { target: { value: "finance_share" } });
  expect(onChange).toHaveBeenLastCalledWith("finance_share");
});

it("keeps project files selectable once a connection is chosen", () => {
  const onChange = vi.fn();
  render(
    <ParameterField
      parameter={{ name: "connection", type: "connection", default: "" }}
      value="finance_share"
      onChange={onChange}
      connections={connections}
      location
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), {
    target: { value: "" },
  });
  expect(onChange).toHaveBeenLastCalledWith("");
});

it("asks for a database connection that SQL uses directly", () => {
  render(
    <ParameterField
      parameter={{ name: "connection", type: "connection", default: "" }}
      value=""
      onChange={() => {}}
      connections={connections}
    />,
  );
  const connection = screen.getByRole("combobox", { name: "connection" });
  expect(
    Array.from(connection.querySelectorAll("option"), (o) => o.textContent),
  ).toEqual(["Choose a source…", "Warehouse"]);
});

it("selects table names listed from the database connection", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ParameterField
      parameter={{ name: "table", type: "table_name(schema)", default: "" }}
      value=""
      onChange={onChange}
      connections={connections}
      objects={{ names: [], pending: true, error: "" }}
    />,
  );
  expect(screen.getByText("Listing schemas and tables…")).toBeTruthy();
  rerender(
    <ParameterField
      parameter={{ name: "table", type: "table_name(schema)", default: "" }}
      value=""
      onChange={onChange}
      connections={connections}
      objects={{ names: ["order_totals", "orders"], pending: false, error: "" }}
    />,
  );
  const input = screen.getByRole("combobox", { name: "table" });
  expect(Array.from(input.querySelectorAll("option"), (o) => o.value)).toEqual([
    "",
    "order_totals",
    "orders",
  ]);
  fireEvent.change(input, { target: { value: "orders" } });
  expect(onChange).toHaveBeenLastCalledWith("orders");
  rerender(
    <ParameterField
      parameter={{ name: "table", type: "table_name(schema)", default: "" }}
      value=""
      onChange={onChange}
      connections={connections}
      objects={{ names: [], pending: false, error: "password failed" }}
    />,
  );
  expect(
    screen.getByText("Cannot list schemas and tables: password failed"),
  ).toBeTruthy();
});

it("explains integer and bound errors on numeric Python fields", () => {
  render(
    <ParameterField
      parameter={{
        name: "limit",
        type: "number",
        python_type: "int",
        ge: 1,
        le: 10,
      }}
      value={1}
      onChange={() => {}}
      connections={[]}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "limit",
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "2.5" } });
  fireEvent.blur(input);
  expect(input.validationMessage).toBe("Enter a whole number");
  fireEvent.change(input, { target: { value: "11" } });
  fireEvent.blur(input);
  expect(input.validationMessage).toBe("The value must satisfy: ≥ 1, ≤ 10");
  expect(screen.getByText("int · ≥ 1 · ≤ 10")).toBeTruthy();
});
