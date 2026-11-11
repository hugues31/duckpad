import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartRows, ROW_ID } from "./chartValues";

/** The values a chart reads from one preview row of `columns`. */
const convert = (type: string, ...values: unknown[]) =>
  chartRows(
    [{ name: "value", type }],
    values.map((value, id) => ({ id, values: [value as never] })),
  ).map((row) => row.value);

/** The local calendar and clock fields of a chart value. */
const local = (value: unknown) => {
  const date = value as Date;
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
};

describe("in a time zone west of UTC", () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("keeps a DATE on its day, at local midnight", () => {
    expect(new Date(2024, 0, 1).getTimezoneOffset()).toBe(480);
    const [first, leap, early] = convert(
      "DATE",
      "2024-01-01",
      "2024-02-29",
      "0042-07-14",
    );
    expect(local(first)).toEqual([2024, 1, 1, 0, 0, 0, 0]);
    expect(local(leap)).toEqual([2024, 2, 29, 0, 0, 0, 0]);
    expect(local(early)).toEqual([42, 7, 14, 0, 0, 0, 0]);
  });

  it("keeps the wall-clock time of a TIMESTAMP, whatever its precision", () => {
    expect(
      convert("TIMESTAMP", "2024-03-10T09:30:15.123456").map(local),
    ).toEqual([[2024, 3, 10, 9, 30, 15, 123]]);
    expect(convert("TIMESTAMP_S", "2024-11-03T23:59:59").map(local)).toEqual([
      [2024, 11, 3, 23, 59, 59, 0],
    ]);
    expect(convert("TIMESTAMP_MS", "2024-06-01T00:00:00.5").map(local)).toEqual(
      [[2024, 6, 1, 0, 0, 0, 500]],
    );
  });

  it("turns a TIMESTAMP WITH TIME ZONE into its instant", () => {
    const [utc, paris, india] = convert(
      "TIMESTAMP WITH TIME ZONE",
      "2024-01-15T12:00:00+00:00",
      "2024-01-15T13:00:00.250000+01:00",
      "2024-01-15T17:30:00+05:30",
    ) as Date[];
    expect(utc.getTime()).toBe(Date.UTC(2024, 0, 15, 12));
    expect(paris.getTime()).toBe(Date.UTC(2024, 0, 15, 12, 0, 0, 250));
    expect(india.getTime()).toBe(Date.UTC(2024, 0, 15, 12));
    // Shown in the viewer's time zone.
    expect(local(utc)).toEqual([2024, 1, 15, 4, 0, 0, 0]);
  });
});

it("turns integer, floating point, DECIMAL and HUGEINT values into numbers", () => {
  expect(convert("INTEGER", 7, null)).toEqual([7, null]);
  // HUGEINT already arrives as a JSON number; only DECIMAL arrives as a string.
  expect(convert("HUGEINT", 1e30)).toEqual([1e30]);
  expect(convert("UTINYINT", "255")).toEqual([255]);
  expect(convert("DECIMAL(18,2)", "1250.50", "-0.01")).toEqual([1250.5, -0.01]);
  expect(convert("DOUBLE", 0.5, "nan", "inf", "-inf")).toEqual([
    0.5,
    null,
    null,
    null,
  ]);
  expect(convert("FLOAT", "nan")).toEqual([null]);
});

it("keeps booleans and turns every other type into a string", () => {
  expect(convert("BOOLEAN", true, false, null)).toEqual([true, false, null]);
  expect(convert("VARCHAR", "007", null)).toEqual(["007", null]);
  expect(convert("TIME", "10:30:00")).toEqual(["10:30:00"]);
  // A list of numbers or dates is not a number or a date.
  expect(convert("INTEGER[]", [1, 2])).toEqual(["[1,2]"]);
  expect(convert("DATE[]", ["2024-01-01"])).toEqual(['["2024-01-01"]']);
  expect(convert("STRUCT(a INTEGER)", { a: 1 })).toEqual(['{"a":1}']);
});

it("keys values by column name and keeps each row's preview id", () => {
  const columns = [
    { name: "region", type: "VARCHAR" },
    { name: "revenue", type: "DECIMAL(18,2)" },
  ];
  const rows = chartRows(columns, [
    { id: 4, values: ["North", "1250.50"] },
    { id: 9, values: ["South", "12"] },
  ]);
  expect(rows).toEqual([
    { region: "North", revenue: 1250.5 },
    { region: "South", revenue: 12 },
  ]);
  expect(rows.map((row) => row[ROW_ID])).toEqual([4, 9]);
  // The id stays out of the columns a chart can encode.
  expect(Object.keys(rows[0])).toEqual(["region", "revenue"]);
});
