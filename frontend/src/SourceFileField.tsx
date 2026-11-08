import {
  ExpressionInput,
  type ExpressionVariables,
} from "./VariableExpression";
import { useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { uploadFile } from "./api";
import { previewFile } from "./SourcePreview";
import { useApiResource } from "./useApiResource";
import { useT } from "./i18n";
import Select from "./Select";
import type { Json } from "./types";

/** Project file formats that a reader node imports. */
const SOURCE_EXTENSIONS = [
  ".csv",
  ".tsv",
  ".parquet",
  ".xlsx",
  ".json",
  ".jsonl",
  ".ndjson",
];
export const isSourceFile = (name: string) =>
  SOURCE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
/** Built-in readers whose `file` parameter selects a project file. */
export const isFileReader = (template?: string) =>
  /^load_(csv|parquet|xlsx|json)$/.test(template || "");

export const sourceFileName = (path: string) =>
  path
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/^[a-f0-9]{16}_/, "") || "";

export default function SourceFileField({
  id,
  worktree,
  value,
  onChange,
  onBlur,
  csv,
  expressionVariables,
}: {
  id: string;
  worktree: string;
  value: string;
  csv?: boolean;
  expressionVariables?: ExpressionVariables;
  onChange: (value: Json, settings?: Record<string, Json>) => void;
  onBlur?: () => void;
}) {
  const t = useT();
  const files = useApiResource<{ name: string; path: string }[]>(
    `/worktrees/${worktree}/source-files`,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [expression, setExpression] = useState(value.includes("{{"));
  const attempt = useRef(0);
  const choose = async (path: string) => {
    const request = ++attempt.current;
    setPending(true);
    setError("");
    let settings: Record<string, Json> | undefined;
    if (path && csv) {
      try {
        settings = {
          ...(await previewFile(worktree, { file: path })).settings,
          types: {},
        };
      } catch (e) {
        if (request === attempt.current) setError((e as Error).message);
      }
    }
    if (request !== attempt.current) return;
    onChange(path, settings);
    onBlur?.();
    setPending(false);
  };
  return (
    <>
      <Select
        id={id}
        value={value}
        disabled={pending}
        onChange={(e) => void choose(e.target.value)}
        onBlur={onBlur}
      >
        <option value="">{t("chooseProjectFile")}</option>
        {value && !files.data?.some((file) => file.path === value) && (
          <option value={value}>{sourceFileName(value)}</option>
        )}
        {files.data?.map((file, _, list) => {
          // Uploads of the same name are numbered in upload order.
          const same = list.filter((other) => other.name === file.name);
          return (
            <option key={file.path} value={file.path}>
              {same.length > 1
                ? `${file.name} (${same.indexOf(file) + 1})`
                : file.name}
            </option>
          );
        })}
      </Select>
      {expressionVariables && (
        <details
          open={expression}
          onToggle={(e) => setExpression(e.currentTarget.open)}
        >
          <summary>{t("sourcePathExpression")}</summary>
          <ExpressionInput
            id={`${id}-expression`}
            value={value}
            variables={expressionVariables}
            singleLine
            onChange={(path) => onChange(path)}
            onBlur={onBlur}
          />
        </details>
      )}
      {!value && <small className="muted">{t("dropFileHint")}</small>}
      <label className="file-upload">
        <FileUp size={13} />
        {t("upload")}
        <input
          type="file"
          accept={SOURCE_EXTENSIONS.join(",")}
          aria-label={t("upload")}
          disabled={pending}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            if (!isSourceFile(file.name)) {
              setError(
                t("unsupportedSourceFile").replace("{files}", file.name),
              );
              input.value = "";
              return;
            }
            setPending(true);
            setError("");
            try {
              const path = await uploadFile(file, worktree);
              files.reload();
              await choose(path);
            } catch (e) {
              setError((e as Error).message);
              setPending(false);
            } finally {
              input.value = "";
            }
          }}
        />
      </label>
      {pending && <small role="status">{t("sourcePreviewLoading")}</small>}
      {(error || files.error) && (
        <small className="notice error" role="alert">
          {error || files.error}
        </small>
      )}
    </>
  );
}
