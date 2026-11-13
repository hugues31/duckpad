import type { Column, Json } from "./types";

/** A value as a chart plots it. */
export type ChartValue = number | string | boolean | Date | null;

/** The key of a chart row's preview row id, kept for click-to-explain on marks. */
export const ROW_ID = Symbol("row id");

/** One row as a chart reads it: values by column name, its preview row id under `ROW_ID`. */
export type ChartRow = Record<string, ChartValue> & { [ROW_ID]: number };

// Column types as DuckDB describes them; a list or struct of these is "anything else".
const NUMBER =
  /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL(\(\d+,\s*\d+\))?|BIGNUM|VARINT)$/i;
const TIMESTAMP = /^TIMESTAMP(_S|_MS|_NS)?$/i;
const TIMESTAMP_TZ = /^(TIMESTAMP WITH TIME ZONE|TIMESTAMPTZ)$/i;

// ISO dates and times as the preview writes them, with up to nanoseconds and an optional offset.
const DATE_TIME =
  /^(\d{4,})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?(?:(Z)|([+-])(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?)?$/;

/**
 * A preview date, timestamp or instant as a `Date`: dates and timestamps read
 * as local wall-clock time, values with an offset (`zoned`) as that instant.
 * Vega would read a bare date as UTC midnight, a day early west of UTC.
 */
function dateValue(text: string, zoned: boolean): Date | null {
  const match = DATE_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hours, minutes, seconds] = match
    .slice(1, 7)
    .map((part) => Number(part ?? 0));
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const date = new Date(0);
  if (!zoned) {
    // `Date(year, …)` would read years below 100 as 19xx.
    date.setFullYear(year, month - 1, day);
    date.setHours(hours, minutes, seconds, milliseconds);
    return date;
  }
  if (!match[8] && !match[9]) return null;
  const offset = match[9]
    ? (match[9] === "-" ? -1 : 1) *
      (Number(match[10]) * 3600 +
        Number(match[11]) * 60 +
        Number(match[12] ?? 0))
    : 0;
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds - offset, milliseconds);
  return date;
}

/**
 * A preview value as a chart plots it, by column type. Preview values are
 * JSON-safe: DECIMAL arrives as a string, non-finite floats as `"inf"` or
 * `"nan"`, dates and timestamps as ISO text.
 */
function chartValue(value: Json, type: string): ChartValue {
  if (value === null) return null;
  if (NUMBER.test(type)) {
    const number = typeof value === "string" ? Number(value) : value;
    return typeof number === "number" && Number.isFinite(number)
      ? number
      : null;
  }
  if (/^DATE$/i.test(type) || TIMESTAMP.test(type))
    return typeof value === "string" ? dateValue(value, false) : null;
  if (TIMESTAMP_TZ.test(type))
    return typeof value === "string" ? dateValue(value, true) : null;
  if (/^BOOLEAN$/i.test(type)) return typeof value === "boolean" ? value : null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Preview rows converted by column type, keyed by column name, keeping their row ids. */
export function chartRows(
  columns: Column[],
  rows: { id: number; values: Json[] }[],
): ChartRow[] {
  return rows.map((row) => {
    const values = Object.fromEntries(
      columns.map((column, index) => [
        column.name,
        chartValue(row.values[index] ?? null, column.type),
      ]),
    );
    // Not enumerable: a chart cannot encode it, and Vega keeps the object as the mark's datum.
    return Object.defineProperty(values, ROW_ID, { value: row.id }) as ChartRow;
  });
}
