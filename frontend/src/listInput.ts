import type { Translate } from "./i18n";
import type { Json } from "./types";

/** SQL list types; variables expose only the text and number variants. */
export const listItemType = (type: string) =>
  type.match(/^\s*list\s*<\s*(text|number|boolean|column)\s*>\s*$/)?.[1];

/** Preserve invalid items so form validation can reject the whole draft. */
export function parseListInput(type: string, text: string) {
  const itemType = listItemType(type);
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      if (itemType === "number" && Number.isFinite(Number(item)))
        return Number(item);
      if (itemType === "boolean" && /^(true|false)$/i.test(item))
        return item.toLowerCase() === "true";
      return item;
    });
}

/** Shared by the input and autosave, which must also reject invalid drafts. */
export function listInputError(
  type: string,
  value: Json | undefined,
  t: Translate,
) {
  const itemType = listItemType(type);
  if (!Array.isArray(value) || !["number", "boolean"].includes(itemType || ""))
    return "";
  const index = value.findIndex((item) =>
    itemType === "number"
      ? typeof item !== "number" || !Number.isFinite(item)
      : typeof item !== "boolean",
  );
  return index === -1
    ? ""
    : t(
        itemType === "number" ? "invalidListNumber" : "invalidListBoolean",
      ).replace("{index}", String(index + 1));
}
