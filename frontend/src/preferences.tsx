import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { languages, useT, type Language } from "./i18n";
import type { Theme } from "./types";

const LANGUAGE_KEY = "duckpad-language";
const THEME_KEY = "duckpad-theme";
const THEMES: readonly Theme[] = ["light", "dark"];
const isLanguage = (value: string | null): value is Language =>
  languages.includes(value as Language);
const isTheme = (value: string | null): value is Theme =>
  THEMES.includes(value as Theme);

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
    return isTheme(saved) ? saved : systemTheme();
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

/** A preference and its options, labelled in the interface language. */
export interface PreferenceChoice {
  name: "language" | "theme";
  label: string;
  value: string;
  options: { value: string; label: string }[];
  choose: (value: string) => void;
}

/** The language and theme choices that every preference control offers. */
export function usePreferenceChoices({
  language,
  setLanguage,
  theme,
  setTheme,
}: Preferences): PreferenceChoice[] {
  const t = useT();
  // Intl names each language in the interface language ("French", or "français"
  // in French); option labels start with a capital letter.
  const names = new Intl.DisplayNames([language], { type: "language" });
  const languageName = (value: Language) => {
    const name = names.of(value) ?? value;
    return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
  };
  return [
    {
      name: "language",
      label: t("language"),
      value: language,
      options: languages.map((value) => ({
        value,
        label: languageName(value),
      })),
      choose: (value) => setLanguage(value as Language),
    },
    {
      name: "theme",
      label: t("theme"),
      value: theme,
      options: THEMES.map((value) => ({ value, label: t(value) })),
      choose: (value) => setTheme(value as Theme),
    },
  ];
}

/** Compact theme and language toggles, shown on the login page. */
export function PreferenceButtons({
  preferences,
}: {
  preferences: Preferences;
}) {
  const [language, theme] = usePreferenceChoices(preferences);
  const next = ({ options, value }: PreferenceChoice) =>
    options[
      (options.findIndex((option) => option.value === value) + 1) %
        options.length
    ];
  const nextTheme = next(theme);
  return (
    <>
      <button
        className="icon"
        title={nextTheme.label}
        onClick={() => theme.choose(nextTheme.value)}
      >
        {theme.value === "light" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button
        className="language-button"
        title={language.label}
        onClick={() => language.choose(next(language).value)}
      >
        {language.value.toUpperCase()}
      </button>
    </>
  );
}
