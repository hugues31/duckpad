"""Cron schedules evaluated in an IANA time zone.

An expression has five fields: minute, hour, day of month, month and day of week (0 or 7 is
Sunday), or one of the macros `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. Fields
accept `*`, values, ranges, lists and steps, plus English month and day abbreviations. As in
Vixie cron, a day matches either restricted day field when both are restricted.

Occurrences are wall-clock times in the schedule's time zone. A time that a daylight-saving
change skips runs once, when the gap ends; a time repeated when clocks go back runs once, at its
first occurrence.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .util import Problem

MACROS = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
DAYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
FIELDS = (
    ("minute", 0, 59, ()),
    ("hour", 0, 23, ()),
    ("day of month", 1, 31, ()),
    ("month", 1, 12, MONTHS),
    ("day of week", 0, 7, DAYS),
)
# Every combination of month, day and weekday recurs within this period, leap days included.
SEARCH_DAYS = 366 * 8 + 2
MAX_EXPRESSION = 200


def zone(name: str) -> ZoneInfo:
    if not isinstance(name, str) or not name or len(name) > 64 or name.startswith("/") or ".." in name:
        raise Problem(f"Unknown time zone {name!r}", 422)
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise Problem(f"Unknown time zone {name!r}", 422) from error


def parse_value(text: str, name: str, names: tuple[str, ...]) -> int:
    lowered = text.lower()
    if lowered in names:
        return names.index(lowered) + (1 if name == "month" else 0)
    if not text.isdigit():
        raise Problem(f"Invalid {name} value {text!r}", 422)
    return int(text)


def parse_field(text: str, name: str, low: int, high: int, names: tuple[str, ...]) -> set[int]:
    values: set[int] = set()
    for part in text.split(","):
        base, slash, step_text = part.partition("/")
        step = 1
        if slash:
            if not step_text.isdigit() or int(step_text) == 0:
                raise Problem(f"Invalid {name} step in {part!r}", 422)
            step = int(step_text)
        if base == "*":
            start, end = low, high
        elif "-" in base:
            first, _, last = base.partition("-")
            start, end = parse_value(first, name, names), parse_value(last, name, names)
        else:
            start = parse_value(base, name, names)
            end = high if slash else start
        if not low <= start <= high or not low <= end <= high:
            raise Problem(f"The {name} field accepts {low} to {high}, not {part!r}", 422)
        if start > end:
            raise Problem(f"Invalid {name} range {part!r}", 422)
        values.update(range(start, end + 1, step))
    return values


@dataclass(frozen=True)
class Schedule:
    expression: str
    timezone: str
    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    any_day: bool
    any_weekday: bool

    @classmethod
    def parse(cls, expression: str, timezone: str) -> Schedule:
        if not isinstance(expression, str) or not expression.strip() or len(expression) > MAX_EXPRESSION:
            raise Problem("Enter a cron expression", 422)
        text = MACROS.get(expression.strip().lower(), expression)
        parts = text.split()
        if len(parts) != 5:
            raise Problem(
                "A cron expression has five fields: minute, hour, day of month, month and day of week", 422
            )
        minutes, hours, days, months, weekdays = (
            parse_field(part, *field) for part, field in zip(parts, FIELDS, strict=True)
        )
        zone(timezone)
        schedule = cls(
            expression.strip(),
            timezone,
            tuple(sorted(minutes)),
            tuple(sorted(hours)),
            frozenset(days),
            frozenset(months),
            frozenset(day % 7 for day in weekdays),
            parts[2].startswith("*"),
            parts[4].startswith("*"),
        )
        if schedule.next_after(datetime.now(UTC)) is None:
            raise Problem(f"The schedule {expression.strip()!r} never occurs", 422)
        return schedule

    def matches(self, day: date) -> bool:
        if day.month not in self.months:
            return False
        in_month = day.day in self.days
        in_week = day.isoweekday() % 7 in self.weekdays
        if self.any_day or self.any_weekday:
            return in_month and in_week
        return in_month or in_week

    def instant(self, wall: datetime) -> datetime:
        """The UTC instant of a local wall-clock time, following the daylight-saving rules above."""
        tz = zone(self.timezone)
        first = wall.replace(tzinfo=tz, fold=0).astimezone(UTC)
        if first.astimezone(tz).replace(tzinfo=None) == wall:
            return first
        # Skipped: the two offsets bracket the transition, which ends the gap.
        moment = min(first, wall.replace(tzinfo=tz, fold=1).astimezone(UTC))
        while moment.astimezone(tz).replace(tzinfo=None) < wall:
            moment += timedelta(minutes=1)
        return moment

    def next_after(self, after: datetime) -> datetime | None:
        """The first occurrence strictly after an aware instant, or None if there is none."""
        day = after.astimezone(zone(self.timezone)).date()
        for _ in range(SEARCH_DAYS):
            if self.matches(day):
                for hour in self.hours:
                    for minute in self.minutes:
                        occurrence = self.instant(datetime(day.year, day.month, day.day, hour, minute))
                        # Instants never decrease in wall-clock order, so the first later one is next.
                        if occurrence > after:
                            return occurrence
            day += timedelta(days=1)
        return None

    def between(self, start: datetime, end: datetime, limit: int = 1000) -> list[datetime]:
        """Occurrences in [start, end), at most `limit`."""
        result: list[datetime] = []
        current = self.next_after(start - timedelta(microseconds=1))
        while current is not None and current < end and len(result) < limit:
            result.append(current)
            current = self.next_after(current)
        return result


def iso(instant: datetime) -> str:
    return instant.astimezone(UTC).isoformat()


def parse_instant(text: str) -> datetime:
    return datetime.fromisoformat(text).astimezone(UTC)
