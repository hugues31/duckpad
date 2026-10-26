import { Boxes } from "lucide-react";
import DuckMark from "./DuckMark";
import { useT } from "./i18n";
import {
  EditorModal,
  FileModal,
  FormModal,
  Modal,
  type FormField,
} from "./modals";
import type { Json, Snapshot } from "./types";

/** Every dialog of the workspace, with the actions it triggers. */
export type ModalState =
  | {
      kind: "form";
      title: string;
      fields: FormField[];
      description?: string;
      submit: (values: Json) => Promise<void>;
    }
  | {
      kind: "editor";
      title: string;
      value: string;
      description?: string;
      language?: string;
      readOnly?: boolean;
      save?: (text: string) => Promise<void>;
    }
  | {
      kind: "files";
      snapshot: Snapshot;
      title?: string;
      description?: string;
      initialFiles?: Record<string, string>;
      save: (files: Record<string, string>) => Promise<void>;
    }
  | {
      kind: "conflict";
      conflict: Json;
      choose: (choice: "current" | "proposal") => void;
      combine: () => void;
    }
  | { kind: "library"; items: Json[]; importItem: (item: Json) => void }
  | { kind: "about"; version: string; duckdb: string };

export default function ModalHost({
  modal,
  onClose,
}: {
  modal: ModalState | null;
  onClose: () => void;
}) {
  const t = useT();
  switch (modal?.kind) {
    case "form":
      return (
        <FormModal
          title={modal.title}
          fields={modal.fields}
          description={modal.description}
          onSubmit={modal.submit}
          onClose={onClose}
        />
      );
    case "editor":
      return (
        <EditorModal
          title={modal.title}
          description={modal.description}
          value={modal.value}
          language={modal.language}
          readOnly={modal.readOnly}
          onSave={modal.save}
          onClose={onClose}
        />
      );
    case "files":
      return (
        <FileModal
          title={modal.title}
          description={modal.description}
          snapshot={modal.snapshot}
          initialFiles={modal.initialFiles}
          onSave={modal.save}
          onClose={onClose}
        />
      );
    case "conflict":
      return (
        <Modal title={t("conflict")} onClose={onClose} wide>
          <div className="modal-content">
            <p>{t("conflictHint")}</p>
            <pre className="expression">{modal.conflict.paths.join("\n")}</pre>
            <div className="conflict-comparison">
              <div>
                <h4>{t("keepCurrent")}</h4>
                <pre>{JSON.stringify(modal.conflict.current, null, 2)}</pre>
              </div>
              <div>
                <h4>{t("keepProposal")}</h4>
                <pre>{JSON.stringify(modal.conflict.proposal, null, 2)}</pre>
              </div>
            </div>
          </div>
          <footer>
            <button className="button secondary" onClick={modal.combine}>
              {t("combined")}
            </button>
            {(["current", "proposal"] as const).map((choice) => (
              <button
                key={choice}
                className={`button ${choice === "proposal" ? "primary" : "secondary"}`}
                onClick={() => modal.choose(choice)}
              >
                {t(choice === "current" ? "keepCurrent" : "keepProposal")}
              </button>
            ))}
          </footer>
        </Modal>
      );
    case "library":
      return (
        <Modal title={t("library")} onClose={onClose} wide>
          <div className="modal-content">
            <p className="muted">{t("importHint")}</p>
            {!modal.items.length && <p>{t("emptyLibrary")}</p>}
            {modal.items.map((item) => (
              <div
                className="history-row"
                key={item.project + item.kind + item.id}
              >
                <Boxes size={18} />
                <span className="grow">
                  <strong>{item.name}</strong>
                  <small>
                    {item.project_name} · {item.kind}
                  </small>
                </span>
                <button
                  className="button secondary small"
                  onClick={() => modal.importItem(item)}
                >
                  {t("import")}
                </button>
              </div>
            ))}
          </div>
        </Modal>
      );
    case "about":
      return (
        <Modal title="Duckpad" onClose={onClose}>
          <div className="modal-content">
            <DuckMark size={48} />
            <p>{t("aboutText")}</p>
            <code>
              DuckDB {modal.duckdb} · Duckpad {modal.version}
            </code>
          </div>
        </Modal>
      );
    default:
      return null;
  }
}
