import { useMemo } from "react";
import { useT, useTranslateValue } from "./i18n";
import { applyPartitionDraft } from "./partitionEdits";
import type { PartitionDefinition, PartitionType } from "./partitions";
import Select from "./Select";
import { useAsyncAction } from "./useAsyncAction";
import { useRevisionDraft } from "./useRevisionDraft";
import { ValueSourceFields } from "./ValueSourceFields";
import { useOptionalWorktree } from "./worktree";

export function DimensionEditor({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const translate = useTranslateValue();
  const worktree = useOptionalWorktree()!;
  const snapshot = worktree.snapshot!;
  const original = Object.entries(snapshot.bundle!.flow.partitions || {})[0];
  const value = useMemo(() => {
    const original = Object.entries(snapshot.bundle!.flow.partitions || {})[0];
    const definition: PartitionDefinition = original?.[1] || {
      type: "text",
      values: { node: "", column: "" },
      attributes: [],
      execution: { parallelism: 1, on_error: "stop" },
      preview: { keep: "last", count: 1, max_bytes: 1073741824 },
    };
    return {
      name: original?.[0] || "batch",
      definition,
      attributes: definition.attributes?.join(", ") || "",
      renames: {} as Record<string, string>,
    };
  }, [snapshot.bundle]);
  const action = useAsyncAction();
  const editor = useRevisionDraft(
    value,
    snapshot,
    async ({ name, definition: draft, attributes, renames }, base) => {
      return worktree.save(base, (bundle) =>
        applyPartitionDraft(bundle, name, draft, attributes, renames, t),
      );
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const { name, definition: draft, attributes, renames } = editor.draft;
  const setName = (name: string) =>
    editor.update((value) => ({ ...value, name }));
  const setDraft = (definition: PartitionDefinition) =>
    editor.update((value) => ({ ...value, definition }));
  const setAttributes = (attributes: string) =>
    editor.update((value) => ({ ...value, attributes }));
  const setRenames = (renames: Record<string, string>) =>
    editor.update((value) => ({ ...value, renames }));
  return (
    <form
      className="settings-card partition-settings"
      aria-label={t("partitionSettings")}
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await editor.persist();
          onSaved();
        });
      }}
    >
      <h2>{t("partitions")}</h2>
      <p className="muted">{t("partitionSettingsHint")}</p>
      <p>
        {t("branch")}: <strong>{snapshot.worktree.branch}</strong>
      </p>
      <fieldset
        className="settings-fields"
        disabled={!worktree.canEdit || action.pending}
      >
        <label className="field">
          <span>{t("partitionDimension")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <ValueSourceFields
          snapshot={snapshot}
          value={draft.values}
          onChange={(values) => setDraft({ ...draft, values })}
        />
        <label className="field">
          <span>{t("partitionKeyType")}</span>
          <Select
            value={draft.type}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as PartitionType })
            }
          >
            {["text", "number", "date", "boolean"].map((kind) => (
              <option key={kind} value={kind}>
                {translate(kind)}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span>{t("partitionAttributes")}</span>
          <input
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
          />
        </label>
        {(editor.saved.definition.attributes || []).map((attribute) => (
          <label className="field" key={attribute}>
            <span>
              {t("partitionRenameAttribute").replace("{name}", attribute)}
            </span>
            <input
              value={renames[attribute] ?? attribute}
              onChange={(event) =>
                setRenames({ ...renames, [attribute]: event.target.value })
              }
            />
          </label>
        ))}
        <label className="field">
          <span>{t("partitionParallelism")}</span>
          <input
            type="number"
            min="1"
            max="32"
            value={draft.execution?.parallelism || 1}
            onChange={(e) =>
              setDraft({
                ...draft,
                execution: {
                  ...draft.execution,
                  parallelism: Number(e.target.value),
                },
              })
            }
          />
        </label>
        <label className="field">
          <span>{t("partitionOnError")}</span>
          <Select
            value={draft.execution?.on_error || "stop"}
            onChange={(e) =>
              setDraft({
                ...draft,
                execution: {
                  ...draft.execution,
                  on_error: e.target.value as "stop" | "continue",
                },
              })
            }
          >
            <option value="stop">{t("partitionStop")}</option>
            <option value="continue">{t("partitionContinue")}</option>
          </Select>
        </label>
        <label className="field">
          <span>{t("partitionRetention")}</span>
          <Select
            value={draft.preview?.keep || "last"}
            onChange={(e) =>
              setDraft({
                ...draft,
                preview: {
                  max_bytes: draft.preview?.max_bytes,
                  keep: e.target.value as "last" | "all" | "none",
                  ...(e.target.value === "last" ? { count: 1 } : {}),
                },
              })
            }
          >
            <option value="last">{t("partitionKeepLast")}</option>
            <option value="all">{t("partitionKeepAll")}</option>
            <option value="none">{t("partitionKeepNone")}</option>
          </Select>
        </label>
        <label className="field">
          <span>{t("partitionPreviewBytes")}</span>
          <input
            type="number"
            min="1"
            step="1"
            value={(draft.preview?.max_bytes ?? 1073741824) / 1048576}
            onChange={(e) =>
              setDraft({
                ...draft,
                preview: {
                  ...draft.preview,
                  max_bytes: Math.round(Number(e.target.value) * 1048576),
                },
              })
            }
          />
        </label>
      </fieldset>
      <p className="muted">{t("partitionRetentionHint")}</p>
      {action.error && (
        <p className="notice error" role="alert">
          {action.error}
        </p>
      )}
      <div className="partition-settings-actions row gap">
        {original && (
          <button
            type="button"
            className="button secondary"
            disabled={
              !worktree.canEdit ||
              action.pending ||
              snapshot.bundle!.flow.nodes.some(
                (node) =>
                  node.partitions === "all" ||
                  Object.values(node.outputs || {}).some(
                    (output) => output.partition,
                  ),
              )
            }
            onClick={() =>
              action.run(async () => {
                await worktree.save(snapshot, (bundle) => {
                  delete bundle.flow.partitions;
                });
                editor.discard();
                onSaved();
              })
            }
          >
            {t("partitionRemoveDimension")}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={!editor.dirty || action.pending}
          onClick={() => {
            editor.discard();
            action.setError("");
          }}
        >
          {t("discardChanges")}
        </button>
        <button
          className="button primary"
          disabled={
            !worktree.canEdit ||
            action.pending ||
            !editor.dirty ||
            !draft.values.node ||
            !draft.values.column.trim()
          }
        >
          {t("save")}
        </button>
        {editor.dirty && (
          <span className="muted small">{t("unsavedChanges")}</span>
        )}
      </div>
    </form>
  );
}
