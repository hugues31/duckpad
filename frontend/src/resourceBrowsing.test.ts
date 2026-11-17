import { expect, it, vi } from "vitest";
import {
  databaseSource,
  filePatterns,
  fileSize,
  openingFolder,
  storageSource,
  type BrowserEntry,
} from "./resourceBrowsing";
import type { DatabaseObjects } from "./types";

const signal = new AbortController().signal;
const names = (entries: BrowserEntry[]) =>
  entries.map((entry) => `${entry.kind}:${entry.path.join("/")}`);

const objects: DatabaseObjects = {
  schemas: ["public", "sales"],
  tables: [
    { schema: "public", name: "customers", view: false },
    { schema: "public", name: "orders", view: false },
    { schema: "sales", name: "large_orders", view: true },
    { schema: "sales", name: "orders", view: false },
  ],
  truncated: false,
};

it("lists schemas with their table counts, then the tables of a schema", async () => {
  const source = databaseSource(objects);
  expect((await source([], "", signal)).entries).toEqual([
    { path: ["public"], kind: "schema", count: 2 },
    { path: ["sales"], kind: "schema", count: 2 },
  ]);
  expect(names((await source(["sales"], "", signal)).entries)).toEqual([
    "view:sales/large_orders",
    "table:sales/orders",
  ]);
});

it("searches the tables of every schema, the open schema first", async () => {
  const source = databaseSource(objects);
  expect(names((await source(["sales"], "ord", signal)).entries)).toEqual([
    "view:sales/large_orders",
    "table:sales/orders",
    "table:public/orders",
  ]);
  // From the root, matching schemas come before matching tables.
  expect(names((await source([], "sales", signal)).entries)).toEqual([
    "schema:sales",
    "view:sales/large_orders",
    "table:sales/orders",
  ]);
  expect(names((await source([], "public.ord", signal)).entries)).toEqual([
    "table:public/orders",
  ]);
});

it("offers a pattern for each readable format that several files share", () => {
  const file = (name: string): BrowserEntry => ({
    path: ["inbox", name],
    kind: "file",
  });
  expect(
    filePatterns(
      ["inbox"],
      [
        { path: ["inbox", "old.csv"], kind: "folder" },
        file("a.csv"),
        file("B.CSV"),
        file("c.parquet"),
        file("d.xlsx"),
        file("e.xlsx"),
      ],
    ),
  ).toEqual([{ path: ["inbox", "*.csv"], kind: "pattern", count: 2 }]);
});

it("loads a complete level once and filters it without the server", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          entries: [
            { name: "2024", kind: "folder", size: null, modified: null },
            { name: "january.csv", kind: "file", size: 10, modified: null },
            { name: "february.csv", kind: "file", size: 20, modified: null },
          ],
          truncated: false,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const source = storageSource("main", "landing zone", "dev");
  const level = await source(["inbox"], "", signal);
  expect(fetch).toHaveBeenCalledWith(
    "/api/worktrees/main/connections/landing%20zone/files?environment=dev&path=inbox",
    expect.anything(),
  );
  expect(names(level.entries)).toEqual([
    "folder:inbox/2024",
    "pattern:inbox/*.csv",
    "file:inbox/january.csv",
    "file:inbox/february.csv",
  ]);
  expect(names((await source(["inbox"], "UARY", signal)).entries)).toEqual([
    "file:inbox/january.csv",
    "file:inbox/february.csv",
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("narrows a level too large to list by the beginning of a name, on the server", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          entries: [
            { name: "orders.csv", kind: "file", size: 1, modified: null },
          ],
          truncated: !url.includes("prefix="),
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const source = storageSource("main", "lake", "prod");
  expect((await source([], "", signal)).truncated).toBe(true);
  const narrowed = source([], "ord", signal);
  await vi.advanceTimersByTimeAsync(200);
  expect((await narrowed).truncated).toBe(false);
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/worktrees/main/connections/lake/files?environment=prod&path=&prefix=ord",
    expect.anything(),
  );
  vi.useRealTimers();
});

it("opens at the folder of a plain relative path, else at the root", () => {
  expect(openingFolder("inbox/2024/orders.csv")).toEqual(["inbox", "2024"]);
  expect(openingFolder("orders.csv")).toEqual([]);
  for (const value of [
    "",
    "/srv/data/orders.csv",
    "s3://lake/raw/orders.csv",
    "inbox/{{ var.month }}/orders.csv",
    "inbox/*.csv",
  ])
    expect(openingFolder(value)).toEqual([]);
});

it("writes file sizes with at most three significant digits, in the interface language", () => {
  // Intl separates numbers and units with no-break spaces in some languages.
  const size = (bytes: number, language: string) =>
    fileSize(bytes, language).replace(/\s/g, " ");
  expect(size(0, "en")).toBe("0 bytes");
  expect(size(999, "en")).toBe("999 bytes");
  expect(size(1234, "en")).toBe("1.2 kB");
  expect(size(45_600_000, "en")).toBe("46 MB");
  expect(size(3_400_000_000, "fr")).toBe("3,4 Go");
  expect(size(4_800, "fr")).toBe("4,8 ko");
  expect(size(1, "fr")).toBe("1 octet");
  expect(size(4_800, "de")).toBe("4,8 kB");
});
