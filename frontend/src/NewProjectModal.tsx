import { useEffect, useRef, useState } from "react";
import { FileArchive, FolderPlus, Loader2, Workflow } from "lucide-react";
import type { ImportWarnings } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import { useAsyncAction } from "./useAsyncAction";

const STARTING_POINTS = {
  empty: {
    icon: FolderPlus,
    label: "emptyProject",
    description: "emptyProjectDescription",
  },
  example: {
    icon: Workflow,
    label: "fromExample",
    description: "exampleDescription",
  },
  archive: {
    icon: FileArchive,
    label: "importArchive",
    description: "importArchiveDescription",
  },
} as const;

/** A project created from an archive, opened once its import warnings are read. */
export interface ImportedProject {
  warnings: ImportWarnings;
  open: () => void;
}

export default function NewProjectModal({
  createEmpty,
  createExample,
  importArchive,
  onClose,
}: {
  createEmpty: (name: string) => Promise<void>;
  createExample: (name: string) => Promise<void>;
  importArchive: (file: File, name: string) => Promise<ImportedProject>;
  onClose: () => void;
}) {
  const t = useT();
  const [template, setTemplate] =
    useState<keyof typeof STARTING_POINTS>("empty");
  const [name, setName] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [imported, setImported] = useState<ImportedProject | null>(null);
  const warnings = imported?.warnings;
  const { pending, error, setError, run } = useAsyncAction();
  const submitting = useRef(false);
  const done = useRef<HTMLButtonElement>(null);
  const importing = template === "archive";

  useEffect(() => {
    if (warnings) done.current?.focus();
  }, [warnings]);

  return (
    <Modal
      title={t("newProject")}
      onClose={() => {
        if (imported) imported.open();
        else if (!submitting.current) onClose();
      }}
    >
      <form
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (imported) return imported.open();
          if (submitting.current || (importing ? !archive : !name.trim()))
            return;
          submitting.current = true;
          let result = null as ImportedProject | null;
          const created = await run(async () => {
            if (importing) result = await importArchive(archive!, name.trim());
            else if (template === "empty") await createEmpty(name.trim());
            else await createExample(name.trim());
          });
          submitting.current = false;
          if (!created) return;
          if (!result) return onClose();
          const { connections, files, extensions } = result.warnings;
          // Opening the project closes this dialog, so unavailable dependencies are listed first.
          if (connections.length || files.length || extensions?.length)
            setImported(result);
          else result.open();
        }}
      >
        {warnings ? (
          <div className="modal-content new-project-content">
            <p role="status">{t("projectImported")}</p>
            {!!warnings.connections.length && (
              <div className="notice warning import-warning">
                <p>{t("importMissingConnections")}</p>
                <ul>
                  {warnings.connections.map((connection) => (
                    <li key={connection}>
                      <code>{connection}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!warnings.extensions?.length && (
              <div className="notice warning import-warning">
                <p>{t("importExtensionRequirements")}</p>
                <ul>
                  {warnings.extensions.map((name) => (
                    <li key={name}>
                      <code>{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!warnings.files.length && (
              <div className="notice warning import-warning">
                <p>{t("importMissingFiles")}</p>
                <ul>
                  {warnings.files.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="modal-content new-project-content">
            <label className="field">
              <span>{t("name")}</span>
              <input
                name="project-name"
                data-autofocus
                required={!importing}
                placeholder={importing ? t("archiveNamePlaceholder") : ""}
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset className="project-templates" disabled={pending}>
              <legend>{t("projectStartingPoint")}</legend>
              {(
                Object.keys(STARTING_POINTS) as (keyof typeof STARTING_POINTS)[]
              ).map((value) => {
                const {
                  icon: Icon,
                  label,
                  description,
                } = STARTING_POINTS[value];
                return (
                  <label className="project-template" key={value}>
                    <input
                      type="radio"
                      name="project-template"
                      value={value}
                      checked={template === value}
                      aria-labelledby={`project-template-${value}`}
                      aria-describedby={`project-template-${value}-description`}
                      onChange={() => {
                        setTemplate(value);
                        setError("");
                      }}
                    />
                    <Icon size={22} aria-hidden="true" />
                    <strong id={`project-template-${value}`}>{t(label)}</strong>
                    <span id={`project-template-${value}-description`}>
                      {t(description)}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {importing && (
              <label className="field">
                <span>{t("projectArchive")}</span>
                <input
                  type="file"
                  name="project-archive"
                  accept=".zip,application/zip"
                  required
                  disabled={pending}
                  onChange={(event) => {
                    setArchive(event.target.files?.[0] || null);
                    setError("");
                  }}
                />
              </label>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
          </div>
        )}
        <footer>
          {warnings ? (
            <button ref={done} className="button primary">
              {t("openImportedProject")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={onClose}
              >
                {t("cancel")}
              </button>
              <button
                className="button primary"
                disabled={pending || (importing ? !archive : !name.trim())}
              >
                {pending && <Loader2 className="spin" size={16} />}
                {t(
                  pending
                    ? importing
                      ? "importingProject"
                      : "creatingProject"
                    : importing
                      ? "importProject"
                      : "create",
                )}
              </button>
            </>
          )}
        </footer>
      </form>
    </Modal>
  );
}
