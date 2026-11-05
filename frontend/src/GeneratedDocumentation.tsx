import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { displayNodeName } from "./nodeNames";
import { projectDocumentation } from "./projectDocumentation";
import { useT } from "./i18n";
import type { Snapshot, Statuses } from "./types";

export default function GeneratedDocumentation({
  snapshot,
  statuses,
}: {
  snapshot: Snapshot;
  statuses: Statuses;
}) {
  const t = useT();
  return (
    <section
      className="generated-documentation"
      aria-label={t("generatedDocumentation")}
    >
      <h2>{t("generatedDocumentation")}</h2>
      <p className="muted">{t("generatedDocumentationHint")}</p>
      {projectDocumentation(snapshot, statuses).map((node) => (
        <details className="settings-card" key={node.id}>
          <summary title={node.id}>
            {displayNodeName(node.name, t("node"), t)}
          </summary>
          <Markdown remarkPlugins={[remarkGfm]}>{node.description}</Markdown>
          <h3>{t("results_tests")}</h3>
          {node.tests.length ? (
            <ul>
              {node.tests.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t("noDeclaredTests")}</p>
          )}
          {node.outputs.map((output) => (
            <section key={output.port}>
              <h3>
                {t("output")}: {output.port}
              </h3>
              <Markdown remarkPlugins={[remarkGfm]}>
                {output.description}
              </Markdown>
              {output.dataset?.status === "stale" && (
                <p className="badge stale">{t("stale")}</p>
              )}
              {!output.dataset && (
                <p className="muted">{t("documentationSchemaHint")}</p>
              )}
              {!!output.columns.length && (
                <table>
                  <thead>
                    <tr>
                      <th>{t("column")}</th>
                      <th>{t("columnType")}</th>
                      <th>{t("description")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {output.columns.map((column) => (
                      <tr key={column.name}>
                        <td>{column.name}</td>
                        <td>{column.type || "—"}</td>
                        <td>
                          <Markdown>{column.description}</Markdown>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </details>
      ))}
    </section>
  );
}
