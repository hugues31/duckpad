import { Download } from "lucide-react";
import { useState } from "react";
import { api, apiUrl, withQuery } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useOptionalWorktree, usePartitionQuery } from "./worktree";

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
 * Start a download in a hidden frame kept outside React: the results panel
 * remounts when another node is selected, and removing the frame would cancel
 * a download in progress.
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

/**
 * The downloadable file of an export in the selected environment and how to
 * fetch it. The results panel holds one state per node, shared by its header
 * button and the Log; `node` is null for a node that offers no download.
 */
export function useExportDownload(
  worktree: string,
  environment: string,
  node: string | null,
) {
  const t = useT();
  const partition = usePartitionQuery(node || "");
  // Idle polls are slow: a run starting or ending, or a saved edit that can make
  // the export stale, reloads the status at once.
  const opened = useOptionalWorktree();
  const refresh = `${opened?.statuses.active?.id ?? ""}:${opened?.snapshot?.revision ?? ""}`;
  const endpoint = `/worktrees/${encodeURIComponent(worktree)}/exports/${encodeURIComponent(node || "")}`;
  const {
    data: result,
    error: pollError,
    setData: setResult,
  } = useApiResource<ExportResult>(
    node ? withQuery(endpoint, { environment, ...partition }) : null,
    {
      interval: 1500,
      refresh,
      nextInterval: (value) =>
        value.status === "unsupported"
          ? false
          : value.status === "running"
            ? 1500
            : 10000,
    },
  );
  // A download failure stays until the next attempt, run or edit; a polling failure until the next poll.
  const download = useAsyncAction();
  const context = `${environment}:${refresh}`;
  const [failedIn, setFailedIn] = useState(context);
  if (failedIn !== context) {
    setFailedIn(context);
    download.setError("");
  }
  /** Start the download; `onFailure` tells a caller that shows no error itself. */
  const start = async (onFailure?: () => void) => {
    const done = await download.run(async () => {
      const current = await api<ExportResult>(
        withQuery(endpoint, { environment, ...partition }),
      );
      setResult(current);
      if (current.status !== "available") return;
      if (current.run !== result?.run) throw new Error(t("exportChanged"));
      // Let the browser stream the attachment to disk, without buffering it in a Blob.
      startDownload(
        apiUrl(
          withQuery(endpoint + "/download", {
            environment,
            ...partition,
            run: current.run,
          }),
        ),
        (body) => {
          try {
            download.setError(JSON.parse(body).error || t("exportMissing"));
          } catch {
            download.setError(t("exportMissing"));
          }
          onFailure?.();
        },
      );
    });
    if (!done) onFailure?.();
  };
  return {
    result,
    error: download.error || pollError,
    pending: download.pending,
    start,
  };
}

export type ExportDownloadState = ReturnType<typeof useExportDownload>;

/** The download in the panel header, within reach of every tab; its details are in the Log. */
export function ExportDownloadButton({
  state: { result, pending, start },
  onFailure,
}: {
  state: ExportDownloadState;
  /** Show the Log, where the failure is explained. */
  onFailure: () => void;
}) {
  const t = useT();
  if (!result || result.status === "unsupported") return null;
  return (
    <button
      className="icon"
      title={
        result.status === "available"
          ? `${t("downloadExportedData")} · ${result.filename}`
          : t(REASONS[result.status])
      }
      aria-label={t("downloadExportedData")}
      disabled={pending || result.status !== "available"}
      onClick={() => void start(onFailure)}
    >
      <Download size={15} />
    </button>
  );
}

export default function ExportDownload({
  state: { result, error, pending, start },
}: {
  state: ExportDownloadState;
}) {
  const t = useT();
  if (result?.status === "unsupported") return null;
  return (
    <section className="export-download" aria-label={t("downloadExportedData")}>
      <button
        className="button secondary full"
        disabled={pending || result?.status !== "available"}
        onClick={() => void start()}
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
