import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import type { CalendarEventAlert, CalendarLink, CalendarTask } from "@/lib/jmap/types";
import { MAIL_ACCOUNT_PARAM } from "@/lib/deep-links";
import { FOLLOW_UP_ACTIONS, type FollowUpActionKey } from "@/lib/follow-up-actions";
import { FOLLOW_UP_ACTION_NAMES, FOLLOW_UP_NO_SUBJECT } from "@/lib/follow-up-action-names";
import { htmlToPlainText } from "@/lib/html-to-text";
import { sanitizeEmailHtml } from "@/lib/email-sanitization";

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
/** The key of the link naming the mail's sender, kept for when the mail is gone. */
export const FOLLOW_UP_SENDER_LINK_ID = "from";
export const FOLLOW_UP_ALERT_ID = "follow-up";
/** RFC 8288: the mail describes what the task is about. */
const MAIL_LINK_REL = "describedby";
/** RFC 8288: the mail's sender wrote what the task is about. */
const SENDER_LINK_REL = "author";

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
  /** The mail's sender, kept in the task so it can still be named once the mail is gone. */
  from?: { name?: string | null; email?: string | null } | null;
  calendarId: string;
  due: Date | null;
  /** The reminder as a real instant (not a display date). */
  reminderAt: Date | null;
  /** The user's note, kept as the task's description. */
  note?: string;
}

/**
 * The task a new follow-up writes. The mail is linked by its permalink and,
 * so a moved or re-imported copy can be confirmed, by its Message-ID in
 * `relatedTo` (RELATED-TO in iCalendar; a keyword would turn into a category
 * the phone shows as a tag).
 */
export function buildFollowUpTask(input: FollowUpTaskInput): Partial<CalendarTask> {
  const links: Record<string, CalendarLink> = {};
  links[FOLLOW_UP_LINK_ID] = {
    "@type": "Link",
    href: input.mailUrl,
    cid: null,
    contentType: null,
    size: null,
    rel: MAIL_LINK_REL,
    display: null,
    title: input.subject || null,
  };
  const sender = senderLink(input.from);
  if (sender) links[FOLLOW_UP_SENDER_LINK_ID] = sender;
  const messageId = bareMessageId(input.messageId);
  return {
    "@type": "Task",
    title: input.title,
    calendarIds: { [input.calendarId]: true },
    due: dueOf(input.due),
    showWithoutTime: true,
    progress: "needs-action",
    alerts: alertsOf(input.reminderAt),
    ...(input.note?.trim() ? { description: input.note.trim() } : {}),
    links,
    relatedTo: messageId ? { [`<${messageId}>`]: { "@type": "Relation", relation: { parent: true } } } : null,
  };
}

/** The sender as a `mailto:` link titled with the name, or null without an address. */
function senderLink(from: FollowUpTaskInput["from"]): CalendarLink | null {
  const email = from?.email?.trim();
  if (!email) return null;
  return {
    "@type": "Link",
    href: `mailto:${email}`,
    cid: null,
    contentType: null,
    size: null,
    rel: SENDER_LINK_REL,
    display: null,
    title: from?.name?.trim() || null,
  };
}

/**
 * The patch that adds the sender to a follow-up written without it, or null
 * when it has one already or the sender is unknown.
 */
export function addFollowUpSender(
  task: Pick<CalendarTask, "links">,
  from: FollowUpTaskInput["from"],
): Partial<CalendarTask> | null {
  if (Object.values(task.links ?? {}).some((link) => link?.rel === SENDER_LINK_REL)) return null;
  const sender = senderLink(from);
  return sender ? { links: { ...(task.links ?? {}), [FOLLOW_UP_SENDER_LINK_ID]: sender } } : null;
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

// ---------------------------------------------------------------------------
// A reminder without a mail
// ---------------------------------------------------------------------------

export interface ReminderTaskInput {
  /** What to do, as the user typed it: the task's title. */
  title: string;
  calendarId: string;
  /** Midnight of the due day (a display date), or null for none. */
  due: Date | null;
  /** The reminder as a real instant (not a display date), or null for none. */
  reminderAt: Date | null;
  note?: string;
}

/**
 * The task of a reminder that stands on its own ("Check the dunning run"):
 * the same as a follow-up's, but with no link to a mail and no Message-ID,
 * so nothing keeps a mail's flag in step with it.
 */
export function buildReminderTask(input: ReminderTaskInput): Partial<CalendarTask> {
  return {
    "@type": "Task",
    title: input.title.trim(),
    calendarIds: { [input.calendarId]: true },
    due: dueOf(input.due),
    showWithoutTime: true,
    progress: "needs-action",
    alerts: alertsOf(input.reminderAt),
    ...(input.note?.trim() ? { description: input.note.trim() } : {}),
  };
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
 * The patch the dialog writes to a task that is not a mail's follow-up (a
 * reminder, or a task from the task list or a phone). As `editFollowUpTask`,
 * but the due day is written only when it changed, so a due time set in the
 * task list stays.
 */
export function editReminderTask(
  task: Pick<CalendarTask, "title" | "description" | "progress" | "alerts" | "due">
    & Partial<Pick<CalendarTask, "showWithoutTime" | "descriptionContentType" | "recurrenceRules">>,
  edit: FollowUpEdit,
): Partial<CalendarTask> {
  const patch = editFollowUpTask(task, edit);
  const before = followUpDueDay(task);
  // A series' due day is never moved from here.
  const recurring = isRecurringTask(task as Pick<CalendarTask, "recurrenceRules">);
  if (recurring || (before?.getTime() ?? null) === (edit.due?.getTime() ?? null)) {
    delete patch.due;
    delete patch.showWithoutTime;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// What the dialog edits
// ---------------------------------------------------------------------------

/**
 * Between what to do and the mail's subject in the task's title; a full-width
 * colon too, and French puts a space before it ("Assurer un suivi : …").
 */
const TITLE_SEPARATOR = /\s*[:：]\s*$/u;

/**
 * What the follow-up asks for ("Flag to"), read back from the task's title.
 *
 * The title is "<action>: <subject>" in the language it was written in
 * (`follow_up.task_title`), so a phone's task list shows what to do. The
 * subject is also the mail link's title, which nothing but this code writes,
 * so the action is the title's part in front of it and its separator. A title
 * changed elsewhere so that it no longer ends with the subject is taken whole
 * as the action: the user wrote there what to do. A mail without a subject
 * has "(no subject)" in the title in the language it was written in, so
 * every locale's text counts.
 */
export function followUpAction(task: Pick<CalendarTask, "title" | "links">): string {
  const title = (task.title ?? "").trim();
  const { subject } = followUpMailSummary(task);
  for (const candidate of [subject?.trim(), ...FOLLOW_UP_NO_SUBJECT]) {
    if (!candidate || title.length <= candidate.length || !title.endsWith(candidate)) continue;
    const head = title.slice(0, title.length - candidate.length);
    if (!TITLE_SEPARATOR.test(head)) continue;
    const action = head.replace(TITLE_SEPARATOR, "").trim();
    if (action) return action;
  }
  return title;
}

const actionText = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/**
 * The built-in action a text names in any language ("Anrufen", "Call"), or
 * null for one of the user's or an operator's own.
 */
export function followUpActionKey(text: string): FollowUpActionKey | null {
  const wanted = actionText(text);
  if (!wanted) return null;
  return FOLLOW_UP_ACTIONS.find((key) => FOLLOW_UP_ACTION_NAMES[key].some((name) => actionText(name) === wanted)) ?? null;
}

/** Whether two action texts mean the same: equal, or the same built-in action in two languages. */
export function sameFollowUpAction(a: string, b: string): boolean {
  if (actionText(a) === actionText(b)) return true;
  const key = followUpActionKey(a);
  return key !== null && key === followUpActionKey(b);
}

/** Whether the task's description is HTML (written so elsewhere): shown as text, never rewritten here. */
export function isHtmlNote(task: Pick<CalendarTask, "descriptionContentType">): boolean {
  return /^\s*text\/html\b/i.test(task.descriptionContentType ?? "");
}

/**
 * The user's note on a follow-up: the task's description, as text. An HTML
 * one (set in another client) is read as text, its markup never shown.
 */
export function followUpNote(task: Pick<CalendarTask, "description" | "descriptionContentType">): string {
  const description = task.description ?? "";
  // Sanitized first, so a script's or style's text never shows.
  return (isHtmlNote(task) ? htmlToPlainText(sanitizeEmailHtml(description)) : description).trim();
}

/**
 * Whether a task repeats: its due day is the series', so it is neither
 * grouped by it nor completed or moved from here, only in the task list.
 * Stalwart names the rule `recurrenceRule`, RFC 8984 `recurrenceRules`.
 */
export function isRecurringTask(task: Pick<CalendarTask, "recurrenceRules">): boolean {
  const raw = task as { recurrenceRules?: unknown; recurrenceRule?: unknown };
  return (Array.isArray(raw.recurrenceRules) && raw.recurrenceRules.length > 0) || !!raw.recurrenceRule;
}

/** The time of a due date-time with one ("14:30:00"), or null for a whole day. */
function dueTimeOf(task: Pick<CalendarTask, "due" | "showWithoutTime">): string | null {
  if (task.showWithoutTime !== false || !task.due) return null;
  return /T(\d{2}:\d{2}(?::\d{2})?)/.exec(task.due)?.[1] ?? null;
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

/** What the dialog writes. */
export interface FollowUpEdit {
  /** The new title, or null to keep the task's (the action did not change). */
  title: string | null;
  /** Midnight of the due day (a display date), or null for none. */
  due: Date | null;
  /** The reminder as a real instant, or null for none. */
  reminderAt: Date | null;
  note: string;
}

/**
 * The patch the dialog writes to an existing follow-up: every field it shows,
 * the title only when the action changed (a title set elsewhere stays), and
 * a completed or cancelled one opened again.
 *
 * Of the alerts it touches only the reminder it shows
 * (`followUpReminderAlert`) and only when its time changed: an unchanged one
 * keeps its `acknowledged`, so it does not fire again; any other alert (a
 * relative one, a second one set on a phone) stays as it is.
 */
export function editFollowUpTask(
  task: Pick<CalendarTask, "title" | "description" | "progress" | "alerts">
    & Partial<Pick<CalendarTask, "due" | "showWithoutTime" | "descriptionContentType">>,
  edit: FollowUpEdit,
): Partial<CalendarTask> {
  // A task with a time of day (set in the task list or on a phone) keeps it on
  // another day, so alerts relative to it still come at the right time.
  const time = dueTimeOf({ due: task.due ?? null, showWithoutTime: task.showWithoutTime ?? true });
  const patch: Partial<CalendarTask> = time
    ? { due: edit.due ? `${format(edit.due, "yyyy-MM-dd")}T${time}` : null }
    : { due: dueOf(edit.due), showWithoutTime: true };
  const shown = followUpReminderAlert(task);
  if ((shown?.when.getTime() ?? null) !== (edit.reminderAt?.getTime() ?? null)) {
    const alerts = { ...(task.alerts ?? {}) };
    delete alerts[shown?.id ?? FOLLOW_UP_ALERT_ID];
    const own = alertsOf(edit.reminderAt);
    if (own) alerts[shown?.id ?? FOLLOW_UP_ALERT_ID] = own[FOLLOW_UP_ALERT_ID];
    patch.alerts = Object.keys(alerts).length > 0 ? alerts : null;
  }
  if (edit.title !== null && edit.title !== task.title) patch.title = edit.title;
  // An HTML note is only shown here, never written back as text.
  const note = edit.note.trim();
  if (!isHtmlNote(task) && note !== followUpNote(task)) patch.description = note;
  if (!isOpenFollowUp(task)) patch.progress = "needs-action";
  return patch;
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

/** The Message-ID of the mail a follow-up was written for, without angle brackets. */
export function followUpMessageId(task: Pick<CalendarTask, "relatedTo">): string | null {
  for (const [uid, relation] of Object.entries(task.relatedTo ?? {})) {
    if (relation?.relation && !relation.relation.parent) continue;
    const bare = bareMessageId(uid);
    if (bare) return bare;
  }
  return null;
}

/**
 * What the task keeps of its mail: the subject (the link's title) and the
 * sender (name, else address). Either is null when the task does not say.
 */
export function followUpMailSummary(task: Pick<CalendarTask, "links">): { subject: string | null; sender: string | null } {
  let subject: string | null = null;
  let sender: string | null = null;
  for (const link of Object.values(task.links ?? {})) {
    if (!link) continue;
    if (link.rel === MAIL_LINK_REL && subject === null) subject = link.title || null;
    if (link.rel === SENDER_LINK_REL && sender === null) {
      sender = link.title || (typeof link.href === "string" ? decoded(link.href.replace(/^mailto:/i, "")) || null : null);
    }
  }
  return { subject, sender };
}

/**
 * The patch that points a follow-up's mail link at another Email id, for a
 * mail found again by its Message-ID under a new id. Null when the task links
 * no mail.
 */
export function relinkFollowUpTask(task: Pick<CalendarTask, "links">, emailId: string): Partial<CalendarTask> | null {
  for (const [key, link] of Object.entries(task.links ?? {})) {
    if (link?.rel !== MAIL_LINK_REL || typeof link.href !== "string" || !MAIL_MESSAGE_PATH.test(link.href)) continue;
    const href = link.href.replace(MAIL_MESSAGE_PATH, `/mail/message/${encodeURIComponent(emailId)}`);
    return { links: { ...task.links, [key]: { ...link, href } } };
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

function absoluteTime(alert: CalendarEventAlert | null | undefined): Date | null {
  if (!alert || alert.trigger["@type"] !== "AbsoluteTrigger") return null;
  const when = new Date(alert.trigger.when);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * The follow-up's reminder as the list, the reader and the dialog show it:
 * its own alert, else the first one at a fixed time (set elsewhere), with the
 * alert's key so the dialog changes that one. Null when none fires at a fixed
 * time.
 */
export function followUpReminderAlert(task: Pick<CalendarTask, "alerts">): { id: string; when: Date } | null {
  const own = absoluteTime(task.alerts?.[FOLLOW_UP_ALERT_ID]);
  if (own) return { id: FOLLOW_UP_ALERT_ID, when: own };
  for (const [id, alert] of Object.entries(task.alerts ?? {})) {
    const when = absoluteTime(alert);
    if (when) return { id, when };
  }
  return null;
}

/** When a follow-up's reminder fires, or null when it has none. */
export function followUpReminder(task: Pick<CalendarTask, "alerts">): Date | null {
  return followUpReminderAlert(task)?.when ?? null;
}

/** How many of the follow-up's alerts the reminder it shows leaves out (relative ones, a second one). */
export function otherFollowUpAlerts(task: Pick<CalendarTask, "alerts">): number {
  const shown = followUpReminderAlert(task);
  return Object.entries(task.alerts ?? {}).filter(([id, alert]) => alert && id !== shown?.id).length;
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

// ---------------------------------------------------------------------------
// Keeping the flag and the task in step
// ---------------------------------------------------------------------------

/**
 * A follow-up last seen open while its mail was flagged, as of the task's
 * `updated` then. It tells which side moved when the two disagree later: a
 * task still as it was whose mail lost the flag had the flag cleared
 * elsewhere; a task that changed since was reopened or edited elsewhere.
 */
export interface FollowUpMirrorEntry {
  emailId: string;
  calendarId: string;
  updated: string | null;
}

/** The entries by task id, for the user's own mail account. */
export type FollowUpMirror = Record<string, FollowUpMirrorEntry>;

/** One follow-up as the check sees it. */
export interface FollowUpSyncTask {
  id: string;
  emailId: string;
  calendarId: string;
  open: boolean;
  updated: string | null;
  /** As the server gave it, not changed in the browser since. Only those are remembered. */
  fresh: boolean;
}

export type FollowUpSyncAction =
  /**
   * Set or clear the mail's $flagged for the follow-up `taskId`. `taskGone`:
   * cleared because the task is no longer in the list.
   */
  | { kind: "flag"; taskId: string; emailId: string; flagged: boolean; taskGone?: true }
  /** The flag was cleared elsewhere: the open task goes, as Outlook's Clear Flag. */
  | { kind: "delete-task"; taskId: string; emailId: string }
  /** The user took the star off in this app: the open task is completed. */
  | { kind: "complete-task"; taskId: string; emailId: string };

/**
 * Whether an action takes something away on the strength of what the task
 * list lacks or the flag no longer says: it waits for a complete task list
 * loaded just before.
 */
export function isDestructiveSyncAction(action: FollowUpSyncAction): boolean {
  return action.kind === "delete-task" || (action.kind === "flag" && !!action.taskGone);
}

export interface FollowUpSyncInput {
  /** The follow-ups, at most one per mail (`followUpsByEmailId`). */
  tasks: readonly FollowUpSyncTask[];
  /** The id of every task the task list holds now. */
  present: ReadonlySet<string>;
  /** Whether the task list holds every task of a calendar (it was loaded). */
  listed: (calendarId: string) => boolean;
  /** Each checked mail's $flagged; null for a mail that is gone. Mails not checked are left alone. */
  flags: ReadonlyMap<string, boolean | null>;
  mirror: FollowUpMirror;
  /**
   * Mails the user took the star off in this app (this session): their open
   * follow-up is completed, never deleted, whatever the list held then.
   */
  unstarredHere?: ReadonlySet<string>;
}

/** Whether a follow-up counts as open: neither completed nor cancelled. */
export function isOpenFollowUp(task: Pick<CalendarTask, "progress">): boolean {
  return task.progress !== "completed" && task.progress !== "cancelled";
}

/**
 * What keeps the mails' $flagged and their follow-ups in step. The task is
 * the original, the flag its mirror:
 *
 * - A task completed or deleted clears the flag; one reopened sets it.
 * - A flag cleared elsewhere deletes the open task, unless the task changed
 *   since it was last seen in step (then the task wins and the flag is set).
 * - A flag set elsewhere on a mail without an open follow-up stays a plain
 *   flag.
 * - A mail that is gone changes nothing; its task stays.
 *
 * Returns the actions and the mirror to keep afterwards.
 */
export function planFollowUpSync(input: FollowUpSyncInput): { actions: FollowUpSyncAction[]; mirror: FollowUpMirror } {
  const mirror: FollowUpMirror = { ...input.mirror };
  const actions: FollowUpSyncAction[] = [];
  const decided = new Set<string>();

  for (const task of input.tasks) {
    decided.add(task.id);
    const flagged = input.flags.get(task.emailId);
    if (flagged === undefined) continue;
    const seen = input.mirror[task.id];
    if (flagged === null) {
      delete mirror[task.id];
      continue;
    }
    if (task.open && flagged) {
      if (task.fresh) mirror[task.id] = { emailId: task.emailId, calendarId: task.calendarId, updated: task.updated };
    } else if (task.open && input.unstarredHere?.has(task.emailId)) {
      actions.push({ kind: "complete-task", taskId: task.id, emailId: task.emailId });
      if (seen) mirror[task.id] = seen;
    } else if (task.open) {
      if (seen && seen.emailId === task.emailId && seen.updated === task.updated) {
        actions.push({ kind: "delete-task", taskId: task.id, emailId: task.emailId });
        delete mirror[task.id];
      } else {
        // New, reopened, moved to another day, or never seen in step here.
        // Known limit: a browser without the entry (a new one, or storage
        // cleared) cannot tell a flag cleared elsewhere from a task reopened
        // elsewhere, so it sets the flag again rather than delete the task;
        // a Clear Flag made before its first check is undone once. That errs
        // on the side that loses nothing.
        actions.push({ kind: "flag", taskId: task.id, emailId: task.emailId, flagged: true });
      }
    } else {
      // Completed: a flag it still mirrors goes; a flag set after it stays.
      if (flagged && seen) actions.push({ kind: "flag", taskId: task.id, emailId: task.emailId, flagged: false });
      delete mirror[task.id];
    }
  }

  // Remembered follow-ups the list no longer holds were deleted.
  for (const [taskId, seen] of Object.entries(input.mirror)) {
    if (decided.has(taskId) || input.present.has(taskId)) continue;
    if (!input.listed(seen.calendarId)) continue;
    const flagged = input.flags.get(seen.emailId);
    if (flagged === undefined) continue;
    // Another open follow-up on the same mail keeps the flag.
    const stillFollowedUp = input.tasks.some((t) => t.emailId === seen.emailId && t.open);
    if (flagged && !stillFollowedUp) actions.push({ kind: "flag", taskId, emailId: seen.emailId, flagged: false, taskGone: true });
    delete mirror[taskId];
  }

  // One write per mail: of conflicting wishes, the open follow-up's wins.
  const byMail = new Map<string, FollowUpSyncAction>();
  for (const action of actions) {
    const other = byMail.get(action.emailId);
    if (!other || (other.kind === "flag" && !other.flagged)) byMail.set(action.emailId, action);
  }
  return { actions: [...byMail.values()], mirror };
}

/** The mirror kept in the browser, read back defensively. */
export function parseFollowUpMirror(raw: string | null): FollowUpMirror {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const mirror: FollowUpMirror = {};
    for (const [taskId, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as Partial<FollowUpMirrorEntry> | null;
      if (!e || typeof e.emailId !== "string" || typeof e.calendarId !== "string") continue;
      mirror[taskId] = { emailId: e.emailId, calendarId: e.calendarId, updated: typeof e.updated === "string" ? e.updated : null };
    }
    return mirror;
  } catch {
    return {};
  }
}
