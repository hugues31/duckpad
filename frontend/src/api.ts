/** Errors returned by the Duckpad API, or by a proxy in front of it. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/** Build an API path with encoded query parameters; undefined values are omitted. */
export function withQuery(path: string, query: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return `${path}?${params}`;
}

async function readError(response: Response) {
  const json = response.headers
    .get("content-type")
    ?.includes("application/json");
  const body = json ? await response.json().catch(() => null) : null;
  return new ApiError(
    body?.error || response.statusText || "Request failed",
    response.status,
    body?.detail,
  );
}

export async function api<T = any>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) throw await readError(response);
  return response.json();
}

export const send = (data: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(data),
});

/** Store a local file on the server and return its server-side path. */
export async function uploadFile(
  file: File,
  worktree: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    `/api/worktrees/${encodeURIComponent(worktree)}/uploads`,
    {
      method: "POST",
      body: form,
      credentials: "same-origin",
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()).path;
}
