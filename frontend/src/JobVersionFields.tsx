import { useT } from "./i18n";
import Select from "./Select";

/** The same version choice when creating a job and reviewing its next version. */
export default function JobVersionFields({
  kind,
  reference,
  versions,
  onKind,
  onReference,
}: {
  kind: "tag" | "branch";
  reference: string;
  versions: { name: string }[];
  onKind: (kind: "tag" | "branch") => void;
  onReference: (reference: string) => void;
}) {
  const t = useT();
  return (
    <>
      <label className="field">
        <span>{t("jobTarget")}</span>
        <Select
          aria-label={t("jobTarget")}
          value={kind}
          onChange={(event) => onKind(event.target.value as "tag" | "branch")}
        >
          <option value="tag">{t("jobTagTarget")}</option>
          <option value="branch">{t("jobBranchTarget")}</option>
        </Select>
      </label>
      <label className="field">
        <span>{t("jobVersion")}</span>
        <Select
          aria-label={t("jobVersion")}
          name="ref"
          required
          value={reference}
          onChange={(event) => onReference(event.target.value)}
        >
          <option value="">{t("jobChooseVersion")}</option>
          {versions.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
      </label>
    </>
  );
}
