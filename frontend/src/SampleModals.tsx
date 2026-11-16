import { useState } from "react";
import { useT } from "./i18n";
import { ModalForm } from "./modals";
import { templateUsage } from "./nodeCode";
import type { SaveProject } from "./results";
import {
  appendTest,
  sampleSql,
  suggestedTestName,
  TEST_NAME,
  testBlock,
  type Sample,
  type View,
} from "./samples";
import Select from "./Select";
import type { FlowNode, Snapshot } from "./types";

export function SaveViewModal({
  views,
  sample,
  onSave,
  onClose,
}: {
  views: View[];
  sample: Sample;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(sample.filter?.slice(0, 60) || "");
  const replaces = views.some((view) => view.name === name.trim());
  return (
    <ModalForm
      title={t("saveViewTitle")}
      onClose={onClose}
      submitLabel={t("saveView")}
      disabled={!name.trim()}
      onSubmit={() => onSave(name.trim())}
    >
      <p className="muted">{t("saveViewHint")}</p>
      <label className="field">
        <span>{t("viewName")}</span>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {replaces && <p className="muted small">{t("viewReplaced")}</p>}
      <pre className="expression">{sampleSql("output", sample)}</pre>
    </ModalForm>
  );
}

export function CreateTestModal({
  snapshot,
  node,
  parent,
  port,
  filter,
  tests,
  onSave,
  onClose,
  onEditCode,
}: {
  snapshot: Snapshot;
  node: FlowNode;
  parent?: string;
  port: string;
  filter: string;
  tests: string[];
  onSave: SaveProject;
  onClose: () => void;
  onEditCode: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(() => suggestedTestName(filter));
  const [severity, setSeverity] = useState<"warning" | "error">("warning");
  const [detach, setDetach] = useState(false);
  const linked = node.template
    ? templateUsage(snapshot.bundle!, node.template)
    : 0;
  const invalid = !TEST_NAME.test(name)
    ? t("testNameInvalid")
    : tests.includes(name)
      ? t("testNameTaken")
      : "";
  const block = testBlock(name, severity, port, filter);
  return (
    <ModalForm
      title={t("createTestTitle")}
      onClose={onClose}
      submitLabel={t("createTest")}
      disabled={!!invalid}
      actions={
        <>
          <button type="button" className="text-button" onClick={onEditCode}>
            {t("editNodeCode")}
          </button>
          <span className="spacer" />
        </>
      }
      onSubmit={() =>
        onSave((bundle) =>
          appendTest(bundle, node.id, parent, block, detach, t),
        )
      }
    >
      <p className="muted">{t("createTestHint")}</p>
      <label className="field">
        <span>{t("testName")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("testSeverity")}</span>
        <Select
          aria-label={t("testSeverity")}
          value={severity}
          onChange={(e) => setSeverity(e.target.value as "warning" | "error")}
        >
          <option value="warning">{t("messageWarning")}</option>
          <option value="error">{t("messageError")}</option>
        </Select>
      </label>
      <pre className="expression">{block}</pre>
      {node.template && (
        <div className="notice">
          <p>
            {t(linked === 1 ? "testTemplateOne" : "testTemplateCount").replace(
              "{count}",
              String(linked),
            )}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={detach}
              onChange={(e) => setDetach(e.target.checked)}
            />
            {t("testDetachFirst")}
          </label>
        </div>
      )}
      {invalid && name && <p className="notice error small">{invalid}</p>}
    </ModalForm>
  );
}
