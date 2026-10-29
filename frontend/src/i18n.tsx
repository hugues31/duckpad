import { createContext, useCallback, useContext } from "react";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

export type Language = "en" | "fr";
export const I18n = createContext<{
  language: Language;
  setLanguage: (l: Language) => void;
}>({ language: "en", setLanguage: () => {} });

export const useLanguage = () => useContext(I18n).language;

/** Translate a key; unknown keys, such as server-provided status values, are shown as is. */
export function useT() {
  const language = useLanguage();
  return useCallback(
    (key: string): string =>
      (language === "fr" ? fr : en)[key as keyof typeof en] ?? key,
    [language],
  );
}

const builtinLabels: Record<string, string> = {
  load_csv: "Load CSV",
  load_parquet: "Load Parquet",
  load_xlsx: "Load XLSX",
  load_oracle: "Load Oracle",
  join: "Join",
  filter: "Filter",
  aggregate: "Aggregate",
  select_columns: "Select columns",
  clean_values: "Clean values",
  export_csv: "Export CSV",
  export_xlsx: "Export XLSX",
  export_oracle: "Export Oracle",
  sql: "SQL transform",
};

/** Built-in templates keep a translated label until their label is edited. */
export function templateLabel(
  id: string,
  label: string | undefined,
  t: (key: string) => string,
) {
  return label === builtinLabels[id] ? t(id) : label || id;
}
