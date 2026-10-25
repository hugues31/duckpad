import { createContext, useContext, useCallback } from "react";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
export type Language = "en" | "fr";
export const I18n = createContext<{
  language: Language;
  setLanguage: (l: Language) => void;
}>({ language: "en", setLanguage: () => {} });
export function useT() {
  const { language } = useContext(I18n);
  return useCallback(
    (key: string): string =>
      (language === "fr" ? fr : en)[key as keyof typeof en] ?? key,
    [language],
  );
}

const builtinLabels: Record<string, string> = {
  load_csv: "Load CSV",
  load_parquet: "Load Parquet",
  load_oracle: "Load Oracle",
  join: "Join",
  filter: "Filter",
  aggregate: "Aggregate",
  export_csv: "Export CSV",
  export_oracle: "Export Oracle",
  sql: "SQL transform",
};
export function templateLabel(
  id: string,
  label: string | undefined,
  t: (key: string) => string,
) {
  return label === builtinLabels[id] ? t(id) : label || id;
}
