import {
  Ban,
  Boxes,
  Code2,
  Copy,
  Link,
  Trash2,
  Undo2,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import type { ActionItem } from "./ActionMenu";
import type { Translate } from "./i18n";
import { countLabel, isBuiltinTemplate } from "./i18n";
import { nodeCopies, type CopiedNodes } from "./nodeClipboard";
import { canMute, detachNode, nodeGraph, templateUsage } from "./nodeCode";
import type { useShell } from "./shell";
import type { Bundle, FlowNode, Snapshot } from "./types";
import type { useLoadedWorktree } from "./worktree";
/** A node command, shown with its icon in the inspector and the canvas menu. */
export type NodeAction = ActionItem & {
  icon: LucideIcon;
  /** A toggle that is currently on. */
  active?: boolean;
};

export function nodeActions(
  target: FlowNode,
  {
    t,
    canEdit,
    busy,
    bundle,
    open,
    safe,
    parent,
    paste,
    save,
    snapshot,
    openModal,
    worktree,
    removeNodes,
    toggleMute,
  }: {
    t: Translate;
    canEdit: boolean;
    busy: boolean;
    bundle: Bundle;
    open: (target: FlowNode) => void;
    safe: (action: () => Promise<unknown>) => void;
    parent: string | undefined;
    paste: (copied: CopiedNodes, detach?: boolean) => Promise<void>;
    save: ReturnType<typeof useLoadedWorktree>["save"];
    snapshot: Snapshot;
    openModal: ReturnType<typeof useShell>["openModal"];
    worktree: string;
    removeNodes: (ids: string[]) => Promise<void>;
    toggleMute: (ids: string[]) => Promise<void>;
  },
): NodeAction[] {
  const item = (
    id: string,
    icon: LucideIcon,
    label: string,
    run: () => void,
  ): NodeAction => ({ id, icon, label, run, disabled: !canEdit || busy });
  // The inspector shows the first action as its main button.
  const actions = [
    item(
      "edit",
      target.component ? Boxes : Code2,
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
      () => open(target),
    ),
  ];
  actions.push(
    {
      ...item("mute", Ban, t(target.muted ? "unmuteNode" : "muteNode"), () =>
        safe(() => toggleMute([target.id])),
      ),
      active: !!target.muted,
      disabled: !canEdit || busy || !canMute(snapshot, target, parent),
    },
    item("duplicate", Copy, t("duplicateNode"), () =>
      safe(async () => {
        const copied = nodeCopies(bundle, parent, [target.id]);
        if (copied) await paste(copied, true);
      }),
    ),
  );

  if (!target.component) {
    if (target.template) {
      actions.push(
        item("detach", Unlink, t("detachTemplate"), () =>
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
        item("convert", Link, t("convertTemplate"), () =>
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
          item("relink", Undo2, t("relinkTemplate"), () =>
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
    ...item("remove", Trash2, t("deleteNode"), () =>
      safe(() => removeNodes([target.id])),
    ),
    danger: true,
  });
  return actions;
}
