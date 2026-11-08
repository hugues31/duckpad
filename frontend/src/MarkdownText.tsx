import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Authored or generated Markdown: no raw HTML or images, and links open in a
 * new tab so unsaved drafts on the page are never lost. */
export default function MarkdownText({ children }: { children: string }) {
  if (!children) return null;
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => (/^(https?:\/\/|#)/i.test(url) ? url : "")}
      components={{
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
