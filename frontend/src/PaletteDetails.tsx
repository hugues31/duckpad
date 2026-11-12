import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { NodeIcon } from "./CanvasNode";
import type { NodeChoice } from "./graph";
import { templateLabel, useT } from "./i18n";
import { isWideLayout } from "./WorkspacePanels";

/** Read the definition's interface without creating or editing a graph node. */
export default function PaletteDetails({
  choice,
  focus,
  onClose,
  onAdd,
}: {
  choice: NodeChoice;
  /** Whether the keyboard opened the details, far from the palette in tab order. */
  focus: boolean;
  onClose: () => void;
  /** Adds an instance without a drag; absent when the project is read-only. */
  onAdd?: () => void;
}) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // On small screens the palette closes, so focus follows the visible panel.
    if (focus || !isWideLayout()) (add.current ?? close.current)?.focus();
  }, [focus]);
  const { signature, definition } = choice;
  const label =
    choice.kind === "component"
      ? choice.definition.name || choice.id
      : templateLabel(choice.id, choice.definition.label, t);
  return (
    <aside
      className="inspector palette-details"
      aria-label={t("nodeTypeDetails")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          // The canvas would otherwise also deselect its node.
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="inspector-title">
        <span className={`kind-icon ${signature.kind}`}>
          <NodeIcon
            kind={choice.kind === "component" ? "component" : choice.id}
            size={18}
          />
        </span>
        <span className="panel-heading">
          <span title={label}>{label}</span>
          <small className="muted">
            {t("nodeTypeDetails")} · {t(signature.kind)}
          </small>
        </span>
        <button
          ref={close}
          className="icon"
          title={t("close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {onAdd && (
        <div className="inspector-actions">
          <button ref={add} className="button primary small" onClick={onAdd}>
            <Plus size={15} aria-hidden="true" />
            {t("addToCanvas")}
          </button>
        </div>
      )}
      <div className="inspector-body">
        {choice.kind === "template" && choice.definition.error ? (
          <p className="notice error" role="alert">
            {choice.definition.error}
          </p>
        ) : null}
        <section aria-label={t("description")}>
          <h4>{t("description")}</h4>
          <p className="palette-description">
            {definition.description || t("noNodeDescription")}
          </p>
        </section>
        {(["inputs", "outputs"] as const).map((direction) => (
          <section key={direction} aria-label={t(direction)}>
            <h4>
              {t(direction)}{" "}
              <span className="counter">{signature[direction].length}</span>
            </h4>
            {signature[direction].length ? (
              <ul className="palette-ports">
                {signature[direction].map((port) => (
                  <li key={port}>
                    <code>{port}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                {t(direction === "inputs" ? "noNodeInputs" : "noNodeOutputs")}
              </p>
            )}
          </section>
        ))}
        <section aria-label={t("parameters")}>
          <h4>
            {t("parameters")}{" "}
            <span className="counter">{signature.parameters.length}</span>
          </h4>
          {signature.parameters.length ? (
            <dl className="palette-parameters">
              {signature.parameters.map((parameter) => (
                <div key={parameter.name}>
                  <dt>
                    <code>{parameter.name}</code>
                    <code className="muted">{parameter.type}</code>
                  </dt>
                  <dd>
                    {parameter.label && <strong>{parameter.label}</strong>}
                    {parameter.description && <p>{parameter.description}</p>}
                    <span className="muted">
                      {parameter.default === undefined
                        ? t("noDefault")
                        : t("defaultValue") + ": "}
                    </span>
                    {parameter.default !== undefined && (
                      <code>{JSON.stringify(parameter.default)}</code>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted small">{t("noNodeParameters")}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
