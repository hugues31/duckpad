import { createContext, useCallback, useContext } from "react";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import pt from "./locales/pt.json";

/** A key of the translation catalogs. */
export type TranslationKey = keyof typeof en;
// Every catalog defines every key.
const locales = { en, fr, pt } satisfies Record<
  string,
  Record<TranslationKey, string>
>;
export type Language = keyof typeof locales;
/** The interface languages, one per translation catalog. */
export const languages = Object.keys(locales) as Language[];
export const I18n = createContext<{
  language: Language;
  setLanguage: (l: Language) => void;
}>({ language: "en", setLanguage: () => {} });

export const useLanguage = () => useContext(I18n).language;

const isTranslationKey = (value: string): value is TranslationKey =>
  Object.hasOwn(en, value);

/** Translate a key of the catalogs. */
export function useT() {
  const language = useLanguage();
  return useCallback(
    (key: TranslationKey) => locales[language][key],
    [language],
  );
}
export type Translate = ReturnType<typeof useT>;

/** A `{count}` message in the singular for one item, in the plural otherwise. */
export function countLabel(
  t: Translate,
  value: number,
  one: TranslationKey,
  many: TranslationKey,
) {
  return t(value === 1 ? one : many).replace("{count}", value.toLocaleString());
}

/**
 * Translate a value known only at runtime, such as a status reported by the
 * server; values without a translation are shown as is.
 */
export function useTranslateValue() {
  const t = useT();
  return useCallback(
    (value: string) => (isTranslationKey(value) ? t(value) : value),
    [t],
  );
}

const builtinLabels = {
  load_csv: "Load CSV",
  load_parquet: "Load Parquet",
  load_xlsx: "Load XLSX",
  load_table: "Load table",
  join: "Join",
  filter: "Filter",
  aggregate: "Aggregate",
  select_columns: "Select columns",
  clean_values: "Clean values",
  export_csv: "Export CSV",
  export_xlsx: "Export XLSX",
  export_table: "Export table",
  export_oracle: "Export Oracle",
  sql: "SQL transform",
} satisfies Partial<Record<TranslationKey, string>>;
const isBuiltin = (id: string): id is keyof typeof builtinLabels =>
  Object.hasOwn(builtinLabels, id);

/** Built-in templates keep a translated label until their label is edited. */
export function templateLabel(
  id: string,
  label: string | undefined,
  t: Translate,
) {
  return isBuiltin(id) && label === builtinLabels[id] ? t(id) : label || id;
}
