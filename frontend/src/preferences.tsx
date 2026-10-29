import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useT, type Language } from "./i18n";
import type { Theme } from "./types";

const LANGUAGE_KEY = "duckpad-language";
const THEME_KEY = "duckpad-theme";
const LANGUAGES: readonly Language[] = ["en", "fr"];
const isLanguage = (value: string | null): value is Language =>
  LANGUAGES.includes(value as Language);

/** The first supported browser language, with English as the fallback. */
function browserLanguage(): Language {
  const locales = navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const locale of locales) {
    const candidate = locale.toLowerCase().split("-")[0];
    if (isLanguage(candidate)) return candidate;
  }
  return "en";
}

const systemTheme = (): Theme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export interface Preferences {
  language: Language;
  setLanguage: (value: Language) => void;
  theme: Theme;
  setTheme: (value: Theme) => void;
}

/** Language and theme follow the browser until the user picks one; choices are saved per browser. */
export function usePreferences(): Preferences {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    return isLanguage(saved) ? saved : browserLanguage();
  });
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : systemTheme();
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language;
  }, [theme, language]);
  const setLanguage = useCallback((value: Language) => {
    localStorage.setItem(LANGUAGE_KEY, value);
    setLanguageState(value);
  }, []);
  const setTheme = useCallback((value: Theme) => {
    localStorage.setItem(THEME_KEY, value);
    setThemeState(value);
  }, []);
  return { language, setLanguage, theme, setTheme };
}

/** Compact theme and language toggles, shown on the login and settings pages. */
export function PreferenceButtons({
  preferences: { language, setLanguage, theme, setTheme },
}: {
  preferences: Preferences;
}) {
  const t = useT();
  const nextTheme = theme === "light" ? "dark" : "light";
  return (
    <>
      <button
        className="icon"
        title={t(nextTheme)}
        onClick={() => setTheme(nextTheme)}
      >
        {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button
        className="language-button"
        title={t("language")}
        onClick={() => setLanguage(language === "en" ? "fr" : "en")}
      >
        {language.toUpperCase()}
      </button>
    </>
  );
}
