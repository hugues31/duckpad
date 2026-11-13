// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Appearance } from "./nodeAppearance";
import NodeAppearanceField from "./NodeAppearanceField";
import type { FlowNode, ParsedTemplate, Snapshot } from "./types";

afterEach(cleanup);

const NODE = { id: "paid", params: {}, position: { x: 0, y: 0 } } as FlowNode;
const revision = (name: string) => ({ revision: name }) as Snapshot;

function field(
  definition: ParsedTemplate,
  onChange: (
    appearance: Appearance,
    base: Snapshot,
  ) => Promise<Snapshot> = async () => revision("saved"),
  node = NODE,
) {
  const view = render(
    <NodeAppearanceField
      node={node}
      definition={definition}
      snapshot={revision("shown")}
      readOnly={false}
      onChange={onChange}
    />,
  );
  return {
    ...view,
    show: (next: ParsedTemplate) =>
      view.rerender(
        <NodeAppearanceField
          node={node}
          definition={next}
          snapshot={revision("shown")}
          readOnly={false}
          onChange={onChange}
        />,
      ),
  };
}

const toggle = () => screen.getByRole("button", { name: /^Icon and color/ });
const option = (name: string) => screen.getByRole("option", { name });

it("summarizes the declared icon and color, and opens the library", () => {
  field({ icon: "filter", color: "green" });
  expect(toggle().textContent).toBe("filter · green");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(option("filter").getAttribute("aria-selected")).toBe("true");
  expect(option("green").getAttribute("aria-selected")).toBe("true");
  expect(option("Default icon").getAttribute("aria-selected")).toBe("false");
  expect(
    screen.getByRole("group", { name: "Data" }).querySelectorAll("button")
      .length,
  ).toBeGreaterThan(50);
  expect(screen.getByRole("group", { name: "Miscellaneous" })).toBeTruthy();
  expect(screen.getByText(/^Saved in the node's code as @icon/)).toBeTruthy();
});

it("shows the default look of a node that declares nothing", () => {
  field({});
  expect(toggle().textContent).toBe("Default");
  fireEvent.click(toggle());
  expect(option("Default icon").getAttribute("aria-selected")).toBe("true");
  expect(option("Default color").getAttribute("aria-selected")).toBe("true");
});

it("writes each choice alone, one save after the other", async () => {
  const saves: [Appearance, string][] = [];
  const finish: ((snapshot: Snapshot) => void)[] = [];
  const view = field({ icon: "filter" }, (appearance, base) => {
    saves.push([appearance, base.revision]);
    return new Promise((resolve) => finish.push(resolve));
  });
  fireEvent.click(toggle());
  fireEvent.click(option("pivot"));
  fireEvent.click(option("orange"));
  // The choices show at once, before the code that declares them is saved.
  expect(toggle().textContent).toBe("pivot · orange");
  expect(option("pivot").getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]).toEqual([{ icon: "pivot" }, "shown"]);
  await act(async () => finish[0](revision("first")));
  // The second choice starts from the revision the first one made.
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(saves[1]).toEqual([{ color: "orange" }, "first"]);
  await act(async () => finish[1](revision("second")));
  view.show({ icon: "pivot", color: "orange" });
  expect(toggle().textContent).toBe("pivot · orange");
  // Other code arrives, as after an undo: it says what the node declares.
  view.show({ icon: "filter" });
  expect(toggle().textContent).toBe("filter");
});

it("returns to the default icon and color", async () => {
  const onChange = vi.fn(async () => revision("saved"));
  field({ icon: "filter", color: "green" }, onChange);
  fireEvent.click(toggle());
  fireEvent.click(option("Default icon"));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      { icon: undefined },
      expect.anything(),
    ),
  );
  fireEvent.click(option("Default color"));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      { color: undefined },
      expect.anything(),
    ),
  );
  expect(toggle().textContent).toBe("Default");
});

it("shows what the code declares again when a save fails", async () => {
  field({ icon: "filter" }, async () => {
    throw new Error("Concurrent edits conflict.");
  });
  fireEvent.click(toggle());
  fireEvent.click(option("pivot"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Concurrent edits conflict.",
  );
  expect(toggle().textContent).toBe("filter");
});

it("searches icons by name and by other words", () => {
  field({});
  fireEvent.click(toggle());
  const search = screen.getByRole("searchbox", { name: "Search icons…" });
  fireEvent.change(search, { target: { value: "disk" } });
  expect(
    screen
      .getAllByRole("option")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual([
    "Default color",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "gray",
    "hard-drive",
  ]);
  fireEvent.change(search, { target: { value: "zzz" } });
  expect(screen.getByRole("status").textContent).toBe(
    "No icon matches this search.",
  );
});

it("gives each list one Tab stop, which the arrow keys move", () => {
  field({ icon: "filter", color: "green" });
  fireEvent.click(toggle());
  const stops = () =>
    screen
      .getAllByRole("option")
      .filter((item) => item.tabIndex === 0)
      .map((item) => item.getAttribute("aria-label"));
  expect(stops()).toEqual(["green", "filter"]);
  act(() => option("green").focus());
  fireEvent.keyDown(option("green"), { key: "ArrowRight" });
  expect(document.activeElement).toBe(option("teal"));
  expect(stops()).toEqual(["teal", "filter"]);
  fireEvent.keyDown(option("teal"), { key: "Home" });
  expect(document.activeElement).toBe(option("Default color"));
  // Leaving the list gives the stop back to the chosen color.
  act(() => option("filter").focus());
  expect(stops()).toEqual(["green", "filter"]);
  // A search that hides the chosen icon lets its first match take the key.
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "join" },
  });
  expect(stops()).toEqual(["green", "join"]);
});

it("says when the code declares a name Duckpad cannot show, and leaves it there", async () => {
  const onChange = vi.fn(async () => revision("saved"));
  field({ icon: "$&", color: "green" }, onChange);
  expect(toggle().textContent).toBe("green");
  expect(
    screen.getByText(
      "The code declares an unknown icon, $&: the default one is shown.",
    ),
  ).toBeTruthy();
  // Choosing a color says nothing of the icon, which the code keeps.
  fireEvent.click(toggle());
  fireEvent.click(option("red"));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      { color: "red" },
      expect.anything(),
    ),
  );
});

it("warns that a linked node styles its shared template", () => {
  field({}, undefined, { ...NODE, template: "paid_orders" });
  fireEvent.click(toggle());
  expect(screen.getByText(/^Saved in the shared template's code/)).toBeTruthy();
});
