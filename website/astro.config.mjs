import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { cpSync, mkdirSync } from "node:fs";

const base = process.env.WEBSITE_BASE_PATH || "/";
const prefix = base.replace(/\/$/, "");

// Keep repository Markdown readable on GitHub and resolve its links on the site.
function repositoryLinks() {
  return (tree) => {
    function visit(node) {
      if (node.type === "link" && /^[A-Z_]+\.md(?:#.*)?$/.test(node.url)) {
        const [file, hash] = node.url.split("#");
        node.url = `${prefix}/docs/${file.replace(/\.md$/, "").toLowerCase()}/${hash ? `#${hash}` : ""}`;
      } else if (node.type === "image" && node.url.startsWith("images/")) {
        node.url = `${prefix}/demos/${node.url.slice(7)}`;
      } else if (node.type === "link" && node.url.startsWith("../")) {
        node.url = `https://github.com/hugues31/duckpad/blob/main/${node.url.slice(3)}`;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

export default defineConfig({
  site: process.env.SITE_ORIGIN || undefined,
  base,
  trailingSlash: "always",
  output: "static",
  markdown: {
    // SQL directives are comments: keep them readable at body-text contrast.
    shikiConfig: { theme: "github-dark-high-contrast" },
    processor: unified({
      remarkPlugins: [repositoryLinks],
    }),
  },
  integrations: [
    {
      name: "duckpad-documentation-images",
      hooks: {
        "astro:config:setup": () => {
          mkdirSync(new URL("./public/demos/", import.meta.url), {
            recursive: true,
          });
          cpSync(
            new URL("../docs/images/", import.meta.url),
            new URL("./public/demos/", import.meta.url),
            { recursive: true },
          );
        },
      },
    },
  ],
});
