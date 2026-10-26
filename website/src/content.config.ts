import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../docs",
      pattern:
        "{QUICKSTART,EXAMPLE,INSTALLATION,AUTHORING,LINEAGE,GIT,CONNECTORS,ARCHITECTURE,VALIDATION,EXECUTION_SERVICE,WEBSITE}.md",
      generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase(),
    }),
  }),
};
