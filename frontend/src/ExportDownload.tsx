import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, withQuery } from "./api";
import { useT } from "./i18n";

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
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const endpoint = `/worktrees/${encodeURIComponent(worktree)}/exports/${encodeURIComponent(node)}`;
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const value = await api<ExportResult>(
          withQuery(endpoint, { environment }),
        );
        if (live) setResult(value);
      } catch (e) {
        if (live) {
          setResult(null);
          setError((e as Error).message);
        }
      }
      if (live) timer = window.setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [endpoint, environment]);

  if (result?.status === "unsupported") return null;
  return (
    <section className="export-download" aria-label={t("downloadExportedData")}>
      <button
        className="button secondary full"
        disabled={checking || result?.status !== "available"}
        onClick={async () => {
          setError("");
          setChecking(true);
          try {
            const current = await api<ExportResult>(
              withQuery(endpoint, { environment }),
            );
            setResult(current);
            if (
              current.status === "available" &&
              current.run === result?.run &&
              frame.current
            ) {
              // Let the browser stream the attachment to disk, without buffering it in a Blob.
              frame.current.src =
                "/api" +
                withQuery(endpoint + "/download", {
                  environment,
                  run: current.run,
                });
            } else if (current.status === "available")
              setError(t("exportChanged"));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setChecking(false);
          }
        }}
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
              setError(JSON.parse(body).error || t("exportMissing"));
            } catch {
              setError(t("exportMissing"));
            }
          }
        }}
      />
    </section>
  );
}
