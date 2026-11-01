import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const now = Date.parse("2026-10-31T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("reads under a minute as now", () => {
    expect(relativeTime(ago(40), "en", now)).toBe("now");
    expect(relativeTime(ago(-5), "fr", now)).toBe("maintenant");
  });

  it("uses the largest whole unit", () => {
    expect(relativeTime(ago(5 * 60), "en", now)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3600 + 600), "en", now)).toBe("3 hours ago");
    expect(relativeTime(ago(24 * 3600), "en", now)).toBe("yesterday");
    expect(relativeTime(ago(3 * 24 * 3600), "fr", now)).toBe("il y a 3 jours");
    expect(relativeTime(ago(14 * 24 * 3600), "pt", now)).toBe("há 2 semanas");
    expect(relativeTime(ago(400 * 24 * 3600), "en", now)).toBe("last year");
  });
});
