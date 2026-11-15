import type { Translate } from "./i18n";
import type { Parameter } from "./types";

/** The type and bounds a Python node declares for a number parameter. */
export type NumberLimits = Pick<
  Parameter,
  "python_type" | "ge" | "gt" | "le" | "lt"
>;

const BOUNDS: [
  "ge" | "gt" | "le" | "lt",
  string,
  (value: number, limit: number) => boolean,
][] = [
  ["ge", "≥", (value, limit) => value >= limit],
  ["gt", ">", (value, limit) => value > limit],
  ["le", "≤", (value, limit) => value <= limit],
  ["lt", "<", (value, limit) => value < limit],
];

/** The declared bounds, such as `≥ 0` and `≤ 10`. */
export const numberBounds = (limits: NumberLimits) =>
  BOUNDS.filter(([key]) => limits[key] !== undefined).map(
    ([key, symbol]) => `${symbol} ${limits[key]}`,
  );

/** Why a number does not fit its parameter, or an empty string when it does. */
export function numberBoundsError(
  value: number,
  limits: NumberLimits,
  t: Translate,
) {
  if (limits.python_type === "int" && !Number.isInteger(value))
    return t("invalidInteger");
  const outside = BOUNDS.some(([key, , holds]) => {
    const limit = limits[key];
    return limit !== undefined && !holds(value, limit);
  });
  return outside
    ? t("invalidNumberBounds").replace(
        "{bounds}",
        numberBounds(limits).join(", "),
      )
    : "";
}
