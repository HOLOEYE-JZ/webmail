import { format, parseISO } from "date-fns";

/**
 * Dates as tasks, follow-ups and their forms write and read them. A *day* is
 * a display date at midnight (lib/timezone.ts), written "yyyy-MM-dd".
 */

/** A UTCDateTime without fractional seconds (RFC 8620 §1.4). */
export function utcDateTime(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** An ISO 8601 date or date-time as a Date; null for anything else. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = parseISO(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A day as "yyyy-MM-dd". */
export function isoDay(day: Date): string {
  return format(day, "yyyy-MM-dd");
}

/**
 * The display date of a "yyyy-MM-dd" day (a date input's value) and,
 * optionally, an "HH:mm" time (a time input's); null when either is none.
 */
export function dayOfIso(day: unknown, time = "00:00"): Date | null {
  const d = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(date.getTime()) ? null : date;
}
