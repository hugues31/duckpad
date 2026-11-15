import { useMemo, useSyncExternalStore } from "react";
import type { Config } from "vega-lite";
import { themeConfig, type ChartAppearance } from "./chartEmbed";
import { useLanguage } from "./i18n";

const root = () => document.documentElement;

/** Follow the `data-theme` attribute that the theme preference sets on the root. */
function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(root(), { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The chart config of each theme, read from its CSS variables once it applies. */
const configs = new Map<string | undefined, Config>();
function configOf(theme: string | undefined) {
  let config = configs.get(theme);
  if (!config)
    configs.set(theme, (config = themeConfig(getComputedStyle(root()))));
  return config;
}

/**
 * The interface language and a chart config built from the theme's CSS
 * variables, rebuilt when the theme switches between light and dark.
 */
export function useChartAppearance(): ChartAppearance {
  const language = useLanguage();
  const theme = useSyncExternalStore(subscribe, () => root().dataset.theme);
  return useMemo(
    () => ({ language, config: configOf(theme) }),
    [language, theme],
  );
}
