import { useState } from "react";
import { Link } from "react-router";
import { api, send } from "./api";
import { TabStatus } from "./gitTabs";
import type { MergeReview } from "./gitTypes";
import { useT } from "./i18n";
import type { LineageTarget } from "./lineageGraph";
import { codeFileUrl } from "./navigation";
import { displayNodeName } from "./nodeNames";
import { useResource } from "./useApiResource";
import { useLoadedWorktree } from "./worktree";

type Entry = {
  node: string;
  name?: string;
  file?: string;
  port?: string;
  label?: string;
  error?: string;
  existing?: boolean;
  direct?: boolean;
  reason?: string;
  resource?: Record<string, unknown>;
};
export interface SchemaReport {
  before?: string;
  after?: string;
  changes: (Entry & {
    added: string[];
    removed: string[];
    renamed: { before: string; after: string }[];
    retyped: { name: string; before: string; after: string }[];
  })[];
  failures: Entry[];
  unknown: Entry[];
  exports: Entry[];
}

function SchemaResults({
  report,
  worktree,
  environment,
}: {
  report: SchemaReport;
  worktree: string;
  environment: string;
}) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  const title = (entry: Entry) => (
    <>
      <strong>
        {entry.name ||
          displayNodeName(snapshot.node_names?.[entry.node], entry.node, t)}
      </strong>
      {entry.port && ` · ${entry.port}`}
      {/* Tests, messages and exports have no port; name the checked statement. */}
      {entry.label && entry.label !== entry.port && ` · ${entry.label}`}
      {entry.file && (
        <>
          {" "}
          ·{" "}
          <Link to={codeFileUrl(worktree, entry.file, environment)}>
            {t("impactOpenCode")}
          </Link>
        </>
      )}
    </>
  );
  return (
    <div className="schema-impact-results">
      {report.before && (
        <p>
          <code>
            {report.before} → {report.after}
          </code>
        </p>
      )}
      <section className="impact-group">
        <h4>
          {t("schemaFailures")} ({report.failures.length})
        </h4>
        {report.failures.length === 0 && (
          <p className="muted">{t("schemaNoFailures")}</p>
        )}
        {report.failures.map((entry, i) => (
          <article className="lineage-step" key={i}>
            <header>{title(entry)}</header>
            {(entry.existing || entry.direct === false) && (
              <p className="small">
                {[
                  entry.existing && t("schemaExistingFailure"),
                  entry.direct === false && t("schemaUnchangedNode"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <pre>{entry.error}</pre>
          </article>
        ))}
      </section>
      <section className="impact-group">
        <h4>
          {t("schemaOutputChanges")} ({report.changes.length})
        </h4>
        {report.changes.map((entry, i) => (
          <article className="lineage-step" key={i}>
            <header>{title(entry)}</header>
            {!!entry.added.length && (
              <p>
                {t("gitColumnsAdded")}: {entry.added.join(", ")}
              </p>
            )}
            {!!entry.removed.length && (
              <p>
                {t("gitColumnsRemoved")}: {entry.removed.join(", ")}
              </p>
            )}
            {entry.renamed.map((c) => (
              <p key={c.before}>
                {t("schemaRenamed")}:{" "}
                <code>
                  {c.before} → {c.after}
                </code>
              </p>
            ))}
            {entry.retyped.map((c) => (
              <p key={c.name}>
                <code>
                  {c.name}: {c.before} → {c.after}
                </code>
              </p>
            ))}
          </article>
        ))}
      </section>
      <section className="impact-group">
        <h4>
          {t("impactExports")} ({report.exports.length})
        </h4>
        {report.exports.map((entry, i) => (
          <article className="lineage-step" key={i}>
            <header>{title(entry)}</header>
            {entry.resource && (
              <code>
                {Object.values(entry.resource).map(String).join(" · ")}
              </code>
            )}
          </article>
        ))}
      </section>
      {!!report.unknown.length && (
        <section className="impact-group">
          <h4>
            {t("schemaUnknown")} ({report.unknown.length})
          </h4>
          {report.unknown.map((entry, i) => (
            <article className="lineage-step" key={i}>
              <header>{title(entry)}</header>
              <p>
                {t(
                  entry.reason === "python"
                    ? "lineageColumnPython"
                    : entry.reason === "needs_run"
                      ? "schemaNeedsSource"
                      : entry.reason === "upstream"
                        ? "schemaUpstream"
                        : entry.reason === "extension"
                          ? "schemaExtension"
                          : "lineageColumnIncomplete",
                )}
              </p>
              {entry.error && <pre>{entry.error}</pre>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

export function TypeSimulation({ target }: { target: LineageTarget }) {
  const t = useT();
  const { id, environment, snapshot } = useLoadedWorktree();
  const [type, setType] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const body = {
    environment,
    node: target.node,
    port: target.port,
    column: target.column,
    new_type: submitted,
  };
  const result = useResource<SchemaReport>(
    submitted ? JSON.stringify([id, snapshot.revision, body]) : null,
    (signal) =>
      api(`/worktrees/${id}/lineage/simulate-type`, { ...send(body), signal }),
  );
  return (
    <details className="impact-rename">
      <summary>{t("schemaSimulate")}</summary>
      <p className="small muted">{t("schemaSimulationHint")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (submitted === type.trim()) result.reload();
          else setSubmitted(type.trim());
        }}
      >
        <label>
          {t("schemaNewType")}
          <input
            value={type}
            placeholder="VARCHAR, DOUBLE, DECIMAL(18, 2)…"
            maxLength={256}
            autoComplete="off"
            onChange={(event) => {
              setType(event.target.value);
              setSubmitted(null);
            }}
          />
        </label>
        <button
          className="button secondary small"
          disabled={!type.trim() || result.pending}
        >
          {t("schemaRunSimulation")}
        </button>
      </form>
      <TabStatus
        pending={result.pending}
        error={result.error}
        onRetry={result.reload}
      />
      {!result.pending && result.data && (
        <SchemaResults
          report={result.data}
          worktree={id}
          environment={environment}
        />
      )}
    </details>
  );
}

export function GitSchemaImpact({
  review,
  environment,
}: {
  review: MergeReview;
  environment: string;
}) {
  const t = useT();
  const body = {
    choices: review.choices,
    proposal_revision: review.proposal_revision,
    environment,
  };
  const ready = !review.unresolved.length && !review.diagnostics.length;
  const result = useResource<SchemaReport>(
    ready ? JSON.stringify([review.id, body]) : null,
    (signal) =>
      api(
        `/worktrees/${review.worktree}/git/reviews/${review.id}/schema-impact`,
        { ...send(body), signal },
      ),
  );
  return (
    <section className="git-data-impact" aria-label={t("schemaGitImpact")}>
      <h3>
        {t("schemaGitImpact")} · {environment}
      </h3>
      <p className="muted">{t("schemaGitHint")}</p>
      {!ready && <p>{t("resolveBeforeApply")}</p>}
      <TabStatus
        pending={result.pending}
        error={result.error}
        onRetry={result.reload}
      />
      {!result.pending && result.data && (
        <SchemaResults
          report={result.data}
          worktree={review.worktree}
          environment={environment}
        />
      )}
    </section>
  );
}
