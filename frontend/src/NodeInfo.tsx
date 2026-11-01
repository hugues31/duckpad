import { History } from "lucide-react";
import { withQuery } from "./api";
import type { ElementChange, ElementSummary } from "./gitTypes";
import { useLanguage, useT, useTranslateValue } from "./i18n";
import { relativeTime } from "./relativeTime";
import { useApiResource } from "./useApiResource";

/** A relative date, with the full date and time on hover. */
function When({ date }: { date: string }) {
  const language = useLanguage();
  return (
    <time dateTime={date} title={new Date(date).toLocaleString()}>
      {relativeTime(date, language)}
    </time>
  );
}

/** When a commit changed the element and who made it. */
function Change({ change }: { change: ElementChange }) {
  const t = useT();
  return (
    <span>
      <When date={change.date} />{" "}
      {t("byAuthor").replace("{author}", change.author)}
      {change.assistant ? ` ${t("assistantAttribution")}` : ""}
    </span>
  );
}

const summaryPath = (worktree: string, entity: string) =>
  withQuery(`/worktrees/${worktree}/git/history/summary`, { entity });

/**
 * Who created and changed a node, from the project's Git history, and the
 * identifiers that locate it in the project files. Run outcomes depend on the
 * environment, so they stay with the results.
 */
export default function NodeInfo({
  worktree,
  entity,
  template,
  revision,
  node,
  definitionFile,
  onHistory,
}: {
  worktree: string;
  /** The node's element ID, as the Git comparison names it. */
  entity: string;
  /** The template a linked node runs. */
  template?: string;
  /** The project revision; the summary reloads when it changes. */
  revision: string;
  node: string;
  /** The file holding the node's code, template or component definition. */
  definitionFile: string;
  onHistory: () => void;
}) {
  const t = useT();
  const translateValue = useTranslateValue();
  const summary = useApiResource<ElementSummary>(
    summaryPath(worktree, entity),
    { refresh: revision },
  );
  const templateSummary = useApiResource<ElementSummary>(
    template ? summaryPath(worktree, `template/${template}`) : null,
    { refresh: revision },
  );
  const data = summary.data;
  return (
    <div className="node-info">
      <section aria-labelledby="node-info-changes">
        <h4 id="node-info-changes">{t("nodeChanges")}</h4>
        {summary.error ? (
          <p className="notice error">{summary.error}</p>
        ) : !data ? (
          <p className="muted small">{t("loading")}</p>
        ) : (
          <dl className="info-list">
            <dt>{t("lastModified")}</dt>
            <dd>
              {data.last ? (
                <>
                  <Change change={data.last} />
                  <small>
                    {data.last.message} ·{" "}
                    <code>{data.last.commit.slice(0, 8)}</code>
                  </small>
                  {!!data.last.categories.length && (
                    <small>
                      {data.last.categories.map(translateValue).join(", ")}
                    </small>
                  )}
                </>
              ) : (
                t("noSavedChange")
              )}
            </dd>
            {data.created && (
              <>
                <dt>{t("nodeCreated")}</dt>
                <dd>
                  <Change change={data.created} />
                </dd>
              </>
            )}
            <dt>{t("revisionCount")}</dt>
            <dd>
              {data.changes}
              {data.complete ? "" : "+"}
            </dd>
            {!!data.authors.length && (
              <>
                <dt>{t("contributors")}</dt>
                <dd>{data.authors.join(", ")}</dd>
              </>
            )}
            {templateSummary.data?.last && (
              <>
                <dt>{t("templateModified")}</dt>
                <dd>
                  <Change change={templateSummary.data.last} />
                </dd>
              </>
            )}
          </dl>
        )}
        <button className="button secondary full" onClick={onHistory}>
          <History size={15} />
          {t("viewChangeHistory")}
        </button>
      </section>
      <section aria-labelledby="node-info-details">
        <h4 id="node-info-details">{t("nodeDetails")}</h4>
        <dl className="info-list">
          <dt>{t("identifier")}</dt>
          <dd>
            <code>{node}</code>
          </dd>
          <dt>{t("definitionFile")}</dt>
          <dd>
            <code>{definitionFile}</code>
          </dd>
        </dl>
      </section>
    </div>
  );
}
