import type { ActionItem } from "./ActionMenu";
import type { Translate } from "./i18n";
import { countLabel, isBuiltinTemplate } from "./i18n";
import { nodeCopies, type CopiedNodes } from "./nodeClipboard";
import { detachNode, nodeGraph, templateUsage } from "./nodeCode";
import type { useShell } from "./shell";
import type { Bundle, FlowNode, Snapshot } from "./types";
import type { useLoadedWorktree } from "./worktree";
export function nodeActions(
  target: FlowNode,
  {
    t,
    canEdit,
    busy,
    bundle,
    openComponent,
    editCode,
    prefix,
    safe,
    parent,
    paste,
    save,
    snapshot,
    openModal,
    worktree,
    removeNodes,
  }: {
    t: Translate;
    canEdit: boolean;
    busy: boolean;
    bundle: Bundle;
    openComponent: (id: string) => void;
    editCode: (line?: number, target?: string) => void;
    prefix: string;
    safe: (action: () => Promise<unknown>) => void;
    parent: string | undefined;
    paste: (copied: CopiedNodes, detach?: boolean) => Promise<void>;
    save: ReturnType<typeof useLoadedWorktree>["save"];
    snapshot: Snapshot;
    openModal: ReturnType<typeof useShell>["openModal"];
    worktree: string;
    removeNodes: (ids: string[]) => Promise<void>;
  },
): ActionItem[] {
  const item = (id: string, label: string, run: () => void): ActionItem => ({
    id,
    label,
    run,
    disabled: !canEdit || busy,
  });
  const actions = [
    item(
      "edit",
      target.component
        ? t("openComponent")
        : target.template
          ? countLabel(
              t,
              templateUsage(bundle, target.template),
              "editTemplateOne",
              "editTemplateCount",
            )
          : t("editNodeCode"),
      () =>
        target.component
          ? openComponent(target.id)
          : editCode(undefined, prefix + target.id),
    ),
  ];
  actions.push(
    item("duplicate", t("duplicateNode"), () =>
      safe(async () => {
        const copied = nodeCopies(bundle, parent, [target.id]);
        if (copied) await paste(copied, true);
      }),
    ),
  );

  if (!target.component) {
    if (target.template) {
      actions.push(
        item("detach", t("detachTemplate"), () =>
          safe(() =>
            save(snapshot, (value) =>
              detachNode(
                value,
                nodeGraph(value, parent).nodes.find((n) => n.id === target.id)!,
                parent,
              ),
            ),
          ),
        ),
      );
    } else {
      actions.push(
        item("convert", t("convertTemplate"), () =>
          openModal({
            kind: "convertNode",
            worktree,
            node: target.id,
            parent,
          }),
        ),
      );
      // Built-in templates are starting points: relinking would only drop the code.
      if (
        target.origin &&
        !isBuiltinTemplate(target.origin) &&
        bundle.templates[target.origin] !== undefined
      )
        actions.push(
          item("relink", t("relinkTemplate"), () =>
            openModal({
              kind: "relinkNode",
              worktree,
              node: target.id,
              parent,
            }),
          ),
        );
    }
  }
  actions.push({
    ...item("remove", t("deleteNode"), () =>
      safe(() => removeNodes([target.id])),
    ),
    danger: true,
  });
  return actions;
}
