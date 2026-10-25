import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import type { CalendarEventAlert, CalendarLink, CalendarTask } from "@/lib/jmap/types";
import { MAIL_ACCOUNT_PARAM } from "@/lib/deep-links";

/**
 * Follow-ups on a mail, as Outlook's "Flag for follow up" does them.
 *
 * A follow-up is a task in the user's own task list that points at the mail:
 * it carries the due day, the reminder (an alert) and a link to the mail's
 * permalink. JMAP keywords carry no date, so the task is the original and the
 * mail's $flagged only mirrors it, which lets a phone's mail app show the flag.
 *
 * Everything here is pure: dates in and out are *display dates*, whose local
 * fields read as the wall clock in the user's time zone (see lib/timezone.ts).
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

function atHour(day: Date, hour: number): Date {
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

function startOfWeekOf(day: Date, firstDayOfWeek: number): Date {
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

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

/** The key of the follow-up's link to the mail and of its reminder. */
export const FOLLOW_UP_LINK_ID = "mail";
export const FOLLOW_UP_ALERT_ID = "follow-up";
/** RFC 8288: the mail describes what the task is about. */
const MAIL_LINK_REL = "describedby";

/** The task's JSCalendar `due`: a LocalDateTime at the start of the day. */
function dueOf(due: Date | null): string | null {
  return due ? `${format(due, "yyyy-MM-dd")}T00:00:00` : null;
}

/** A UTCDateTime without fractional seconds (RFC 8620 §1.4). */
function utcDateTime(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function alertsOf(reminderAt: Date | null): Record<string, CalendarEventAlert> | null {
  if (!reminderAt) return null;
  return {
    [FOLLOW_UP_ALERT_ID]: {
      "@type": "Alert",
      trigger: { "@type": "AbsoluteTrigger", when: utcDateTime(reminderAt) },
      action: "display",
      acknowledged: null,
      relatedTo: null,
    },
  };
}

/** A Message-ID without its angle brackets, as JMAP's `messageId` gives it. */
function bareMessageId(messageId: string | readonly string[] | null | undefined): string | null {
  const first = Array.isArray(messageId) ? messageId[0] : messageId;
  if (typeof first !== "string") return null;
  const bare = first.trim().replace(/^<|>$/g, "");
  return bare || null;
}

export interface FollowUpTaskInput {
  /** "Follow up: <subject>", already in the user's language. */
  title: string;
  /** Absolute permalink of the mail, naming its JMAP account (`mailMessageLink`). */
  mailUrl: string;
  /** The mail's subject, shown as the link's title. */
  subject?: string;
  messageId?: string | readonly string[] | null;
  calendarId: string;
  due: Date | null;
  /** The reminder as a real instant (not a display date). */
  reminderAt: Date | null;
}

/**
 * The task a new follow-up writes. The mail is linked by its permalink and,
 * so a moved or re-imported copy can be confirmed, by its Message-ID in
 * `relatedTo` (RELATED-TO in iCalendar; a keyword would turn into a category
 * the phone shows as a tag).
 */
export function buildFollowUpTask(input: FollowUpTaskInput): Partial<CalendarTask> {
  const link: CalendarLink = {
    "@type": "Link",
    href: input.mailUrl,
    cid: null,
    contentType: null,
    size: null,
    rel: MAIL_LINK_REL,
    display: null,
    title: input.subject || null,
  };
  const messageId = bareMessageId(input.messageId);
  return {
    "@type": "Task",
    title: input.title,
    calendarIds: { [input.calendarId]: true },
    due: dueOf(input.due),
    showWithoutTime: true,
    progress: "needs-action",
    alerts: alertsOf(input.reminderAt),
    links: { [FOLLOW_UP_LINK_ID]: link },
    relatedTo: messageId ? { [`<${messageId}>`]: { "@type": "Relation", relation: { parent: true } } } : null,
  };
}

/** The patch that gives an existing follow-up a new quick choice and opens it again. */
export function rescheduleFollowUpTask(due: Date | null, reminderAt: Date | null): Partial<CalendarTask> {
  return {
    due: dueOf(due),
    showWithoutTime: true,
    progress: "needs-action",
    alerts: alertsOf(reminderAt),
  };
}

const MAIL_MESSAGE_PATH = /\/mail\/message\/([^/?#]+)/;

/** The mail a follow-up links to: its Email id and, when the link names one, its JMAP account. */
export interface FollowUpMailRef {
  emailId: string;
  /** The JMAP account of the mail; null means the user's primary mail account. */
  accountId: string | null;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The mail a follow-up task links to, or null when it links none. */
export function followUpMailRef(task: Pick<CalendarTask, "links">): FollowUpMailRef | null {
  for (const link of Object.values(task.links ?? {})) {
    if (link?.rel !== MAIL_LINK_REL || typeof link.href !== "string") continue;
    let url: URL;
    try {
      url = new URL(link.href, "http://localhost");
    } catch {
      continue;
    }
    const match = MAIL_MESSAGE_PATH.exec(url.pathname);
    if (!match) continue;
    return { emailId: decoded(match[1]), accountId: url.searchParams.get(MAIL_ACCOUNT_PARAM) || null };
  }
  return null;
}

/**
 * The follow-ups of the user's own task list by the id of their mail, for the
 * mails of `mailAccountId` (a link naming no account counts as it). Tasks of
 * shared calendars are left out. Of several on one mail the open one wins,
 * then the latest.
 */
export function followUpsByEmailId(tasks: readonly CalendarTask[], mailAccountId?: string | null): Map<string, CalendarTask> {
  const byEmail = new Map<string, CalendarTask>();
  for (const task of tasks) {
    if (task.isShared || task.progress === "cancelled") continue;
    const ref = followUpMailRef(task);
    if (!ref) continue;
    if (ref.accountId && mailAccountId && ref.accountId !== mailAccountId) continue;
    const other = byEmail.get(ref.emailId);
    if (!other || ranksAbove(task, other)) byEmail.set(ref.emailId, task);
  }
  return byEmail;
}

/**
 * The mail of a conversation its row's flag stands for: the newest one with a
 * follow-up, so a reply that came in later does not get a second one; null
 * when none has one.
 */
export function threadFollowUpEmail<T extends { id: string; receivedAt: string }>(
  emails: readonly T[],
  followUps: ReadonlyMap<string, unknown>,
): T | null {
  let found: T | null = null;
  for (const email of emails) {
    if (!followUps.has(email.id)) continue;
    if (!found || email.receivedAt > found.receivedAt) found = email;
  }
  return found;
}

function ranksAbove(a: CalendarTask, b: CalendarTask): boolean {
  const aOpen = a.progress !== "completed";
  const bOpen = b.progress !== "completed";
  if (aOpen !== bOpen) return aOpen;
  return (a.updated ?? "") > (b.updated ?? "");
}

// ---------------------------------------------------------------------------
// What the list and the reader show
// ---------------------------------------------------------------------------

export type FollowUpState = "open" | "overdue" | "done";

/** The task's due day at midnight, or null when it has none. */
export function followUpDueDay(task: Pick<CalendarTask, "due">): Date | null {
  if (!task.due) return null;
  const due = parseISO(task.due);
  return Number.isNaN(due.getTime()) ? null : startOfDay(due);
}

export function followUpState(task: Pick<CalendarTask, "due" | "progress">, now: Date): FollowUpState {
  if (task.progress === "completed") return "done";
  const due = followUpDueDay(task);
  return due && differenceInCalendarDays(due, now) < 0 ? "overdue" : "open";
}

/** When a follow-up's reminder fires, or null when it has none. */
export function followUpReminder(task: Pick<CalendarTask, "alerts">): Date | null {
  const alert = task.alerts?.[FOLLOW_UP_ALERT_ID] ?? Object.values(task.alerts ?? {})[0];
  if (!alert || alert.trigger["@type"] !== "AbsoluteTrigger") return null;
  const when = new Date(alert.trigger.when);
  return Number.isNaN(when.getTime()) ? null : when;
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
