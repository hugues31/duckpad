import { Loader2 } from "lucide-react";
import { useT } from "./i18n";
import type { Run } from "./types";

/** Keep live execution details out of the project navigation and run controls. */
export default function RunProgress({ run }: { run: Run }) {
  const t = useT();
  const nodes = Object.values(run.nodes);
  const partitions = run.partitions;
  const total = partitions ? partitions.selected : nodes.length;
  const completed = partitions
    ? partitions.completed
    : nodes.filter((node) => node.status === "success").length;
  const failed = partitions
    ? partitions.failed
    : nodes.filter((node) => node.status === "failed").length;
  const count = total
    ? `${completed}/${total} ${t(partitions ? "partitions" : "nodes")}`
    : "";
  const outcome = [count, failed ? `${failed} ${t("failed")}` : ""]
    .filter(Boolean)
    .join(" · ");
  const phase = run.phase || partitions?.phase;
  const details = [
    t(run.status),
    run.environment,
    phase === "values"
      ? t("calculatingValues")
      : phase === "consumers"
        ? t("runningConsumers")
        : "",
    partitions?.active_keys?.length
      ? `${t("running")}: ${partitions.active_keys.map((key) => String(key.value)).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const percent = total
    ? Math.min(100, (100 * (completed + failed)) / total)
    : undefined;
  return (
    <div className="run-progress" data-paused={run.status === "canceling"}>
      <Loader2 className="spin" size={13} aria-hidden="true" />
      <span className="run-progress-details" title={details}>
        {details}
      </span>
      {outcome && <span className="run-progress-count">{outcome}</span>}
      <div
        className="progress-track"
        role="progressbar"
        aria-label={t("runProgress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={[details, outcome].filter(Boolean).join(" · ")}
        data-indeterminate={percent === undefined}
      >
        <div
          style={{ width: percent === undefined ? undefined : `${percent}%` }}
        />
      </div>
    </div>
  );
}
