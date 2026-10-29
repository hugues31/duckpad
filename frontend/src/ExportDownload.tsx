import { Download } from "lucide-react";
import { useRef } from "react";
import { api, apiUrl, withQuery } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

type ExportResult = {
  status:
    | "available"
    | "not_run"
    | "running"
    | "failed"
    | "stale"
    | "missing"
    | "unsupported";
  run?: string;
  started?: string;
  filename?: string;
};

const REASONS = {
  not_run: "exportNotRun",
  running: "exportRunning",
  failed: "exportFailed",
  stale: "exportStale",
  missing: "exportMissing",
  unsupported: "exportUnsupported",
} as const;

export default function ExportDownload({
  worktree,
  environment,
  node,
}: {
  worktree: string;
  environment: string;
  node: string;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const endpoint = `/worktrees/${encodeURIComponent(worktree)}/exports/${encodeURIComponent(node)}`;
  const {
    data: result,
    error: pollError,
    setData: setResult,
  } = useApiResource<ExportResult>(withQuery(endpoint, { environment }), {
    interval: 1500,
  });
  // A download failure stays until the next attempt; a polling failure until the next poll.
  const download = useAsyncAction();
  const error = download.error || pollError;

  if (result?.status === "unsupported") return null;
  return (
    <section className="export-download" aria-label={t("downloadExportedData")}>
      <button
        className="button secondary full"
        disabled={download.pending || result?.status !== "available"}
        onClick={() =>
          download.run(async () => {
            const current = await api<ExportResult>(
              withQuery(endpoint, { environment }),
            );
            setResult(current);
            if (current.status !== "available") return;
            if (current.run !== result?.run)
              throw new Error(t("exportChanged"));
            // Let the browser stream the attachment to disk, without buffering it in a Blob.
            if (frame.current)
              frame.current.src = apiUrl(
                withQuery(endpoint + "/download", {
                  environment,
                  run: current.run,
                }),
              );
          })
        }
      >
        <Download size={15} />
        {t("downloadExportedData")}
      </button>
      <p className="muted small" role="status">
        {!result ? (
          t("loading")
        ) : result.status === "available" ? (
          <>
            {result.filename}
            <br />
            {environment} · {new Date(result.started!).toLocaleString()}
            <br />
            {t("exportExecution")} {result.run}
          </>
        ) : (
          t(REASONS[result.status])
        )}
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <iframe
        ref={frame}
        hidden
        title={t("downloadExportedData")}
        onLoad={() => {
          // A file removed after the preflight returns JSON in this hidden frame.
          const body = frame.current?.contentDocument?.body.textContent;
          if (body) {
            try {
              download.setError(JSON.parse(body).error || t("exportMissing"));
            } catch {
              download.setError(t("exportMissing"));
            }
          }
        }}
      />
    </section>
  );
}
