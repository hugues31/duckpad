export type MarkdownFormat =
  | "heading"
  | "bold"
  | "italic"
  | "link"
  | "bullet"
  | "numbered"
  | "quote"
  | "code";

/** Format the selection, keeping surrounding text and returning the next selection. */
export function formatMarkdown(
  text: string,
  start: number,
  end: number,
  format: MarkdownFormat,
  placeholder: string,
) {
  let selection = text.slice(start, end);
  if (["heading", "bullet", "numbered", "quote"].includes(format)) {
    start = text.slice(0, start).lastIndexOf("\n") + 1;
    // A selection ending at the next line's start must not format that line.
    const lineEnd = text.indexOf(
      "\n",
      end > start && text[end - 1] === "\n" ? end - 1 : end,
    );
    end = lineEnd < 0 ? text.length : lineEnd;
    selection = text.slice(start, end) || placeholder;
    const lines = selection
      .split("\n")
      .map((line, index) => {
        const prefix =
          format === "heading"
            ? "## "
            : format === "bullet"
              ? "- "
              : format === "quote"
                ? "> "
                : `${index + 1}. `;
        return prefix + line;
      })
      .join("\n");
    return {
      text: text.slice(0, start) + lines + text.slice(end),
      start,
      end: start + lines.length,
    };
  }
  selection ||= placeholder;
  const [before, after] =
    format === "bold"
      ? ["**", "**"]
      : format === "italic"
        ? ["*", "*"]
        : format === "link"
          ? ["[", "](https://)"]
          : [
              `${start && text[start - 1] !== "\n" ? "\n" : ""}\`\`\`\n`,
              `\n\`\`\`${end < text.length && text[end] !== "\n" ? "\n" : ""}`,
            ];
  return {
    text: text.slice(0, start) + before + selection + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + selection.length,
  };
}
