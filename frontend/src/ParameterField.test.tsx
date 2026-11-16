// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ParameterField from "./ParameterField";
import { useState } from "react";
import type { Json } from "./types";
import { VariableValueInput } from "./VariableFields";
import { validValue, VARIABLE_TYPES, variableTypeFor } from "./variables";

afterEach(cleanup);

function ListField({
  type,
  initial,
  onChange,
  onBlur,
  variable = false,
}: {
  type: string;
  initial: Json;
  onChange: (value: Json | undefined) => void;
  onBlur?: () => void;
  variable?: boolean;
}) {
  const [value, setValue] = useState<Json | undefined>(initial);
  const change = (next: Json | undefined) => {
    setValue(next);
    onChange(next);
  };
  return variable ? (
    <VariableValueInput
      type={type}
      value={value}
      onChange={change}
      label="items"
    />
  ) : (
    <ParameterField
      parameter={{ name: "items", type }}
      value={value}
      onChange={change}
      onBlur={onBlur}
      connections={[]}
    />
  );
}

it.each<[string, Json, string, Json[]]>([
  ["list<number>", [1], " 1, -2.50, 1e-3, 0 ", [1, -2.5, 0.001, 0]],
  ["list<boolean>", [true], " true, FALSE, false ", [true, false, false]],
  ["list<text>", ["a"], " New York, Paris ", ["New York", "Paris"]],
  ["list<column>", ["id"], " order id, amount ", ["order id", "amount"]],
])(
  "edits %s as typed values and normalizes only on blur",
  (type, initial, text, expected) => {
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(
      <ListField
        type={type}
        initial={initial}
        onChange={onChange}
        onBlur={onBlur}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "items",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(input.value).toBe(text);
    expect(screen.getByText(type)).toBeTruthy();
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("Leave blank for an empty list");
    fireEvent.blur(input);
    expect(input.value).toBe(expected.join(", "));
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.validationMessage).toBe("");
    for (const empty of ["", "   ", ", ,"]) {
      fireEvent.change(input, { target: { value: empty } });
      expect(onChange).toHaveBeenLastCalledWith([]);
      fireEvent.blur(input);
      expect(input.value).toBe("");
    }
  },
);

it.each<[string, string, Json[], string, string, Json[]]>([
  [
    "list<number>",
    "1, abc, 3",
    [1, "abc", 3],
    "Item 2: enter a finite number.",
    "1, 2",
    [1, 2],
  ],
  [
    "list<number>",
    "1, 1e999",
    [1, "1e999"],
    "Item 2: enter a finite number.",
    "1, 2",
    [1, 2],
  ],
  [
    "list<boolean>",
    "true, maybe, false",
    [true, "maybe", false],
    "Item 2: enter true or false.",
    "true, false",
    [true, false],
  ],
])(
  "keeps an invalid %s draft visible until corrected: %s",
  (type, text, expected, message, corrected, valid) => {
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(
      <ListField
        type={type}
        initial={[]}
        onChange={onChange}
        onBlur={onBlur}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "items",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(input.getAttribute("aria-describedby")).toContain(
      screen.getByRole("alert").id,
    );
    fireEvent.blur(input);
    expect(input.value).toBe(text);
    expect(input.validationMessage).toBe(message);
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: corrected } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(valid);
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.validationMessage).toBe("");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each([false, true])(
  "uses the same number list behavior in node and variable forms (variable: %s)",
  (variable) => {
    const onChange = vi.fn();
    render(
      <ListField
        type="list<number>"
        initial={[1]}
        onChange={onChange}
        variable={variable}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "items",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1, -2.5, 3e2" } });
    expect(onChange).toHaveBeenLastCalledWith([1, -2.5, 300]);
    fireEvent.change(input, { target: { value: "1, abc" } });
    expect(onChange).toHaveBeenLastCalledWith([1, "abc"]);
    expect(validValue("list<number>", onChange.mock.lastCall![0])).toBe(false);
    fireEvent.blur(input);
    expect(input.value).toBe("1, abc");
    expect(input.validationMessage).toBe("Item 2: enter a finite number.");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(input.validationMessage).toBe("");
  },
);

it("keeps variable list types limited to text and number", () => {
  expect(VARIABLE_TYPES.filter((type) => type.startsWith("list"))).toEqual([
    "list<text>",
    "list<number>",
  ]);
  expect(variableTypeFor("list<boolean>")).toBeNull();
  expect(variableTypeFor("list<column>")).toBeNull();
});

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
      objects={{ names: [], pending: true, error: "", complete: true }}
    />,
  );
  expect(screen.getByText("Listing schemas and tables…")).toBeTruthy();
  rerender(
    <ParameterField
      parameter={{ name: "table", type: "table_name(schema)", default: "" }}
      value=""
      onChange={onChange}
      connections={connections}
      objects={{
        names: ["order_totals", "orders"],
        pending: false,
        error: "",
        complete: true,
      }}
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
      objects={{
        names: [],
        pending: false,
        error: "password failed",
        complete: false,
      }}
    />,
  );
  expect(
    screen.getByText("Cannot list schemas and tables: password failed"),
  ).toBeTruthy();
  // Without a complete listing, a name typed by hand stays possible.
  const typed = screen.getByRole("combobox", { name: "table" });
  expect(typed.tagName).toBe("INPUT");
  fireEvent.change(typed, { target: { value: "new_table" } });
  expect(onChange).toHaveBeenLastCalledWith("new_table");
});

it("suggests the listed names while typing when the listing is truncated", () => {
  render(
    <ParameterField
      parameter={{ name: "table", type: "table_name(schema)", default: "" }}
      value=""
      onChange={() => undefined}
      connections={connections}
      objects={{
        names: ["order_totals", "orders"],
        pending: false,
        error: "",
        complete: false,
      }}
    />,
  );
  const input = screen.getByRole("combobox", { name: "table" });
  const list = document.getElementById(input.getAttribute("list")!);
  expect(Array.from(list!.querySelectorAll("option"), (o) => o.value)).toEqual([
    "order_totals",
    "orders",
  ]);
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
