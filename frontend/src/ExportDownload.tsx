import { Download } from "lucide-react";
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

/**
 * Start a download in a hidden frame kept outside React: the results Log
 * remounts this component when a run lands or the user switches tabs, and
 * removing the frame would cancel a download in progress.
 */
function startDownload(url: string, onError: (body: string) => void) {
  let frame = document.querySelector<HTMLIFrameElement>(
    "iframe.export-download-frame",
  );
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "export-download-frame";
    frame.hidden = true;
    document.body.append(frame);
  }
  const current = frame;
  // A file removed after the preflight returns JSON in this hidden frame.
  current.onload = () => {
    const body = current.contentDocument?.body.textContent;
    if (body) onError(body);
  };
  current.src = url;
}

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
            startDownload(
              apiUrl(
                withQuery(endpoint + "/download", {
                  environment,
                  run: current.run,
                }),
              ),
              (body) => {
                try {
                  download.setError(
                    JSON.parse(body).error || t("exportMissing"),
                  );
                } catch {
                  download.setError(t("exportMissing"));
                }
              },
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
            {new Date(result.started!).toLocaleString()}
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
    </section>
  );
}
