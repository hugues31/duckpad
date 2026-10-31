const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** A date relative to now, such as "5 minutes ago", in the given language. */
export function relativeTime(date: string, language: string, now = Date.now()) {
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const seconds = (new Date(date).getTime() - now) / 1000;
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) || [
    "second",
    0,
  ];
  // Under a minute reads as "now" rather than a count of seconds.
  return format.format(size ? Math.round(seconds / size) : 0, unit);
}
