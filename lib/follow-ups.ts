import { differenceInCalendarDays, startOfDay } from "date-fns";
import type { CalendarEventAlert, CalendarLink, CalendarTask } from "@/lib/jmap/types";
import { MAIL_ACCOUNT_PARAM } from "@/lib/deep-links";
import { patchPath } from "@/lib/jmap/patch-object";
import { FOLLOW_UP_ACTIONS, normalizeAction, type FollowUpActionKey } from "@/lib/follow-up-actions";
import { FOLLOW_UP_ACTION_NAMES, FOLLOW_UP_NO_SUBJECT } from "@/lib/follow-up-action-names";
import { htmlToPlainText } from "@/lib/html-to-text";
import type { TaskPerson } from "@/lib/group-follow-ups";
import { sanitizeEmailHtml } from "@/lib/email-sanitization";
import { isoDay, parseDate, utcDateTime } from "@/lib/task-dates";
import { isOpenTask, isRecurringTask } from "@/lib/calendar-tasks";
import {
  bareMessageId,
  mailRelation,
  replyWatch,
  replyWatchPath,
  storedWatchValue,
  watchValue,
  type ReplyWatch,
} from "@/lib/follow-up-replies";

/**
 * Follow-ups on a mail, as Outlook's "Flag for follow up" does them.
 *
 * A follow-up is a task in the user's own task list that points at the mail:
 * it carries the due day, the reminder (an alert) and a link to the mail's
 * permalink. JMAP keywords carry no date, so the task is the original and the
 * mail's $flagged only mirrors it, which lets a phone's mail app show the flag.
 *
 * This module writes the task, changes it as the dialog and the menu do, and
 * reads it for the list, the reader and the dialog. When it is due and
 * reminds is lib/follow-up-schedule.ts; settling on an answer
 * lib/follow-up-replies.ts; keeping the flag in step lib/follow-up-sync.ts.
 *
 * Everything here is pure: dates in and out are *display dates*, whose local
 * fields read as the wall clock in the user's time zone (see lib/timezone.ts).
 */

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

/** The key of the follow-up's link to the mail and of its reminder. */
export const FOLLOW_UP_LINK_ID = "mail";

/** The key of the link naming the mail's sender, kept for when the mail is gone. */
export const FOLLOW_UP_SENDER_LINK_ID = "from";

export const FOLLOW_UP_ALERT_ID = "follow-up";

/**
 * The key of the reminder's alarm mail: an alert `action: email` with the
 * reminder, which the server sends into the user's inbox even when no client
 * runs (Stalwart does so for tasks too, plan 037 M1).
 */
export const FOLLOW_UP_MAIL_ALERT_ID = "follow-up-mail";

/**
 * How much earlier than the reminder its alarm mail is written. Stalwart
 * (0.16) queues only a task's next alarm, and of two at the same time the
 * first in the task; a mail alert added beside the reminder by its path comes
 * after it, so at the same time the mail never went. A second earlier, it is
 * the next alarm. Only for writing: the mail is known by its key.
 */
export const MAIL_ALERT_LEAD_MS = 1000;

/** When the alarm mail of a reminder at `reminderAt` is written for. */
export function mailAlertTime(reminderAt: Date): Date {
  return new Date(reminderAt.getTime() - MAIL_ALERT_LEAD_MS);
}

/** RFC 8288: the mail describes what the task is about. */
const MAIL_LINK_REL = "describedby";

/** RFC 8288: the mail's sender wrote what the task is about. */
const SENDER_LINK_REL = "author";

/** The task's JSCalendar `due`: a LocalDateTime at the start of the day. */
function dueOf(due: Date | null): string | null {
  return due ? `${isoDay(due)}T00:00:00` : null;
}

function alertAt(
  reminderAt: Date,
  action: CalendarEventAlert["action"],
  acknowledged: string | null = null,
): CalendarEventAlert {
  return {
    "@type": "Alert",
    trigger: { "@type": "AbsoluteTrigger", when: utcDateTime(reminderAt) },
    action,
    acknowledged,
    relatedTo: null,
  };
}

/** The reminder's alerts: the one Bulwark shows and, with `mail`, its alarm mail at the same time. */
function alertsOf(reminderAt: Date | null, mail = false): Record<string, CalendarEventAlert> | null {
  if (!reminderAt) return null;
  return {
    [FOLLOW_UP_ALERT_ID]: alertAt(reminderAt, "display"),
    ...(mail ? { [FOLLOW_UP_MAIL_ALERT_ID]: alertAt(mailAlertTime(reminderAt), "email") } : {}),
  };
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
  /** Whether the reminder also comes as a mail into the inbox (`mailReminderOffered`). */
  mailReminder?: boolean;
  /**
   * Whether it settles itself when an answer comes (plan 037 decision 9):
   * then the task gets no alert, the reminder is kept in its reply watch, and
   * no alarm mail is written. Needs the Message-ID; without one, a plain
   * follow-up is written.
   */
  settlesOnReply?: boolean;
  /** Whom it is for, in a group's task list (lib/group-follow-ups.ts); none in the user's own. */
  participants?: CalendarTask["participants"];
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
  const watch = !!input.settlesOnReply && !!messageId;
  return {
    "@type": "Task",
    title: input.title,
    calendarIds: { [input.calendarId]: true },
    due: dueOf(input.due),
    showWithoutTime: true,
    progress: "needs-action",
    alerts: watch ? null : alertsOf(input.reminderAt, input.mailReminder),
    ...(input.note?.trim() ? { description: input.note.trim() } : {}),
    links,
    relatedTo: messageId ? { [`<${messageId}>`]: mailRelation(watch ? watchValue(input.reminderAt) : null) } : null,
    ...(input.participants ? { participants: input.participants } : {}),
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

/**
 * The patch that gives an existing follow-up a new quick choice and opens it
 * again. Its reminder is changed as the dialog changes it (`reminderPatch`):
 * the reminder it shows moved, its own alarm mail moved along while it has
 * one, every other alert left as it is.
 */
export function rescheduleFollowUpTask(
  task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>,
  due: Date | null,
  reminderAt: Date | null,
): Partial<CalendarTask> {
  return {
    due: dueOf(due),
    showWithoutTime: true,
    progress: "needs-action",
    ...reminderPatch(task, reminderAt),
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
  /** Whether the reminder also comes as a mail into the inbox (`mailReminderOffered`). */
  mailReminder?: boolean;
  /** Whom it is for, in a group's task list (lib/group-follow-ups.ts); none in the user's own. */
  participants?: CalendarTask["participants"];
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
    alerts: alertsOf(input.reminderAt, input.mailReminder),
    ...(input.note?.trim() ? { description: input.note.trim() } : {}),
    ...(input.participants ? { participants: input.participants } : {}),
  };
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

const actionText = (text: string) => normalizeAction(text).toLocaleLowerCase();

/**
 * The built-in action a text names in any language ("Anrufen", "Call"), or
 * null for one of the user's or an operator's own.
 */
export function followUpActionKey(text: string): FollowUpActionKey | null {
  const wanted = actionText(text);
  if (!wanted) return null;
  return FOLLOW_UP_ACTIONS.find((key) => FOLLOW_UP_ACTION_NAMES[key].some((name) => actionText(name) === wanted)) ?? null;
}

/**
 * The new title of a mail's follow-up whose action became `action`, or null
 * to keep the task's: the title changes only with the action, so one set
 * elsewhere stays, and the same action in another language (written in
 * German, kept in English) is no change either.
 */
export function retitle(
  task: Pick<CalendarTask, "title" | "links">,
  action: string,
  mailSubject: string | null | undefined,
  text: { title: (action: string, subject: string) => string; noSubject: string },
): string | null {
  if (sameFollowUpAction(action, followUpAction(task))) return null;
  return text.title(action, followUpMailSummary(task).subject || mailSubject || text.noSubject);
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

/** The time of a due date-time with one ("14:30:00"), or null for a whole day. */
function dueTimeOf(task: Pick<CalendarTask, "due" | "showWithoutTime">): string | null {
  if (task.showWithoutTime !== false || !task.due) return null;
  return /T(\d{2}:\d{2}(?::\d{2})?)/.exec(task.due)?.[1] ?? null;
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
  /**
   * Whether the reminder also comes as a mail into the inbox; left out, as
   * the task has it (the dialog did not offer it).
   */
  mailReminder?: boolean;
  /**
   * Whether it settles itself when an answer comes (`replyWatch`); left out,
   * as the task has it.
   */
  settlesOnReply?: boolean;
  /**
   * The mail's Message-ID, for a task that has no relation to it yet and is
   * to settle itself on an answer.
   */
  messageId?: string | readonly string[] | null;
}

/** What the dialog sets: the action as the user typed or picked it, days and times as for a quick choice. */
export interface FollowUpDetails {
  action: string;
  /** Midnight of the due day (a display date), or null for none. */
  due: Date | null;
  /** The reminder as a real instant, or null for none. */
  reminderAt: Date | null;
  note: string;
  /** Whether the reminder also comes as a mail into the inbox; left out where the dialog did not offer it. */
  mailReminder?: boolean;
  /** Whether it settles itself when an answer comes (plan 037 decision 9); left out: as the task has it. */
  settlesOnReply?: boolean;
  /**
   * Where it is kept, as the dialog's "Visible" says: left out or null, the
   * user's own list; else the group account whose task list takes it.
   */
  groupAccountId?: string | null;
  /**
   * Whom it is for in a group's list: null, the user; left out, an existing
   * task's owner unchanged (a new one is the user's).
   */
  person?: TaskPerson | null;
}

/**
 * The alerts' part of a patch that sets the reminder to `reminderAt` (null:
 * none): the reminder shown (`followUpReminderAlert`) replaced when its time
 * changed, the own alarm mail (`FOLLOW_UP_MAIL_ALERT_ID`, a second ahead)
 * moved with it, added or taken off as `mail` says (left out: as the task
 * has it). Each alert by its path, so the others (a phone's, an alarm mail
 * set elsewhere, one changed meanwhile on another device) stay as the server
 * holds them; a task without alerts gets its map whole. Empty when nothing
 * changes, so an unchanged reminder keeps its `acknowledged`.
 *
 * A follow-up that settles itself when an answer comes (`settles`, left out:
 * as the task has it) keeps its reminder in its reply watch instead, and its
 * own reminder and alarm mail are taken off: neither the phone nor the mail
 * server knows of the answer. Alerts set elsewhere stay. Turned off, the
 * watch goes and the reminder is an alert again.
 */
function reminderPatch(
  task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>,
  reminderAt: Date | null,
  mail?: boolean,
  settles?: { on: boolean; messageId?: string | readonly string[] | null },
): Record<string, unknown> {
  const watch = replyWatch(task);
  const wantWatch = settles ? settles.on : !!watch;
  const messageId = watch?.messageId
    ?? followUpMessageId({ relatedTo: task.relatedTo ?? null })
    ?? bareMessageId(settles?.messageId);
  if (wantWatch && messageId) return watchPatch(task, watch, `<${messageId}>`, reminderAt);

  const patch: Record<string, unknown> = {};
  // Turned off: an answer that settled it is remembered, so turned on again it does not settle it again.
  if (watch) patch[replyWatchPath(watch.key)] = watch.answeredAt ? { off: true, answeredAt: watch.answeredAt } : null;
  const shown = followUpReminderAlert(task);
  const hadMail = hasFollowUpMailAlert(task);
  const wantMail = !!reminderAt && (mail ?? hadMail);
  const changes: Record<string, CalendarEventAlert | null> = {};
  // Out of a watch, the reminder becomes the own alert again whatever its
  // time; an alert set elsewhere, which the watch left, stays.
  const moved = !!watch || (shown?.when.getTime() ?? null) !== (reminderAt?.getTime() ?? null);
  if (watch) {
    // The same time keeps its dismissal: switching the box does not remind again.
    const same = (watch.reminder?.getTime() ?? null) === (reminderAt?.getTime() ?? null);
    if (reminderAt) changes[FOLLOW_UP_ALERT_ID] = alertAt(reminderAt, "display", same ? watch.acknowledged : null);
  } else if (moved) {
    changes[shown?.id ?? FOLLOW_UP_ALERT_ID] = reminderAt ? alertAt(reminderAt, "display") : null;
  }
  if (wantMail && reminderAt && (moved || !hadMail)) {
    changes[FOLLOW_UP_MAIL_ALERT_ID] = alertAt(mailAlertTime(reminderAt), "email");
  } else if (!wantMail && hadMail) {
    changes[FOLLOW_UP_MAIL_ALERT_ID] = null;
  }
  return { ...patch, ...alertChanges(task, changes) };
}

/** Alert changes by path, or the map whole for a task without alerts; empty for none. */
function alertChanges(
  task: Pick<CalendarTask, "alerts">,
  changes: Record<string, CalendarEventAlert | null>,
): Record<string, unknown> {
  if (Object.keys(changes).length === 0) return {};
  if (task.alerts && Object.keys(task.alerts).length > 0) {
    return Object.fromEntries(Object.entries(changes).map(([id, alert]) => [`alerts/${patchPath(id)}`, alert]));
  }
  const added = Object.entries(changes).filter((entry): entry is [string, CalendarEventAlert] => !!entry[1]);
  return { alerts: added.length > 0 ? Object.fromEntries(added) : null };
}

/**
 * The patch that keeps the reminder in the reply watch on `key`: the watch
 * written when the task has none (the relation added when it lacks one), else
 * its reminder moved when its time changed (and opened again); the own
 * reminder alert and alarm mail taken off.
 */
function watchPatch(
  task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>,
  watch: ReplyWatch | null,
  key: string,
  reminderAt: Date | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!watch) {
    // From the reminder shown so far: a dismissal at the same time, and an
    // answer that settled it before it was turned off, carry over.
    const shown = followUpReminderAlert(task);
    const sameTime = !!shown && shown.when.getTime() === (reminderAt?.getTime() ?? null);
    const acknowledged = sameTime ? task.alerts?.[shown.id]?.acknowledged ?? null : null;
    const before = storedWatchValue(task, key);
    const answeredAt = typeof before?.answeredAt === "string" ? before.answeredAt : null;
    const value = watchValue(reminderAt, answeredAt, acknowledged);
    const relation = task.relatedTo?.[key];
    if (relation) patch[replyWatchPath(key)] = value;
    else if (task.relatedTo && Object.keys(task.relatedTo).length > 0) patch[`relatedTo/${patchPath(key)}`] = mailRelation(value);
    else patch.relatedTo = { [key]: mailRelation(value) };
  } else if ((watch.reminder?.getTime() ?? null) !== (reminderAt?.getTime() ?? null)) {
    patch[replyWatchPath(watch.key, "reminder")] = reminderAt ? utcDateTime(reminderAt) : null;
    patch[replyWatchPath(watch.key, "acknowledged")] = null;
  }
  const changes: Record<string, null> = {};
  if (task.alerts?.[FOLLOW_UP_ALERT_ID]) changes[FOLLOW_UP_ALERT_ID] = null;
  if (hasFollowUpMailAlert(task)) changes[FOLLOW_UP_MAIL_ALERT_ID] = null;
  return { ...patch, ...alertChanges(task, changes) };
}

/**
 * The patch the dialog writes to an existing follow-up: every field it shows,
 * the title only when the action changed (a title set elsewhere stays), and
 * a completed or cancelled one opened again.
 *
 * Of the alerts it touches only the reminder it shows
 * (`followUpReminderAlert`), by its path (`alerts/<id>`), and only when its
 * time changed: an unchanged one
 * keeps its `acknowledged`, so it does not fire again; any other alert (a
 * relative one, a second one set on a phone) stays as it is. The own alarm
 * mail (`hasFollowUpMailAlert`) goes with it: moved with its time, added or
 * taken off as `mailReminder` says, gone with the reminder (`reminderPatch`).
 */
export function editFollowUpTask(
  task: Pick<CalendarTask, "title" | "description" | "progress" | "alerts">
    & Partial<Pick<CalendarTask, "due" | "showWithoutTime" | "descriptionContentType" | "relatedTo">>,
  edit: FollowUpEdit,
): Partial<CalendarTask> {
  // A task with a time of day (set in the task list or on a phone) keeps it on
  // another day, so alerts relative to it still come at the right time.
  const time = dueTimeOf({ due: task.due ?? null, showWithoutTime: task.showWithoutTime ?? true });
  const patch: Partial<CalendarTask> = time
    ? { due: edit.due ? `${isoDay(edit.due)}T${time}` : null }
    : { due: dueOf(edit.due), showWithoutTime: true };
  const settles = edit.settlesOnReply === undefined ? undefined : { on: edit.settlesOnReply, messageId: edit.messageId };
  Object.assign(patch, reminderPatch(task, edit.reminderAt, edit.mailReminder, settles));
  if (edit.title !== null && edit.title !== task.title) patch.title = edit.title;
  // An HTML note is only shown here, never written back as text.
  const note = edit.note.trim();
  if (!isHtmlNote(task) && note !== followUpNote(task)) patch.description = note;
  if (!isOpenTask(task)) patch.progress = "needs-action";
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

/**
 * Whether a follow-up's mail lies in another JMAP account than the user's own
 * (a group mailbox's): such a follow-up is the user's alone ("only me"), and
 * nothing is ever set on the mail.
 */
export function isOtherAccountMail(ref: FollowUpMailRef | null, primaryAccountId: string): boolean {
  return !!ref?.accountId && ref.accountId !== primaryAccountId;
}

/**
 * The JMAP account a mail lies in by its own `mailboxIds`: a mail of another
 * account than the login's own (a group mailbox's) has them namespaced
 * `<account>:<mailbox>` (`getEmail`, the folder and search fetches do so;
 * JMAP ids hold no ":"), one of the own account bare. Undefined when it names
 * no folder, null when its folders name several accounts.
 */
export function mailAccountOfMailboxIds(
  mailboxIds: Record<string, boolean> | null | undefined,
  primaryAccountId: string,
): string | null | undefined {
  const accounts = new Set(Object.keys(mailboxIds ?? {}).map((id) => {
    const at = id.indexOf(":");
    return at === -1 ? primaryAccountId : id.slice(0, at);
  }));
  if (accounts.size === 0) return undefined;
  return accounts.size === 1 ? [...accounts][0] : null;
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
 * mails of `mailAccountId`. A link naming no account names the user's own
 * mail account, `primaryAccountId`; without it, such a link counts for any.
 * Tasks of shared calendars are left out. Of several on one mail the open one
 * wins, then the latest.
 */
export function followUpsByEmailId(
  tasks: readonly CalendarTask[],
  mailAccountId?: string | null,
  primaryAccountId?: string | null,
): Map<string, CalendarTask> {
  const byEmail = new Map<string, CalendarTask>();
  for (const task of tasks) {
    if (task.isShared || task.progress === "cancelled") continue;
    const ref = followUpMailRef(task);
    if (!ref) continue;
    const account = ref.accountId ?? primaryAccountId ?? null;
    if (account && mailAccountId && account !== mailAccountId) continue;
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
  const due = parseDate(task.due);
  return due ? startOfDay(due) : null;
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
  // An alarm mail is no reminder Bulwark shows: the server sends it.
  const shown = (alert: CalendarEventAlert | null | undefined) => (alert?.action === "email" ? null : absoluteTime(alert));
  const own = shown(task.alerts?.[FOLLOW_UP_ALERT_ID]);
  if (own) return { id: FOLLOW_UP_ALERT_ID, when: own };
  for (const [id, alert] of Object.entries(task.alerts ?? {})) {
    const when = shown(alert);
    if (when) return { id, when };
  }
  return null;
}

/**
 * Whether the reminder also comes as a mail into the inbox: the dialog's own
 * alarm mail, known by its key alone (`FOLLOW_UP_MAIL_ALERT_ID`, an alert
 * `action: email`). An alarm mail set elsewhere is not the dialog's and is
 * never changed here.
 */
export function hasFollowUpMailAlert(task: Pick<CalendarTask, "alerts">): boolean {
  return task.alerts?.[FOLLOW_UP_MAIL_ALERT_ID]?.action === "email";
}

/**
 * Whether the dialog offers the reminder also as a mail into the inbox. The
 * server sends it into the inbox of the account whose task list holds the
 * task, so only for the user's own list: in a group mailbox's list it would
 * reach the group's inbox, not the member. Not for a follow-up that settles
 * itself when an answer comes (`settlesOnReply`, plan 037 decision 9): the
 * server would send it all the same.
 */
export function mailReminderOffered(
  list: { isShared?: boolean } | null | undefined,
  settlesOnReply = false,
): boolean {
  return !!list && !list.isShared && !settlesOnReply;
}

/**
 * When a follow-up's reminder fires, or null when it has none: a reply
 * watch's (`replyWatch`), else the alert's (`followUpReminderAlert`).
 */
export function followUpReminder(task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>): Date | null {
  const watch = replyWatch(task);
  if (watch) return watch.reminder;
  return followUpReminderAlert(task)?.when ?? null;
}

/**
 * How many of the follow-up's alerts the reminder it shows and its own alarm
 * mail leave out (relative ones, a second one, an alarm mail set elsewhere).
 */
export function otherFollowUpAlerts(task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>): number {
  // A reply watch keeps the reminder shown: every alert beside it was set elsewhere.
  const shown = replyWatch(task) ? null : followUpReminderAlert(task);
  const mail = hasFollowUpMailAlert(task) ? FOLLOW_UP_MAIL_ALERT_ID : null;
  return Object.entries(task.alerts ?? {}).filter(([id, alert]) => alert && id !== shown?.id && id !== mail).length;
}
