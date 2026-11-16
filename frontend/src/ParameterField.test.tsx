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
  schemas,
}: {
  type: string;
  initial: Json;
  onChange: (value: Json | undefined) => void;
  onBlur?: () => void;
  variable?: boolean;
  schemas?: string[];
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
      schemas={schemas}
    />
  );
}

function renderList(type: string, initial: Json, schemas?: string[]) {
  const onChange = vi.fn();
  const onBlur = vi.fn();
  render(
    <ListField
      type={type}
      initial={initial}
      onChange={onChange}
      onBlur={onBlur}
      schemas={schemas}
    />,
  );
  // Suggestions make the text field a combobox.
  const input = screen.getByRole(schemas ? "combobox" : "textbox", {
    name: "items",
  }) as HTMLInputElement;
  const chips = () =>
    [...document.querySelectorAll(".list-chip-value")].map(
      (chip) => chip.textContent,
    );
  return { input, chips, onChange, onBlur };
}

it.each<[string, Json[], string, Json[], string[]]>([
  [
    "list<number>",
    [1],
    " 1, -2.50, 1e-3, 0 ",
    [1, -2.5, 0.001, 0],
    ["1", "-2.5", "0.001", "0"],
  ],
  [
    "list<boolean>",
    [true],
    " true, FALSE, false ",
    [true, false, false],
    ["true", "false", "false"],
  ],
  [
    "list<text>",
    ["a"],
    " New York, Paris ",
    ["New York", "Paris"],
    ["New York", "Paris"],
  ],
  [
    "list<column>",
    ["id"],
    " order id, amount ",
    ["order id", "amount"],
    ["order id", "amount"],
  ],
])(
  "edits %s as separate typed values",
  (type, initial, text, expected, shown) => {
    const { input, chips, onChange, onBlur } = renderList(type, initial);
    expect(screen.getByText(type)).toBeTruthy();
    expect(chips()).toEqual(initial.map((item) => String(item)));
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${initial[0]}` }),
    );
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(chips()).toEqual([]);
    expect(input.placeholder).not.toBe("");
    // A comma adds the values before it; the text after it stays typed.
    fireEvent.change(input, { target: { value: text } });
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(chips()).toEqual(shown.slice(0, -1));
    expect(input.value).toBe(text.split(",").at(-1)!.trimStart());
    expect(input.placeholder).toBe("");
    fireEvent.blur(input);
    expect(chips()).toEqual(shown);
    expect(input.value).toBe("");
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.validationMessage).toBe("");
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("Type a comma or press Enter");
  },
);

it("adds with Enter, edits values in place and takes the last one back", () => {
  const { input, chips, onChange } = renderList("list<number>", [1, 2, 3]);
  fireEvent.change(input, { target: { value: "4" } });
  expect(onChange).toHaveBeenLastCalledWith([1, 2, 3, 4]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["1", "2", "3", "4"]);
  expect(input.value).toBe("");

  // Clicking a value moves the text field to its place.
  fireEvent.click(screen.getByText("2"));
  expect(input.value).toBe("2");
  expect(input.style.order).toBe("1");
  expect(chips()).toEqual(["1", "3", "4"]);
  expect(input).toBe(document.activeElement);
  fireEvent.change(input, { target: { value: "20, 21" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith([1, 20, 21, 3, 4]);
  expect(chips()).toEqual(["1", "20", "21", "3", "4"]);

  // Backspace in the empty field brings the previous value back as text.
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(input.value).toBe("4");
  expect(chips()).toEqual(["1", "20", "21", "3"]);
  expect(onChange).toHaveBeenLastCalledWith([1, 20, 21, 3, 4]);
  fireEvent.change(input, { target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith([1, 20, 21, 3]);

  // Arrows move between values; Delete removes the next one.
  fireEvent.keyDown(input, { key: "ArrowLeft" });
  fireEvent.keyDown(input, { key: "ArrowLeft" });
  expect(input.style.order).toBe("2");
  fireEvent.keyDown(input, { key: "Delete" });
  expect(onChange).toHaveBeenLastCalledWith([1, 20, 3]);
  fireEvent.change(input, { target: { value: "5" } });
  expect(onChange).toHaveBeenLastCalledWith([1, 20, 5, 3]);
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(chips()).toEqual(["1", "20", "5", "3"]);
  expect(input.style.order).toBe("4");
});

it("keeps Enter for the form when no value is typed", () => {
  const { input } = renderList("list<text>", ["a"]);
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  fireEvent.change(input, { target: { value: "b" } });
  const typed = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(typed);
  expect(typed.defaultPrevented).toBe(true);
});

it.each<[string, string, Json[], string, string, string, Json[]]>([
  [
    "list<number>",
    "1, abc, 3",
    [1, "abc", 3],
    "abc",
    "“abc” is not a number.",
    "2",
    [1, 2, 3],
  ],
  [
    "list<number>",
    "1, 1e999, 3",
    [1, "1e999", 3],
    "1e999",
    "“1e999” is not a number.",
    "2",
    [1, 2, 3],
  ],
  [
    "list<boolean>",
    "true, maybe, false",
    [true, "maybe", false],
    "maybe",
    "“maybe” is not true or false.",
    "TRUE",
    [true, true, false],
  ],
])(
  "keeps an invalid %s value visible until corrected: %s",
  (type, text, expected, invalid, message, corrected, valid) => {
    const { input, chips, onChange, onBlur } = renderList(type, []);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(chips()).toEqual(expected.map(String));
    expect(screen.getByText(invalid).closest(".list-chip")!.className).toBe(
      "list-chip invalid",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(input.getAttribute("aria-describedby")).toContain(
      screen.getByRole("alert").id,
    );
    expect(input.validationMessage).toBe(message);
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(invalid));
    expect(input.value).toBe(invalid);
    fireEvent.change(input, { target: { value: corrected } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(valid);
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.validationMessage).toBe("");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("switches a boolean value on click", () => {
  const { chips, onChange } = renderList("list<boolean>", [true, false]);
  fireEvent.click(screen.getByText("true"));
  expect(onChange).toHaveBeenLastCalledWith([false, false]);
  expect(chips()).toEqual(["false", "false"]);
});

it("turns pasted lines and spreadsheet cells into values", () => {
  const { input, chips, onChange } = renderList("list<number>", [1]);
  fireEvent.paste(input, {
    clipboardData: { getData: () => "2\r\n3\t4\r\n" },
  });
  expect(onChange).toHaveBeenLastCalledWith([1, 2, 3, 4]);
  expect(chips()).toEqual(["1", "2", "3", "4"]);
  expect(input.value).toBe("");
});

it("suggests input columns and adds a chosen one at once", () => {
  const { input, chips, onChange } = renderList(
    "list<column>",
    ["id"],
    ["id", "amount", "region"],
  );
  const options = () =>
    [
      ...document.querySelectorAll(
        `#${CSS.escape(input.getAttribute("list")!)} option`,
      ),
    ].map((option) => option.getAttribute("value"));
  expect(options()).toEqual(["amount", "region"]);
  fireEvent.input(input, {
    target: { value: "region" },
    inputType: "insertReplacementText",
  });
  expect(onChange).toHaveBeenLastCalledWith(["id", "region"]);
  expect(chips()).toEqual(["id", "region"]);
  expect(input.value).toBe("");
  expect(options()).toEqual(["amount"]);
});

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
    fireEvent.change(input, { target: { value: "-2.5, 3e2" } });
    expect(onChange).toHaveBeenLastCalledWith([1, -2.5, 300]);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenLastCalledWith([1, -2.5, "abc"]);
    expect(validValue("list<number>", onChange.mock.lastCall![0])).toBe(false);
    fireEvent.blur(input);
    expect(input.validationMessage).toBe("“abc” is not a number.");
    for (const name of ["Remove 1", "Remove -2.5", "Remove abc"])
      fireEvent.click(screen.getByRole("button", { name }));
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
