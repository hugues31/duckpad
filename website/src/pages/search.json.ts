import { getCollection } from "astro:content";
import { pages, url } from "../lib/docs";

export async function GET() {
  const entries = await getCollection("docs");
  return Response.json(
    entries.map((entry) => {
      const meta = pages.find((page) => page.slug === entry.id)!;
      return { ...meta, url: url(`docs/${entry.id}/`), body: entry.body };
    }),
  );
}
