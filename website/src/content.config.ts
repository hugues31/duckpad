import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../docs",
      pattern:
        "{QUICKSTART,EXAMPLE,WORKSPACE,AUTHORING,SQL,DATA_PREPARATION,COMPONENTS,VARIABLES,DOCUMENTATION,RESULTS,LINEAGE,TESTS,MESSAGES,ASSISTANT,GIT,JOBS,AUTOMATION,INSTALLATION,CONNECTORS,ENVIRONMENTS,SSO,OFFLINE_EXTENSIONS,OFFLINE_EXTENSIONS_ADMIN,ARCHITECTURE,VALIDATION,WEBSITE}.md",
      generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase(),
    }),
  }),
};
