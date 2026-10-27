export const sections = [
  {
    label: "Start here",
    pages: [
      {
        slug: "quickstart",
        title: "Quickstart",
        description: "From a fresh install to your first explained result.",
      },
      {
        slug: "example",
        title: "The Northstar tour",
        description:
          "Explore a complete pipeline with CSV, Parquet and reusable components.",
      },
      {
        slug: "installation",
        title: "Installation & accounts",
        description: "Set up an instance, invite your team and manage access.",
      },
      {
        slug: "sso",
        title: "Single sign-on",
        description: "Connect your identity provider with OpenID Connect.",
      },
    ],
  },
  {
    label: "Work with data",
    pages: [
      {
        slug: "authoring",
        title: "Pipelines & components",
        description:
          "Compose transformations with typed parameters and reusable SQL.",
      },
      {
        slug: "lineage",
        title: "Explain a value",
        description:
          "Trace result cells to their source, with explicit coverage limits.",
      },
      {
        slug: "git",
        title: "Version control",
        description:
          "Branch, compare, review merges and synchronize your project.",
      },
      {
        slug: "connectors",
        title: "Connections",
        description:
          "Configure local files, S3 and Oracle for each environment.",
      },
    ],
  },
  {
    label: "Under the hood",
    pages: [
      {
        slug: "architecture",
        title: "Architecture",
        description:
          "How execution, isolation, persistence and lineage fit together.",
      },
      {
        slug: "persistence",
        title: "Settings persistence",
        description:
          "Where settings live and how existing data can evolve across upgrades.",
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
