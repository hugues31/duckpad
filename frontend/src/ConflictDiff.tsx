import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { ConflictValue, MergeChoice, MergeConflict } from "./gitTypes";
import { changedCharacters, conflictCounts, valueText } from "./conflicts";
import { countLabel, useT } from "./i18n";
import { projectFileLanguage } from "./projectFiles";

const CodeDiff = lazy(() =>
  import("./Editor").then((module) => ({ default: module.CodeDiff })),
);
const CodeEditor = lazy(() => import("./Editor"));

export function ConflictSummary({
  conflicts,
}: {
  conflicts: Pick<MergeConflict, "path">[];
}) {
  const t = useT();
  const { files, fields } = conflictCounts(conflicts);
  return (
    <p className="conflict-summary">
      {[
        files
          ? countLabel(t, files, "fileConflictOne", "fileConflictMany")
          : "",
        fields
          ? countLabel(t, fields, "fieldConflictOne", "fieldConflictMany")
          : "",
      ]
        .filter(Boolean)
        .join(` ${t("conflictAnd")} `)}
    </p>
  );
}

export function ConflictHeading({
  title,
  path,
}: {
  title: string;
  path: string;
}) {
  return (
    <>
      <span className="conflict-title">{title}</span>
      <code className="conflict-path muted">{path}</code>
    </>
  );
}

function HighlightedValue({
  value,
  changed,
  side,
}: {
  value: ConflictValue;
  changed: Set<number>;
  side: string;
}) {
  const t = useT();
  if (!value.present) return <pre className="muted">{t("absent")}</pre>;
  const text = valueText(value);
  if (!text) return <pre className="muted">{t("conflictEmpty")}</pre>;
  const chunks: ReactNode[] = [];
  for (let start = 0; start < text.length;) {
    const highlight = changed.has(start);
    let end = start + 1;
    while (end < text.length && changed.has(end) === highlight) end++;
    chunks.push(
      highlight ? (
        <mark className={`conflict-${side}`} key={start}>
          {text.slice(start, end)}
        </mark>
      ) : (
        text.slice(start, end)
      ),
    );
    start = end;
  }
  return <pre>{chunks}</pre>;
}

/** The same three-way field evidence in concurrent saves and Git merge reviews. */
export function FieldConflictDiff({
  conflict,
  onChoose,
  disabled = false,
}: {
  conflict: MergeConflict;
  onChoose?: (choice: MergeChoice) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [removedCurrent, current] = changedCharacters(
    valueText(conflict.base),
    valueText(conflict.current),
  );
  const [removedIncoming, incoming] = changedCharacters(
    valueText(conflict.base),
    valueText(conflict.incoming),
  );
  const changed = {
    base: new Set([...removedCurrent, ...removedIncoming]),
    current,
    incoming,
  };
  return (
    <div className="git-conflict-values">
      {(["base", "current", "incoming"] as const).map((choice) => (
        <div key={choice} className="conflict-value">
          {onChoose ? (
            <label>
              <input
                type="radio"
                name={conflict.path}
                checked={conflict.choice === choice}
                disabled={disabled}
                onChange={() => onChoose(choice)}
              />{" "}
              {t(choice)}
            </label>
          ) : (
            <strong>{t(choice)}</strong>
          )}
          <HighlightedValue
            value={conflict[choice]}
            changed={changed[choice]}
            side={choice === "base" ? "removed" : "added"}
          />
        </div>
      ))}
    </div>
  );
}

export function FileConflictDiff({
  conflict,
  file,
  text,
  onChange,
}: {
  conflict: MergeConflict;
  file: string;
  text?: string;
  onChange?: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="conflict-file-diff">
      <div className="conflict-diff-labels">
        <span>
          {t("current")}
          {!conflict.current.present && ` · ${t("absent")}`}
        </span>
        <span>
          {onChange ? t("combined") : t("incoming")}
          {!conflict.incoming.present && !onChange && ` · ${t("absent")}`}
        </span>
      </div>
      <Suspense fallback={<p>{t("loading")}</p>}>
        <CodeDiff
          before={valueText(conflict.current)}
          after={text ?? valueText(conflict.incoming)}
          language={projectFileLanguage(file)}
          onChange={onChange}
          originalLabel={t("current")}
          modifiedLabel={onChange ? t("combined") : t("incoming")}
        />
      </Suspense>
      <details className="conflict-base">
        <summary>{t("base")}</summary>
        {conflict.base.present ? (
          <Suspense fallback={<p>{t("loading")}</p>}>
            <CodeEditor
              value={valueText(conflict.base)}
              language={projectFileLanguage(file)}
              readOnly
              height="180px"
            />
          </Suspense>
        ) : (
          <p>{t("absent")}</p>
        )}
      </details>
    </div>
  );
}
