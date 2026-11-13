import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Link } from "react-router";
import { codeFileUrl } from "./navigation";
import { api, send, withQuery } from "./api";
import { useT } from "./i18n";
import type { LineageTarget } from "./lineageGraph";
import type { LineageMap } from "./LineageSteps";
import { displayNodeName } from "./nodeNames";
import type { Snapshot } from "./types";
import { useApiResource } from "./useApiResource";
import { useLoadedWorktree } from "./worktree";

type Entry = {
  node: string;
  port?: string;
  column?: string;
  label?: string;
  kind?: string;
  file?: string;
  excerpt?: string;
  expression?: string;
  parameters?: string[];
  resource?: Record<string, unknown>;
  instances?: number;
  reason?: string;
};
type Group =
  | "edit"
  | "follows"
  | "derived"
  | "exports"
  | "manual"
  | "unaffected"
  | "mentions";
export type Impact = Record<Group, Entry[]> & {
  revision: string;
  source: boolean;
  affected_columns: number;
  token?: string;
  changes?: { file: string; before: string; after: string }[];
};
const groups = {
  edit: "impactEdit",
  follows: "impactFollows",
  derived: "impactDerived",
  exports: "impactExports",
  manual: "impactManual",
  unaffected: "impactUnaffected",
  mentions: "impactMentions",
} as const;

export function ColumnImpact({
  target,
  onMap,
  onHover,
  onOpen,
  onChange,
}: {
  target: LineageTarget;
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
  onChange: (target: LineageTarget) => void;
}) {
  const t = useT();
  const { id, environment, snapshot, statuses, canEdit, commit, settle } =
    useLoadedWorktree();
  const query = {
    node: target.node,
    port: target.port,
    column: target.column,
    environment,
  };
  const url = withQuery(`/worktrees/${id}/lineage/impact`, query);
  const { data, error, pending } = useApiResource<Impact>(url, {
    refresh: JSON.stringify([snapshot.revision, statuses.nodes]),
  });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<Impact | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const map = useMemo(() => {
    if (!data) return null;
    const next: LineageMap = { [target.node]: { value: target.column } };
    for (const [group, badge] of [
      ["follows", t("impactFollowsBadge")],
      ["derived", "ƒ"],
      ["exports", t("impactFileBadge")],
      ["edit", t("impactEditBadge")],
      ["manual", "?"],
    ] as const) {
      for (const entry of data[group]) next[entry.node] = { value: badge };
    }
    return next;
  }, [data, target.node, target.column, t]);
  useEffect(() => {
    onMap(error ? null : map);
    return () => onMap(null);
  }, [map, error, onMap]);
  const nodeName = (node: string) =>
    displayNodeName(snapshot.node_names?.[node], node, t);
  const preview = async () => {
    setBusy(true);
    setFailure("");
    setPlan(null);
    try {
      await settle();
      setPlan(
        await api<Impact>(
          withQuery(`/worktrees/${id}/lineage/impact`, { ...query, name }),
        ),
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!plan?.token) return;
    setBusy(true);
    setFailure("");
    try {
      await commit(() =>
        api<Snapshot>(
          `/worktrees/${id}/lineage/rename`,
          send({ ...query, name, revision: plan.revision, token: plan.token }),
        ),
      );
      onChange({ ...target, column: name });
    } catch (e) {
      setFailure((e as Error).message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="column-impact">
      {(error || failure) && (
        <p className="notice error" role="alert">
          {error || failure}
        </p>
      )}
      {pending && (
        <Loader2 className="spin" size={16} aria-label={t("loading")} />
      )}
      {data && (
        <>
          <p>
            {t("impactSummary")
              .replace("{column}", target.column || "")
              .replace(
                "{nodes}",
                String(
                  new Set(
                    data.edit
                      .filter(
                        (e) => e.kind !== "setting" && e.file !== "views.json",
                      )
                      .map((e) => e.node),
                  ).size,
                ),
              )
              .replace(
                "{views}",
                String(
                  new Set(
                    data.edit
                      .filter((e) => e.file === "views.json")
                      .map((e) => e.label),
                  ).size,
                ),
              )
              .replace("{columns}", String(data.affected_columns))
              .replace("{exports}", String(data.exports.length))}
          </p>
          {canEdit && !renaming && (
            <button onClick={() => setRenaming(true)}>
              {t("impactRename")}
            </button>
          )}
          {renaming && (
            <form
              className="impact-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void preview();
              }}
            >
              <label>
                {t("impactNewName")}
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setPlan(null);
                  }}
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              {data.source && (
                <p className="notice warning">{t("impactSourceWarning")}</p>
              )}
              {!!data.manual.length && (
                <p className="notice warning">{t("impactManualWarning")}</p>
              )}
              <div className="button-row">
                <button type="submit" disabled={busy || !name.trim()}>
                  {t("impactPreview")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRenaming(false);
                    setPlan(null);
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
              {plan && (
                <>
                  <p>{t("impactSaveOnce")}</p>
                  {plan.changes?.map((change) => (
                    <details key={change.file} className="impact-file">
                      <summary>{change.file}</summary>
                      <h4>{t("impactBefore")}</h4>
                      <pre>{change.before || "∅"}</pre>
                      <h4>{t("impactAfter")}</h4>
                      <pre>{change.after || "∅"}</pre>
                    </details>
                  ))}
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !plan.changes?.length ||
                      plan.revision !== snapshot.revision
                    }
                    onClick={() => void apply()}
                  >
                    {t("impactApply")}
                  </button>
                </>
              )}
            </form>
          )}
          {(Object.keys(groups) as Group[]).map((group) => (
            <section key={group} className={`impact-group impact-${group}`}>
              <h3>
                {t(groups[group])} <small>({data[group].length})</small>
              </h3>
              {!data[group].length && (
                <p className="muted">{t("impactNone")}</p>
              )}
              {data[group].map((entry, index) => (
                <article
                  className="lineage-step"
                  key={index}
                  onMouseEnter={() => onHover(entry.node)}
                  onMouseLeave={() => onHover(null)}
                >
                  <header>
                    <button
                      className="text-button"
                      onClick={() => onOpen(entry.node)}
                      onFocus={() => onHover(entry.node)}
                      onBlur={() => onHover(null)}
                    >
                      {nodeName(entry.node)}
                    </button>
                  </header>
                  <div className="small muted">
                    {[entry.port, entry.label, entry.column]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {entry.excerpt && <pre>{entry.excerpt}</pre>}
                  {entry.expression &&
                    group !== "follows" &&
                    group !== "derived" && <code>{entry.expression}</code>}
                  {entry.parameters?.map((param) => (
                    <div key={param}>
                      <code>{param}</code>
                    </div>
                  ))}
                  {entry.resource && (
                    <code>
                      {Object.values(entry.resource).map(String).join(" · ")}
                    </code>
                  )}
                  {(entry.instances || 0) > 1 && (
                    <p className="small">
                      {t("impactShared").replace(
                        "{count}",
                        String(entry.instances),
                      )}
                    </p>
                  )}
                  {group === "manual" && (
                    <p>
                      {t(
                        entry.reason === "python"
                          ? "lineageColumnPython"
                          : "lineageColumnIncomplete",
                      )}
                    </p>
                  )}
                  {entry.file && (
                    <div className="small">
                      {entry.file}
                      <Link to={codeFileUrl(id, entry.file, environment)}>
                        {t("impactOpenCode")}
                      </Link>
                    </div>
                  )}
                </article>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
