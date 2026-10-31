import { withQuery } from "./api";
import { useT } from "./i18n";
import ExecutionMessages from "./ExecutionMessages";
import type { TestExecution } from "./types";
import { useApiResource } from "./useApiResource";

/** Test outcomes belong to each attempt, even when its outputs could not be published. */
export default function NodeTests({
  worktree,
  node,
  environment,
  refresh,
}: {
  worktree: string;
  node: string;
  environment: string;
  refresh: string;
}) {
  const t = useT();
  const history = useApiResource<TestExecution[]>(
    withQuery(
      `/worktrees/${worktree}/test-history/${encodeURIComponent(node)}`,
      {
        environment,
      },
    ),
    { refresh },
  );
  if (history.error) return <p className="notice error">{history.error}</p>;
  const [latest, ...previous] = history.data || [];
  if (!latest) return null;
  return (
    <div className="node-tests">
      <ExecutionMessages results={latest.results} tests />
      {previous.length > 0 && (
        <details className="test-history">
          <summary>{t("testHistory")}</summary>
          {previous.map((execution) => (
            <div key={execution.run}>
              <time dateTime={execution.started}>
                {new Date(execution.started).toLocaleString()}
              </time>
              <ExecutionMessages results={execution.results} tests />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
