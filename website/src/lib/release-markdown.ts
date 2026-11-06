import {
  createMarkdownProcessor,
  rehypeHeadingIds,
} from "@astrojs/markdown-remark";
import rehypeSanitize from "rehype-sanitize";
import type { Root, RootContent } from "hast";
import type { Release } from "./releases.ts";

export async function renderReleaseNotes(release: Release, prefix: string) {
  const renderer = await createMarkdownProcessor({
    syntaxHighlight: false,
    remarkRehype: { allowDangerousHtml: false },
    rehypePlugins: [
      rehypeSanitize,
      rehypeHeadingIds,
      () => (tree: Root) => {
        function visit(node: Root | RootContent) {
          if (node.type === "element") {
            if (/^h[1-6]$/.test(node.tagName)) {
              node.tagName = `h${Math.max(3, Number(node.tagName[1]))}`;
            }
            const properties = node.properties;
            if (typeof properties.id === "string")
              properties.id = `${prefix}-${properties.id}`;
            if (
              typeof properties.href === "string" &&
              properties.href.startsWith("#")
            ) {
              properties.href = `#${prefix}-${properties.href.slice(1)}`;
            }
            for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
              if (Array.isArray(properties[key]))
                properties[key] = properties[key].map(
                  (id) => `${prefix}-${id}`,
                );
            }
          }
          if ("children" in node) node.children.forEach(visit);
        }
        visit(tree);
      },
    ],
  });
  const lines = release.body.split("\n");
  if ([`# ${release.name}`, `## ${release.name}`].includes(lines[0]))
    lines.shift();
  return (await renderer.render(lines.join("\n"))).code;
}
