import {
  createMarkdownProcessor,
  rehypeHeadingIds,
} from "@astrojs/markdown-remark";
import rehypeSanitize from "rehype-sanitize";
import type { Element, ElementContent, Root, RootContent } from "hast";
import { repositoryURL, type Release } from "./releases.ts";

export interface ReleaseGroup {
  /** Lowercase group title, such as `features` or `breaking-changes`. */
  kind: string;
  title: string;
  count: number;
}

export interface ReleaseNotes {
  html: string;
  groups: ReleaseGroup[];
  /** The `pip install` command the notes start with. */
  install?: string;
  /** The "Full changelog" comparison link. */
  compare?: { href: string; label: string };
}

// Changes that matter less to readers stay folded under their heading.
const minorGroups = new Set(["documentation", "maintenance", "reverts"]);

const textOf = (node: Root | RootContent): string =>
  node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(textOf).join("")
      : "";

const element = (
  tagName: string,
  className: string,
  children: ElementContent[],
  properties: Element["properties"] = {},
): Element => ({
  type: "element",
  tagName,
  properties: { className: [className], ...properties },
  children,
});

const isElement = (node: RootContent | ElementContent, tag?: string) =>
  node.type === "element" && (!tag || node.tagName === tag);

// Turn "**scope:** Text (#12) ([abc1234](…/commit/…))" into a scope chip, the
// text, a pull request link and a discreet commit link.
function decorateItem(item: Element) {
  item.properties.className = ["release-item"];
  const content =
    (item.children.find((child) => isElement(child, "p")) as Element) ?? item;
  for (const child of item.children)
    if (isElement(child, "blockquote"))
      (child as Element).properties.className = ["release-note"];

  const nodes = content.children;
  const first = nodes.findIndex(
    (node) => node.type !== "text" || node.value.trim(),
  );
  const scope = nodes[first];
  if (scope && isElement(scope, "strong") && /:\s*$/.test(textOf(scope))) {
    nodes[first] = element("span", "release-scope", [
      { type: "text", value: textOf(scope).replace(/:\s*$/, "") },
    ]);
    const next = nodes[first + 1];
    if (next?.type === "text") next.value = next.value.replace(/^\s+/, " ");
  }

  const commit = nodes.findIndex(
    (node) =>
      isElement(node, "a") &&
      /\/commit\/[0-9a-f]+$/.test(String((node as Element).properties.href)),
  );
  if (commit > 0) {
    const before = nodes[commit - 1];
    const after = nodes[commit + 1];
    if (
      before.type === "text" &&
      after?.type === "text" &&
      /\(\s*$/.test(before.value) &&
      /^\s*\)/.test(after.value)
    ) {
      before.value = before.value.replace(/\s*\(\s*$/, " ");
      after.value = after.value.replace(/^\s*\)/, "");
    }
    const link = nodes[commit] as Element;
    link.properties.className = ["release-commit"];
    link.properties.ariaLabel = `Commit ${textOf(link)}`;
  }

  content.children = nodes.flatMap((node) => {
    if (node.type !== "text") return [node];
    const parts: ElementContent[] = [];
    let last = 0;
    for (const match of node.value.matchAll(/\s*\(#(\d+)\)/g)) {
      parts.push({ type: "text", value: node.value.slice(last, match.index) });
      parts.push({ type: "text", value: " " });
      parts.push(
        element("a", "release-pr", [{ type: "text", value: `#${match[1]}` }], {
          href: `${repositoryURL}/pull/${match[1]}`,
          ariaLabel: `Pull request #${match[1]}`,
        }),
      );
      last = match.index + match[0].length;
    }
    if (!parts.length) return [node];
    parts.push({ type: "text", value: node.value.slice(last) });
    return parts.filter((part) => part.type !== "text" || part.value);
  });
}

function structure(notes: ReleaseNotes) {
  return () => (tree: Root) => {
    const children: RootContent[] = [];
    let group: { container: Element; summary: ReleaseGroup } | undefined;
    for (const node of tree.children) {
      if (node.type === "text" && !node.value.trim()) {
        if (!group) children.push(node);
        continue;
      }
      const text = textOf(node).trim();
      if (isElement(node, "pre") && /^pip install \S+$/.test(text)) {
        notes.install = text;
        continue;
      }
      if (isElement(node, "p") && text.startsWith("Full changelog:")) {
        const link = (node as Element).children.find((child) =>
          isElement(child, "a"),
        ) as Element | undefined;
        if (link)
          notes.compare = {
            href: String(link.properties.href),
            label: textOf(link),
          };
        continue;
      }
      // Every release repeats this sentence; the page links to the downloads.
      if (
        isElement(node, "p") &&
        text.startsWith("The wheel includes the web interface")
      )
        continue;
      if (isElement(node, "h3")) {
        const heading = node as Element;
        const summary = {
          kind: text.toLowerCase().replace(/\W+/g, "-"),
          title: text,
          count: 0,
        };
        notes.groups.push(summary);
        heading.children.push(
          { type: "text", value: " " },
          element("span", "release-count", [{ type: "text", value: "0" }]),
        );
        const minor = minorGroups.has(summary.kind);
        const container = minor
          ? element("details", "release-group", [
              element("summary", "release-group-summary", [heading]),
            ])
          : element("section", "release-group", [heading]);
        container.properties.dataKind = summary.kind;
        group = { container, summary };
        children.push(container);
        continue;
      }
      if (group && isElement(node, "ul")) {
        const list = node as Element;
        const items = list.children.filter((child) =>
          isElement(child, "li"),
        ) as Element[];
        items.forEach(decorateItem);
        group.summary.count += items.length;
        const heading = (
          group.container.tagName === "details"
            ? (group.container.children[0] as Element).children[0]
            : group.container.children[0]
        ) as Element;
        (heading.children.at(-1) as Element).children = [
          { type: "text", value: String(group.summary.count) },
        ];
        group.container.children.push(list);
        continue;
      }
      // git-cliff writes a breaking change's migration note after its item.
      const item = group?.container.children
        .filter((child) => isElement(child, "ul"))
        .at(-1) as Element | undefined;
      const last = item?.children.findLast((child) => isElement(child, "li"));
      if (isElement(node, "blockquote") && last) {
        (node as Element).properties.className = ["release-note"];
        (last as Element).children.push(node as Element);
        continue;
      }
      group = undefined;
      children.push(node);
    }
    tree.children = children;
  };
}

export async function renderReleaseNotes(
  release: Release,
  prefix: string,
): Promise<ReleaseNotes> {
  const notes: ReleaseNotes = { html: "", groups: [] };
  const renderer = await createMarkdownProcessor({
    syntaxHighlight: false,
    // Keep command-line options such as --home as GitHub shows them.
    smartypants: false,
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
      structure(notes),
    ],
  });
  const lines = release.body.split("\n");
  if ([`# ${release.name}`, `## ${release.name}`].includes(lines[0]))
    lines.shift();
  notes.html = (await renderer.render(lines.join("\n"))).code;
  return notes;
}
