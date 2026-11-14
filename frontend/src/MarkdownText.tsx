import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** Headings moved down by `offset` levels, so authored text nests under the page's own. */
const demoted = (offset: number): Components =>
  Object.fromEntries(
    LEVELS.map((level) => {
      const Heading = `h${Math.min(level + offset, 6)}` as "h1";
      return [
        `h${level}`,
        ({ children }: { children?: ReactNode }) => (
          <Heading>{children}</Heading>
        ),
      ];
    }),
  );
const HEADINGS = LEVELS.map((level) => demoted(level));

/** Authored or generated Markdown: no raw HTML or images, and links open in a
 * new tab so unsaved drafts on the page are never lost. */
export default function MarkdownText({
  children,
  headingOffset = 0,
}: {
  children: string;
  /** How many levels the text's headings sit under the page's own headings. */
  headingOffset?: 0 | 1 | 2 | 3 | 4 | 5;
}) {
  if (!children) return null;
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => (/^(https?:\/\/|#)/i.test(url) ? url : "")}
      components={{
        ...(headingOffset ? HEADINGS[headingOffset - 1] : {}),
        img: () => null,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}
