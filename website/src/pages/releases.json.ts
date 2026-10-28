import type { APIRoute } from "astro";
import { getReleases } from "../lib/releases";

export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await getReleases()), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
