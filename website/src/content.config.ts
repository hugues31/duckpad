import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../docs",
      pattern:
        "{QUICKSTART,EXAMPLE,INSTALLATION,SSO,AUTHORING,LINEAGE,GIT,CONNECTORS,ARCHITECTURE,PERSISTENCE,VALIDATION,WEBSITE}.md",
      generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase(),
    }),
  }),
};
