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
