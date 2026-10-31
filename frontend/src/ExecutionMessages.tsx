import { AlertTriangle } from "lucide-react";
import { useT } from "./i18n";
import type { ExecutionResult } from "./types";

export function warningCount(results: ExecutionResult[] = []) {
  return results.reduce(
    (count, result) =>
      count +
      (result.omitted
        ? result.counts?.warning || 0
        : Number(result.level === "warning")),
    0,
  );
}

export function WarningBadge({ count }: { count: number }) {
  const t = useT();
  const label = t("warningCount").replace("{count}", String(count));
  return count > 0 ? (
    <span className="warning-badge" aria-label={label} title={label}>
      <AlertTriangle size={13} aria-hidden="true" /> {count}
    </span>
  ) : null;
}

export default function ExecutionMessages({
  results = [],
  tests = false,
}: {
  results?: ExecutionResult[];
  tests?: boolean;
}) {
  const t = useT();
  const levels = {
    info: t("messageInfo"),
    warning: t("messageWarning"),
    error: t("messageError"),
  };
  if (!results.length) return null;
  const title = t(tests ? "dataTests" : "executionMessages");
  return (
    <section className="execution-messages" aria-label={title}>
      <h4>
        {title} <WarningBadge count={warningCount(results)} />
      </h4>
      <ul>
        {results.map((result, index) => (
          <li key={index} className={`execution-message ${result.level}`}>
            {result.omitted ? (
              <span>
                {t("moreMessages").replace("{count}", String(result.omitted))}
              </span>
            ) : (
              <>
                <strong>
                  {result.status === "ok" ? t("testOK") : levels[result.level]}
                </strong>
                <span>
                  {result.origin.kind === "test"
                    ? result.origin.name
                    : result.message}
                </span>
                {result.origin.kind === "test" && (
                  <span>
                    {t("testFailingRows").replace(
                      "{count}",
                      String(result.observed),
                    )}
                  </span>
                )}
                <small>
                  {result.origin.kind === "test"
                    ? t("dataTest")
                    : result.origin.name ||
                      t("messageBlock").replace(
                        "{block}",
                        String(result.origin.block),
                      )}
                  {result.output && ` · ${result.output}`}
                </small>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
