import { createElement, type ComponentProps } from "react";

/** Native selection with a truncatable label in customizable-select browsers. */
export default function Select({
  children,
  onKeyDown,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      {...props}
      onKeyDown={(event) => {
        // Escape dismisses the picker before an enclosing dialog.
        if (
          event.key === "Escape" &&
          CSS.supports("appearance", "base-select") &&
          event.currentTarget.matches(":open")
        ) {
          event.stopPropagation();
        }
        onKeyDown?.(event);
      }}
    >
      {!props.multiple && props.size === undefined && (
        <button type="button" className="select-trigger">
          {/* React's DOM types do not yet include selectedcontent. */}
          {createElement("selectedcontent", { className: "select-value" })}
        </button>
      )}
      {children}
    </select>
  );
}
