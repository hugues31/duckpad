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
      {
        slug: "offline_extensions",
        title: "Offline extensions",
        description:
          "Download on any computer and import binaries for your offline server.",
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
        slug: "assistant",
        title: "AI assistant",
        description:
          "Configure a provider and explore your project with private conversations.",
      },
      {
        slug: "git",
        title: "Version control",
        description:
          "Branch, compare, review merges and synchronize your project.",
      },
      {
        slug: "automation",
        title: "Automate Jobs",
        description:
          "Launch approved Jobs, wait for results and collect logs through the API.",
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
