import { expect, it } from "vitest";
import { formatMarkdown } from "./markdownEditing";

it("wraps selected text without replacing the rest of the document", () => {
  expect(formatMarkdown("A clear guide", 2, 7, "bold", "Text")).toEqual({
    text: "A **clear** guide",
    start: 4,
    end: 9,
  });
});

it("inserts a selected placeholder at the cursor", () => {
  expect(formatMarkdown("", 0, 0, "italic", "Text")).toEqual({
    text: "*Text*",
    start: 1,
    end: 5,
  });
});

it("formats whole selected lines without consuming the next line", () => {
  const result = formatMarkdown(
    "Before\nOne\nTwo\nAfter",
    9,
    15,
    "numbered",
    "Text",
  );
  expect(result.text).toBe("Before\n1. One\n2. Two\nAfter");
  expect(result.text.slice(result.start, result.end)).toBe("1. One\n2. Two");
  expect(formatMarkdown("\nAfter", 0, 0, "heading", "Text").text).toBe(
    "## Text\nAfter",
  );
});

it("separates fenced code from surrounding prose", () => {
  expect(formatMarkdown("Before SQL after", 7, 10, "code", "Text").text).toBe(
    "Before \n```\nSQL\n```\n after",
  );
});
