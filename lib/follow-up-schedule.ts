import { addDays, differenceInCalendarDays, startOfDay } from "date-fns";

/**
 * When a follow-up is due and when it reminds: Outlook's quick choices from
 * the user's working time, the composer's "Remind me if no answer by …", the
 * reminder the dialog proposes, and how far a due day is from today.
 *
 * Pure: dates in and out are *display dates*, whose local fields read as the
 * wall clock in the user's time zone (see lib/timezone.ts).
 */

/** The quick choices of the follow-up menu, in Outlook's order. */
export const FOLLOW_UP_CHOICES = ["today", "tomorrow", "this-week", "next-week", "no-date"] as const;

export type FollowUpChoice = (typeof FOLLOW_UP_CHOICES)[number];

/** When the user works: whole hours and `Date.getDay` weekdays. */
export interface WorkingTime {
  startHour: number;
  endHour: number;
  workingDays: readonly number[];
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  firstDayOfWeek: number;
}

/** Outlook's defaults: Monday to Friday, 08:00 to 17:00. */
export const DEFAULT_WORKING_TIME: WorkingTime = {
  startHour: 8,
  endHour: 17,
  workingDays: [1, 2, 3, 4, 5],
  firstDayOfWeek: 1,
};

export interface FollowUpSchedule {
  /** Midnight of the due day, or null for "No date". */
  due: Date | null;
  /** When the reminder fires, or null for none. */
  reminder: Date | null;
}

function workingDaysOf(work: WorkingTime): Set<number> {
  const days = work.workingDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return new Set(days.length > 0 ? days : DEFAULT_WORKING_TIME.workingDays);
}

/** `day` at a whole hour (clamped to the day). */
export function atHour(day: Date, hour: number): Date {
  const result = new Date(day);
  result.setHours(Math.min(Math.max(hour, 0), 23), 0, 0, 0);
  return result;
}

/** The first working day after `day`. */
function nextWorkday(day: Date, working: Set<number>): Date {
  let d = addDays(day, 1);
  while (!working.has(d.getDay())) d = addDays(d, 1);
  return d;
}

/** `day` moved on by `count` working days. */
function addWorkdays(day: Date, count: number, working: Set<number>): Date {
  let d = day;
  for (let i = 0; i < count; i++) d = nextWorkday(d, working);
  return d;
}

/** The first day of the week `day` lies in. */
export function startOfWeekOf(day: Date, firstDayOfWeek: number): Date {
  const back = (day.getDay() - firstDayOfWeek + 7) % 7;
  return addDays(startOfDay(day), -back);
}

function workdaysOfWeek(weekStart: Date, working: Set<number>): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((d) => working.has(d.getDay()));
}

/**
 * Due day and reminder of a quick choice, from the working time:
 *
 * - Today: due today, reminded an hour before the workday ends.
 * - Tomorrow: due the next working day, reminded when it starts.
 * - This week: due the week's last working day, reminded two working days
 *   from now (never after the due day) when the workday starts.
 * - Next week: due next week's last working day, reminded when next week's
 *   first working day starts.
 * - No date: neither.
 *
 * A reminder that would already lie in the past is left out.
 */
export function scheduleFollowUp(
  choice: FollowUpChoice,
  now: Date,
  work: WorkingTime = DEFAULT_WORKING_TIME,
): FollowUpSchedule {
  const working = workingDaysOf(work);
  const today = startOfDay(now);
  const future = (reminder: Date) => (reminder.getTime() > now.getTime() ? reminder : null);

  switch (choice) {
    case "today":
      return { due: today, reminder: future(atHour(today, work.endHour - 1)) };
    case "tomorrow": {
      const day = nextWorkday(today, working);
      return { due: day, reminder: atHour(day, work.startHour) };
    }
    case "this-week": {
      const days = workdaysOfWeek(startOfWeekOf(today, work.firstDayOfWeek), working);
      const last = days[days.length - 1];
      // Past the week's last working day (a weekend): due today.
      const due = last && last.getTime() >= today.getTime() ? last : today;
      const remindDay = addWorkdays(today, 2, working);
      const day = remindDay.getTime() > due.getTime() ? due : remindDay;
      return { due, reminder: future(atHour(day, work.startHour)) };
    }
    case "next-week": {
      const days = workdaysOfWeek(addDays(startOfWeekOf(today, work.firstDayOfWeek), 7), working);
      return { due: days[days.length - 1], reminder: atHour(days[0], work.startHour) };
    }
    case "no-date":
      return { due: null, reminder: null };
  }
}

/**
 * The composer's "Remind me if no answer by …": a sent
 * mail comes back three working days or a week after the day it goes out.
 */
export const NO_ANSWER_CHOICES = ["three-workdays", "week"] as const;

export type NoAnswerChoice = (typeof NO_ANSWER_CHOICES)[number];

/**
 * Due day and reminder of a no-answer choice, counted from `sent` (the day the
 * mail goes out, a display date):
 *
 * - Three working days: due the third working day after it.
 * - A week: due the same weekday a week on, or the next working day after
 *   that when it is none.
 *
 * Reminded when that day's work starts; never in the past.
 */
export function scheduleNoAnswer(
  choice: NoAnswerChoice,
  sent: Date,
  work: WorkingTime = DEFAULT_WORKING_TIME,
): { due: Date; reminder: Date | null } {
  const working = workingDaysOf(work);
  const day = startOfDay(sent);
  let due: Date;
  if (choice === "three-workdays") {
    due = addWorkdays(day, 3, working);
  } else {
    due = addDays(day, 7);
    while (!working.has(due.getDay())) due = addDays(due, 1);
  }
  const reminder = atHour(due, work.startHour);
  return { due, reminder: reminder.getTime() > sent.getTime() ? reminder : null };
}

/**
 * The reminder the dialog proposes for a reminder without a mail: on the due
 * day at the start of work while that is still to come; on a due day already
 * begun, the next full hour while the workday lasts; else the next working
 * day's start.
 */
export function proposedReminder(due: Date | null, now: Date, work: WorkingTime = DEFAULT_WORKING_TIME): Date {
  if (due && differenceInCalendarDays(due, now) === 0) {
    const start = atHour(now, work.startHour);
    const at = start.getTime() > now.getTime() ? start : atHour(now, now.getHours() + 1);
    if (at.getTime() > now.getTime() && at.getHours() < work.endHour) return at;
  }
  return proposedFollowUpReminder(due, now, work);
}

/**
 * The reminder the dialog proposes when the user turns one on: the due day's
 * start of work, else (no due day, or that time has passed) the next working
 * day's start.
 */
export function proposedFollowUpReminder(due: Date | null, now: Date, work: WorkingTime = DEFAULT_WORKING_TIME): Date {
  if (due) {
    const onDue = atHour(due, work.startHour);
    if (onDue.getTime() > now.getTime()) return onDue;
  }
  return scheduleFollowUp("tomorrow", now, work).reminder ?? atHour(addDays(startOfDay(now), 1), work.startHour);
}

/**
 * How far the due day is from today, for the row's chip: "due tomorrow",
 * "due Thu", "overdue for 3 days".
 */
export type DueDistance =
  | { kind: "none" }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "weekday"; day: Date }
  | { kind: "date"; day: Date }
  | { kind: "yesterday" }
  | { kind: "days_ago"; count: number };

export function dueDistance(due: Date | null, now: Date): DueDistance {
  if (!due) return { kind: "none" };
  const days = differenceInCalendarDays(due, now);
  if (days === 0) return { kind: "today" };
  if (days === 1) return { kind: "tomorrow" };
  if (days === -1) return { kind: "yesterday" };
  if (days < 0) return { kind: "days_ago", count: -days };
  if (days < 7) return { kind: "weekday", day: due };
  return { kind: "date", day: due };
}
