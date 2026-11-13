import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appearanceSuggestions } from "./appearanceSuggestions";
import {
  closestAppearance,
  colorClass,
  colorValue,
  appearanceOf,
  NODE_COLORS,
  nodeColor,
  nodeIconKind,
} from "./nodeAppearance";
import { findNodeIcons, NODE_ICONS, nodeIcon } from "./nodeIcons";

describe("the icon library", () => {
  it("holds about a hundred icons with unique names, in two groups", () => {
    const names = NODE_ICONS.map((choice) => choice.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(100);
    expect(names.length).toBeLessThanOrEqual(120);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    for (const group of ["data", "misc"])
      expect(
        NODE_ICONS.filter((choice) => choice.group === group).length,
      ).toBeGreaterThan(30);
  });

  it("names the icons the built-in nodes use by default", () => {
    for (const name of [
      "sql",
      "python",
      "filter",
      "join",
      "aggregate",
      "import",
      "export",
    ])
      expect(nodeIcon(name)?.name).toBe(name);
  });

  it("is listed in the guide, each icon with its name and its other words", () => {
    const guide = readFileSync(
      new URL("../../docs/ICONS.md", import.meta.url),
      "utf8",
    );
    const listed = [...guide.matchAll(/^\| `([a-z0-9-]+)` \| (.*) \|$/gm)].map(
      ([, name, words]) => [name, words.replaceAll(", ", " ")],
    );
    expect(listed).toEqual(
      NODE_ICONS.map(({ name, keywords }) => [name, keywords]),
    );
    const colors = /^## Colors\n\n([^.]+)\./m.exec(guide)![1];
    expect(colors.match(/`[a-z]+`/g)).toEqual(
      NODE_COLORS.map((color) => "`" + color + "`"),
    );
  });

  it("reads names as the server keeps them, whatever their case", () => {
    expect(nodeIcon(" Left-Join ")?.name).toBe("left-join");
    expect(nodeIcon("fitler")).toBeUndefined();
    expect(nodeIcon(undefined)).toBeUndefined();
    // Not a name, although every object has it.
    expect(nodeIcon("constructor")).toBeUndefined();
  });

  it("finds icons by name or by another word for them", () => {
    const found = (search: string) =>
      findNodeIcons(search).map((choice) => choice.name);
    expect(found("join")).toEqual([
      "join",
      "inner-join",
      "left-join",
      "right-join",
      "full-join",
      "anti-join",
    ]);
    expect(found("home")).toEqual(["house"]);
    expect(found("DISK")).toEqual(["hard-drive"]);
    expect(found("money price")).toEqual(["euro", "dollar"]);
    expect(found("")).toHaveLength(NODE_ICONS.length);
    expect(found("zzz")).toEqual([]);
  });
});

describe("the names the editor suggests", () => {
  const names = (key: "icon" | "color", typed: string) =>
    appearanceSuggestions(key, typed).map((suggestion) => suggestion.name);

  it("start with the typed text, contain it, or have a word that starts with it", () => {
    expect(names("icon", "jo")).toEqual([
      "join",
      "inner-join",
      "left-join",
      "right-join",
      "full-join",
      "anti-join",
      "schedule",
      "briefcase",
    ]);
    expect(names("icon", "Hom")).toEqual(["house"]);
    // Not the letters of the text spread over several words, as in "leaf".
    expect(names("icon", "left")).toEqual(["left-join"]);
    expect(names("color", "p")).toEqual(["purple", "pink"]);
    expect(names("color", "magenta")).toEqual([]);
  });

  it("are all the names, in the order of the picker, before anything is typed", () => {
    expect(names("icon", "")).toEqual(NODE_ICONS.map((choice) => choice.name));
    expect(names("color", " ")).toEqual([...NODE_COLORS]);
  });
});

describe("node colors", () => {
  it("knows its names only", () => {
    expect(nodeColor("Green")).toBe("green");
    expect(nodeColor("#00ff00")).toBeUndefined();
    expect(nodeColor("")).toBeUndefined();
  });

  it("gives a declared color its classes and its tone, and nothing to an unknown one", () => {
    expect(colorClass("teal")).toBe("node-colored node-color-teal");
    expect(colorClass("turquoise")).toBe("");
    expect(colorValue("teal")).toBe("var(--node-teal)");
    // A name is never written into a style unless it is a known color.
    expect(colorValue("red);background:url(x")).toBeUndefined();
  });

  it("keeps only what Duckpad can show of a definition", () => {
    expect(appearanceOf({ icon: "pivot", color: "pink" })).toEqual({
      icon: "pivot",
      color: "pink",
    });
    expect(appearanceOf({ icon: "pivo", color: "rose" })).toEqual({
      icon: undefined,
      color: undefined,
    });
    expect(appearanceOf(undefined)).toEqual({});
  });

  it("suggests the name a misspelled one most likely means", () => {
    expect(closestAppearance("icon", "fitler")).toBe("filter");
    expect(closestAppearance("icon", "left")).toBe("left-join");
    expect(closestAppearance("icon", "drive")).toBe("hard-drive");
    expect(closestAppearance("color", "grey")).toBe("gray");
    expect(closestAppearance("color", "Purpel")).toBe("purple");
    expect(closestAppearance("color", "#123456")).toBeUndefined();
    expect(closestAppearance("icon", "")).toBeUndefined();
  });

  it("defines a tone for each color in the stylesheet", () => {
    const tokens = readFileSync(
      new URL("./styles/tokens.css", import.meta.url),
      "utf8",
    );
    for (const color of NODE_COLORS) {
      expect(tokens).toContain(`--node-${color}:`);
      expect(tokens).toContain(
        `.node-color-${color} {\n  --node-color: var(--node-${color});`,
      );
    }
  });
});

describe("the default icon of a node", () => {
  it("follows its language, else the template it came from", () => {
    expect(nodeIconKind({ component: "report" })).toBe("component");
    expect(nodeIconKind({ language: "python", template: "score.py" })).toBe(
      "python",
    );
    expect(nodeIconKind({ preset: "filter", origin: "sql" })).toBe("filter");
    expect(nodeIconKind({ template: "load_csv" })).toBe("load_csv");
    expect(nodeIconKind({})).toBe("");
  });
});
