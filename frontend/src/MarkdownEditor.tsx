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

export default function MarkdownEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
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
    if (!input || disabled) return;
    const result = formatMarkdown(
      value,
      input.selectionStart,
      input.selectionEnd,
      format,
      t("markdownText"),
    );
    selection.current = result;
    onChange(result.text);
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
            disabled={disabled}
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
        disabled={disabled}
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
