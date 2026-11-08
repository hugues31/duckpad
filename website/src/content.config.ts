import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../docs",
      pattern:
        "{QUICKSTART,YOUR_DATA,TROUBLESHOOTING,EXAMPLE,WORKSPACE,COMPARISON,AUTHORING,SQL,DATA_PREPARATION,COMPONENTS,VARIABLES,PARTITIONS,PYTHON,DOCUMENTATION,RESULTS,LINEAGE,TESTS,MESSAGES,ASSISTANT,GIT,JOBS,AUTOMATION,INSTALLATION,CONNECTORS,ENVIRONMENTS,SSO,OFFLINE_EXTENSIONS,OFFLINE_EXTENSIONS_ADMIN,ARCHITECTURE,VALIDATION,BENCHMARKS,WEBSITE}.md",
      generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase(),
    }),
  }),
};
