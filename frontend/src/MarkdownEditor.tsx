import {
  Bold,
  Code2,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useT } from "./i18n";
import { formatMarkdown, type MarkdownFormat } from "./markdownEditing";

const formats = [
  ["heading", "markdownHeading", Heading2],
  ["bold", "markdownBold", Bold],
  ["italic", "markdownItalic", Italic],
  ["link", "markdownLink", Link],
  ["bullet", "markdownBulletList", List],
  ["numbered", "markdownNumberedList", ListOrdered],
  ["quote", "markdownQuote", Quote],
  ["code", "markdownCodeBlock", Code2],
] as const;

/** Type only the changed span, so the browser's Ctrl+Z undoes a format. */
function insertChange(input: HTMLTextAreaElement, text: string) {
  const old = input.value;
  let start = 0;
  while (start < old.length && old[start] === text[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old.at(-1 - end) === text.at(-1 - end)
  )
    end++;
  input.setSelectionRange(start, old.length - end);
  return document.execCommand(
    "insertText",
    false,
    text.slice(start, text.length - end),
  );
}

export default function MarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const editor = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    if (!selection.current || !editor.current) return;
    editor.current.focus();
    editor.current.setSelectionRange(
      selection.current.start,
      selection.current.end,
    );
    selection.current = null;
  }, [value]);
  const format = (format: MarkdownFormat) => {
    const input = editor.current;
    if (!input) return;
    const result = formatMarkdown(
      value,
      input.selectionStart,
      input.selectionEnd,
      format,
      t("markdownText"),
    );
    selection.current = result;
    input.focus();
    if (!insertChange(input, result.text)) onChange(result.text);
  };
  return (
    <div className="markdown-editor">
      <div
        className="markdown-toolbar"
        role="group"
        aria-label={t("markdownFormatting")}
      >
        {formats.map(([kind, label, Icon]) => (
          <button
            key={kind}
            type="button"
            className="icon"
            title={t(label)}
            aria-label={t(label)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(kind)}
          >
            <Icon size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
      <textarea
        ref={editor}
        aria-label={t("projectDocs")}
        className="project-documentation"
        value={value}
        placeholder={t("documentationPlaceholder")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key !== "b" && key !== "i") return;
          event.preventDefault();
          format(key === "b" ? "bold" : "italic");
        }}
      />
    </div>
  );
}
