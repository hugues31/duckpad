export const sections = [
  {
    label: "Start here",
    pages: [
      {
        slug: "quickstart",
        title: "Duckpad in 15 minutes",
        description:
          "Build two SQL nodes from scratch, check their data and explain a result.",
      },
      {
        slug: "example",
        title: "The Northstar tour",
        description:
          "Explore a complete pipeline with CSV, Parquet and reusable components.",
      },
      {
        slug: "workspace",
        title: "Find your way around",
        description:
          "Navigate the canvas, search projects and choose your preferences.",
      },
    ],
  },
  {
    label: "Build a pipeline",
    pages: [
      {
        slug: "authoring",
        title: "Projects & node code",
        description:
          "Manage project files, imports and the code each node owns or shares.",
      },
      {
        slug: "sql",
        title: "SQL syntax",
        description:
          "Declare inputs, outputs and typed parameters; write sources and exports.",
      },
      {
        slug: "data_preparation",
        title: "Prepare columns & values",
        description: "Select, rename, cast and clean data with guided forms.",
      },
      {
        slug: "components",
        title: "Reusable components",
        description:
          "Group nodes, expose parameters and import reusable flows.",
      },
      {
        slug: "variables",
        title: "Project variables",
        description:
          "Bind shared values and SQL expressions, with overrides per environment.",
      },
      {
        slug: "documentation",
        title: "Document a project",
        description: "Explain a project, its nodes, output tables and columns.",
      },
    ],
  },
  {
    label: "Inspect and check",
    pages: [
      {
        slug: "results",
        title: "Results, samples & logs",
        description:
          "Explore data, save views, compute statistics and inspect the executed SQL.",
      },
      {
        slug: "lineage",
        title: "Explain a value",
        description:
          "Trace result cells to their source, with explicit coverage limits.",
      },
      {
        slug: "tests",
        title: "Data tests",
        description:
          "Return failing rows and check data before publication or export.",
      },
      {
        slug: "messages",
        title: "Execution messages",
        description:
          "Report information, warnings and blocking errors from SQL.",
      },
      {
        slug: "assistant",
        title: "AI assistant",
        description:
          "Ask in context, inspect edits with Undo and confirm runs.",
      },
    ],
  },
  {
    label: "Version and automate",
    pages: [
      {
        slug: "git",
        title: "Version control",
        description:
          "Branch, tag, compare, review merges and synchronize your project.",
      },
      {
        slug: "jobs",
        title: "Jobs",
        description:
          "Run reviewed versions and inspect their results and version history.",
      },
      {
        slug: "automation",
        title: "CLI & automation",
        description:
          "Launch Jobs from schedulers with duckpad run or the HTTP API.",
      },
    ],
  },
  {
    label: "Configure an instance",
    pages: [
      {
        slug: "installation",
        title: "Installation & accounts",
        description: "Set up an instance, invite your team and manage access.",
      },
      {
        slug: "connectors",
        title: "Connections",
        description:
          "Read and export project files, server folders, S3 and Oracle data.",
      },
      {
        slug: "environments",
        title: "Environments",
        description:
          "Configure connection values, labels and run confirmations.",
      },
      {
        slug: "sso",
        title: "Single sign-on",
        description: "Connect your identity provider with OpenID Connect.",
      },
      {
        slug: "offline_extensions",
        title: "Offline extensions",
        description:
          "Activate project capabilities and import binaries for offline use.",
      },
    ],
  },
  {
    label: "Under the hood",
    pages: [
      {
        slug: "offline_extensions_admin",
        title: "Extension import details",
        description:
          "Download server binaries, verify imports and troubleshoot loading.",
      },
      {
        slug: "architecture",
        title: "Architecture",
        description:
          "How execution, isolation, persistence and lineage fit together.",
      },
      {
        slug: "validation",
        title: "Validation & performance",
        description: "Measured results, reproducible checks and their scope.",
      },
      {
        slug: "website",
        title: "Contribute to the docs",
        description:
          "Edit the website and regenerate its product demonstrations.",
      },
    ],
  },
];
export const pages = sections.flatMap((section) => section.pages);
export const base = import.meta.env.BASE_URL.replace(/\/$/, "");
export const url = (path = "") => `${base}/${path.replace(/^\//, "")}`;
