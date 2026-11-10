import { describe, expect, it } from "vitest";
import { roundDecimals } from "./results";

describe("roundDecimals", () => {
  it("rounds long decimals to two places", () => {
    expect(roundDecimals("262.1176470588235")).toBe("262.12");
    expect(roundDecimals("-262.1176470588235")).toBe("-262.12");
    expect(roundDecimals("0.30000000000000004")).toBe("0.3");
    expect(roundDecimals("12.3000")).toBe("12.3");
    expect(roundDecimals("4.995")).toBe("5");
    expect(roundDecimals("99.999")).toBe("100");
  });

  it("keeps values with two decimals or fewer, dates and other text", () => {
    for (const value of [
      "31",
      "12.30",
      "1.5",
      "-0.001",
      "1234567800000000.0",
      "1e-07",
      "nan",
      "-inf",
      "2026-10-01",
      "2024-01-01 12:00:00.123456",
    ])
      expect(roundDecimals(value)).toBe(value);
  });

  it("keeps two significant digits below one", () => {
    expect(roundDecimals("0.123456")).toBe("0.12");
    expect(roundDecimals("0.0123456")).toBe("0.012");
    expect(roundDecimals("0.000123456")).toBe("0.00012");
    expect(roundDecimals("-0.000999")).toBe("-0.001");
    expect(roundDecimals("0.0000")).toBe("0");
  });

  it("keeps every digit of large decimals", () => {
    expect(roundDecimals("12345678901234567890.123456")).toBe(
      "12345678901234567890.12",
    );
  });

  it("rounds the mantissa of scientific notation", () => {
    expect(roundDecimals("1.2345678e+20")).toBe("1.23e+20");
    expect(roundDecimals("-3.14159e-07")).toBe("-3.14e-07");
    expect(roundDecimals("9.999e+20")).toBe("1e+21");
  });
});
