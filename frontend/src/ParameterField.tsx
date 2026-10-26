import { useId, useState } from "react";
import { FileUp } from "lucide-react";
import { uploadFile } from "./api";
import { useT } from "./i18n";
import type { Json } from "./types";

export default function ParameterField({
  parameter,
  value,
  onChange,
  onBlur,
  connections,
  schemas,
}: {
  parameter: Json;
  value: any;
  onChange: (value: any) => void;
  onBlur?: () => void;
  connections: Json[];
  schemas?: string[];
}) {
  const t = useT();
  const columnList = useId();
  const [uploadError, setUploadError] = useState("");
  const name = parameter.name;
  const type = parameter.type || "text";
  const base = type.split(/[<(]/)[0];
  if (base === "secret") return null;
  return (
    <label className="field">
      <span>
        {name.replaceAll("_", " ")}
        <small>{base}</small>
      </span>
      {base === "boolean" ? (
        <select
          value={String(value ?? false)}
          onChange={(e) => onChange(e.target.value === "true")}
          onBlur={onBlur}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : base === "connection" ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {!value && <option value="">{t("notConnected")}</option>}
          {value && !connections.some((c) => c.id === value) && (
            <option value={value} disabled>
              {value} · {t("unavailableConnection")}
            </option>
          )}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : base === "choice" || base === "keyword" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {(type.match(/\((.*)\)/)?.[1] || "").split("|").map((x: string) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      ) : base === "list" ? (
        <input
          value={Array.isArray(value) ? value.join(", ") : value || ""}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((x) => x.trim()))
          }
          onBlur={onBlur}
        />
      ) : base === "expressions" ||
        base === "expression" ||
        base === "schema" ? (
        <textarea
          rows={3}
          className="code-input"
          value={
            typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : (value ?? "")
          }
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      ) : (
        <input
          type={base === "number" ? "number" : "text"}
          value={value ?? ""}
          onChange={(e) =>
            onChange(
              base === "number" ? Number(e.target.value) : e.target.value,
            )
          }
          onBlur={onBlur}
          list={base === "column" && schemas ? columnList : undefined}
        />
      )}
      {base === "file" && (
        <span className="file-upload">
          <FileUp size={13} />
          {t("upload")}
          <input
            type="file"
            accept=".csv,.parquet,.tsv"
            aria-label={t("upload")}
            onChange={async (e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              setUploadError("");
              try {
                onChange(await uploadFile(file));
              } catch (error) {
                setUploadError((error as Error).message);
              } finally {
                // Allow choosing the same file again.
                input.value = "";
              }
            }}
          />
        </span>
      )}
      {uploadError && <span className="notice error">{uploadError}</span>}
      {base === "column" && schemas && (
        <datalist id={columnList}>
          {schemas.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}
