import type { Translate } from "./i18n";
import type { Json } from "./types";

/** SQL list types; variables expose only the text and number variants. */
export const listItemType = (type: string) =>
  type.match(/^\s*list\s*<\s*(text|number|boolean|column)\s*>\s*$/)?.[1];

/** Comma-separated items; invalid ones stay text so validation can reject them. */
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

/** An item as its input shows it. */
export const listItemText = (item: Json) =>
  typeof item === "string" ? item : JSON.stringify(item);

/** Whether a list item has the type its list declares. */
export function validListItem(type: string, item: Json) {
  const itemType = listItemType(type);
  return itemType === "number"
    ? typeof item === "number" && Number.isFinite(item)
    : itemType === "boolean"
      ? typeof item === "boolean"
      : true;
}

/** Shared by the input and autosave, which must also reject invalid drafts. */
export function listInputError(
  type: string,
  value: Json | undefined,
  t: Translate,
) {
  if (!Array.isArray(value)) return "";
  const invalid = value.find((item) => !validListItem(type, item));
  return invalid === undefined
    ? ""
    : t(
        listItemType(type) === "number"
          ? "invalidListNumber"
          : "invalidListBoolean",
      ).replace("{item}", listItemText(invalid));
}
