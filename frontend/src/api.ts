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

/** The fields of an API error's detail, or none when it has no detail object. */
export function errorDetail(error: unknown): Record<string, unknown> {
  const detail = error instanceof ApiError ? error.detail : undefined;
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
}

type Query = Record<string, string | number | boolean | undefined>;

/** Build an API path with encoded query parameters; undefined values are omitted. */
export function withQuery(path: string, query: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return `${path}?${params}`;
}

/** Absolute URL of an API path, for links and frames the browser loads itself. */
export const apiUrl = (path: string) => "/api" + path;

const expiryListeners = new Set<() => void>();

/** Call `listener` whenever the API rejects the session; returns an unsubscribe function. */
export function onSessionExpired(listener: () => void) {
  expiryListeners.add(listener);
  return () => {
    expiryListeners.delete(listener);
  };
}

async function readError(response: Response) {
  // Every request reports an expired session here, so callers never check for 401 themselves.
  if (response.status === 401)
    for (const listener of expiryListeners) listener();
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

/** Call the API; `T` describes the JSON response, which is not checked. */
export async function api<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(apiUrl(path), {
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

/** Download the saved declarative files of the current working branch. */
export async function downloadProject(worktree: string) {
  const response = await fetch(
    apiUrl(`/worktrees/${encodeURIComponent(worktree)}/archive.zip`),
    { credentials: "same-origin" },
  );
  if (!response.ok) throw await readError(response);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "duckpad-project.zip";
  document.body.append(link);
  link.click();
  link.remove();
  // Leave the object URL alive long enough for the browser to start reading it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What a project archive cannot carry, reported after an import. */
export interface ImportWarnings {
  connections: string[];
  files: string[];
}

/** Recreate a project from a downloaded ZIP; an empty name keeps the archive's. */
export async function importProjectArchive(
  file: File,
  name: string,
): Promise<{ id: string; project: string; warnings: ImportWarnings }> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", name);
  const response = await fetch(apiUrl("/projects/import"), {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!response.ok) throw await readError(response);
  return response.json();
}

/** Store a local file on the server and return its server-side path. */
export async function uploadFile(
  file: File,
  worktree: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    apiUrl(`/worktrees/${encodeURIComponent(worktree)}/uploads`),
    {
      method: "POST",
      body: form,
      credentials: "same-origin",
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()).path;
}

/** Import a server-platform extension without the backend downloading anything. */
export async function importExtension(file: File, source: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("source", source);
  const response = await fetch(apiUrl("/extensions/import"), {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!response.ok) throw await readError(response);
  return response.json();
}
