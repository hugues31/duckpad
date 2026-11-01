import { useState } from "react";
import { identifier } from "./graph";
import { useT } from "./i18n";
import { ConfirmModal } from "./modals";
import { linkNode, nodeCode, nodeGraph } from "./nodeCode";
import type { Snapshot } from "./types";
import { useWorktree } from "./worktree";

export default function ConvertNodeDialog({
  snapshot,
  node,
  parent,
  relink,
  onClose,
}: {
  snapshot: Snapshot;
  node: string;
  parent?: string;
  relink: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { save } = useWorktree();
  const [name, setName] = useState("");
  return (
    <ConfirmModal
      title={t(relink ? "relinkTemplate" : "convertTemplate")}
      confirmLabel={t(relink ? "relinkTemplate" : "convertTemplate")}
      onClose={onClose}
      onConfirm={async () => {
        if (!relink && !name.trim()) throw new Error(t("templateNameRequired"));
        await save(snapshot, (bundle) => {
          const target = nodeGraph(bundle, parent).nodes.find(
            (n) => n.id === node,
          )!;
          if (relink) {
            if (!target.origin || bundle.templates[target.origin] === undefined)
              throw new Error(t("searchTargetMissing"));
            linkNode(bundle, target, target.origin, parent);
          } else {
            const id = identifier("template");
            // Labels are descriptive directives; changing one leaves execution fingerprints intact.
            const sql = nodeCode(bundle, target, parent).replace(
              /^[\t ]*--[\t ]*@label\b[^\n]*(?:\n|$)/gm,
              "",
            );
            bundle.templates[id] =
              `-- @label ${name.trim().replace(/[\r\n]/g, " ")}\n${sql}`;
            linkNode(bundle, target, id, parent);
          }
        });
      }}
    >
      {relink ? (
        <p>{t("relinkTemplateHint")}</p>
      ) : (
        <label className="field">
          <span>{t("templateName")}</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
    </ConfirmModal>
  );
}
