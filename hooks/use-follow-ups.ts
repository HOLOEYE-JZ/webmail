"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { toast } from "@/stores/toast-store";
import { appUrl, buildMailMessageLink } from "@/lib/deep-links";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { emailKeyFor } from "@/lib/thread-utils";
import { emailHooks } from "@/lib/plugin-hooks";
import { debug } from "@/lib/debug";
import { completedTaskPatch } from "@/lib/task-reminders";
import {
  DEFAULT_WORKING_TIME,
  buildFollowUpTask,
  editFollowUpTask,
  followUpAction,
  followUpMailRef,
  followUpMailSummary,
  sameFollowUpAction,
  followUpsByEmailId,
  rescheduleFollowUpTask,
  scheduleFollowUp,
  threadFollowUpEmail,
  type FollowUpChoice,
  type WorkingTime,
} from "@/lib/follow-ups";
import type { Calendar, CalendarTask, Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

/** Whether the user can keep follow-ups at all: tasks on, a calendar server. */
export function useFollowUpsEnabled(): boolean {
  const tasksOn = useSettingsStore((s) => s.enableCalendarTasks);
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  return tasksOn && supportsCalendar;
}

/**
 * The user's own calendars follow-ups live in: the task list a new one goes
 * into first, then the default calendar (where it goes without a task list).
 */
export function followUpCalendars(calendars: Calendar[]): Calendar[] {
  const own = calendars.filter((c) => !c.isShared);
  const tasksOnly = own.find((c) => c.isTasksOnly);
  const fallback = own.find((c) => c.isDefault) ?? own[0];
  return [tasksOnly, fallback].filter((c, i, all): c is Calendar => !!c && all.indexOf(c) === i);
}

/**
 * Loads the tasks of the calendars follow-ups live in once the mail view
 * opens, so the list rows and the reader know which mails have one. Only
 * those calendars: the task store remembers the scope, so a push refetches
 * the same few, not every calendar of every account.
 */
export function useFollowUpTasks(): void {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    void (async () => {
      const calendarStore = useCalendarStore.getState();
      if (calendarStore.calendars.length === 0) await calendarStore.fetchCalendars(client);
      const ids = followUpCalendars(useCalendarStore.getState().calendars).map((c) => c.id);
      if (cancelled || ids.length === 0) return;
      await useTaskStore.getState().fetchTasks(client, ids);
    })();
    return () => { cancelled = true; };
  }, [enabled, client]);
}

/** The user's working time for the quick choices; Bulwark keeps no working hours, so 08:00-17:00. */
export function useWorkingTime(): WorkingTime {
  const workingDays = useSettingsStore((s) => s.calendarWorkingDays);
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  return useMemo(() => ({
    ...DEFAULT_WORKING_TIME,
    workingDays: Array.isArray(workingDays) ? workingDays : DEFAULT_WORKING_TIME.workingDays,
    firstDayOfWeek,
  }), [workingDays, firstDayOfWeek]);
}

// One index per task list and mail account, shared by every row that asks.
const indexCache = new WeakMap<CalendarTask[], Map<string, Map<string, CalendarTask>>>();
function followUpIndex(tasks: CalendarTask[], mailAccountId: string): Map<string, CalendarTask> {
  let byAccount = indexCache.get(tasks);
  if (!byAccount) {
    byAccount = new Map();
    indexCache.set(tasks, byAccount);
  }
  let index = byAccount.get(mailAccountId);
  if (!index) {
    index = followUpsByEmailId(tasks, mailAccountId);
    byAccount.set(mailAccountId, index);
  }
  return index;
}

const NO_FOLLOW_UPS = new Map<string, CalendarTask>();

/** The follow-ups of the user's own mails by mail id; none while follow-ups are off. */
function useFollowUpIndex(): Map<string, CalendarTask> {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const tasks = useTaskStore((s) => s.tasks);
  return enabled && client ? followUpIndex(tasks, client.getAccountId()) : NO_FOLLOW_UPS;
}

/**
 * Whether a mail lies in the user's own mailbox. A follow-up lands in the
 * user's own task list and links the mail in the primary account; group
 * mailboxes and other logins come later.
 */
export function isOwnMail(email: Email, client: IJMAPClient | null): boolean {
  if (!client) return false;
  const activeAccountId = useAuthStore.getState().activeAccountId;
  if (email.sourceClientAccountId && activeAccountId && email.sourceClientAccountId !== activeAccountId) return false;
  if (email.sourceAccountId) return email.sourceAccountId === client.getAccountId();
  const state = useEmailStore.getState();
  if (state.viewingAccountId && activeAccountId && state.viewingAccountId !== activeAccountId) return false;
  const mailboxes = state.viewingAccountId ? state.accountMailboxes[state.viewingAccountId] ?? state.mailboxes : state.mailboxes;
  return !mailboxes.find((m) => m.id === state.selectedMailbox)?.isShared;
}

/**
 * The mail a conversation row's flag acts on: the newest with a follow-up,
 * else the newest of all.
 */
export function useThreadFollowUpEmail(emails: readonly Email[], latest: Email): Email {
  const index = useFollowUpIndex();
  return threadFollowUpEmail(emails, index) ?? latest;
}

// Mails whose follow-up is being written, so a double click writes one task
// and the check that keeps flag and task in step leaves them alone meanwhile.
const pending = new Set<string>();

/** Whether the user is changing this mail's follow-up right now. */
export function isFollowUpPending(emailId: string): boolean {
  return pending.has(emailId);
}

// Mails the user took the star off in the app this session: their open
// follow-up is completed, never deleted, also when the task list did not
// hold it yet. Setting the star or a new follow-up here lifts it.
const unstarredHere = new Set<string>();

export function markUnstarredHere(emailId: string): void {
  unstarredHere.add(emailId);
}

export function forgetUnstarredHere(emailId: string): void {
  unstarredHere.delete(emailId);
}

export function unstarredHereMails(): ReadonlySet<string> {
  return unstarredHere;
}

// Called once the user's own change is written, so the check runs after it.
let afterChange: (() => void) | null = null;
export function onFollowUpChanged(listener: (() => void) | null): void {
  afterChange = listener;
}

async function messageIdOf(client: IJMAPClient, email: Email): Promise<string | readonly string[] | null> {
  if (email.messageId) return email.messageId;
  try {
    const [fields] = await client.getEmailFields([email.id], ["messageId"]);
    return (fields?.messageId as string[] | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sets or clears the mail's $flagged, which mirrors an open follow-up.
 * Resolves false when a plugin vetoed it (the plugin tells the user why).
 *
 * `serverFlagged`, the flag as just read from the server, marks a write for
 * a mail of the user's own account found by id alone (the check that keeps
 * flag and task in step): it is written there directly and the list and
 * reader follow with the push, so a row of another account that happens to
 * share the id is never touched.
 */
export async function mirrorFlag(
  client: IJMAPClient,
  email: Pick<Email, "id" | "keywords" | "sourceClientAccountId" | "sourceAccountId">,
  flagged: boolean,
  serverFlagged?: boolean,
): Promise<boolean> {
  const store = useEmailStore.getState();
  const byId = serverFlagged !== undefined;
  const listed = byId ? undefined : store.emails.find((e) => e.id === email.id && emailKeyFor(e) === emailKeyFor(email));
  if (listed) {
    if (!!listed.keywords?.$flagged === flagged) return true;
    // The list's own toggle asks plugins and updates the row.
    return store.toggleStar(client, email.id, emailKeyFor(email));
  }
  // Not in the list (opened by a link, or an unfolded conversation's older
  // mail): ask plugins as the list's toggle does, then write the keyword.
  const current = byId ? serverFlagged : !!(store.selectedEmail?.id === email.id ? store.selectedEmail : email).keywords?.$flagged;
  if (current === flagged) return true;
  if (emailHooks.onBeforeEmailStarToggle.size > 0
    && !(await emailHooks.onBeforeEmailStarToggle.intercept({ emailIds: [email.id], starred: flagged }))) {
    return false;
  }
  await client.toggleStar(email.id, flagged);
  void emailHooks.onEmailStarToggle.emit({ emailIds: [email.id], starred: flagged });
  if (!byId && store.selectedEmail?.id === email.id) {
    useEmailStore.setState((s) => ({
      selectedEmail: s.selectedEmail && { ...s.selectedEmail, keywords: { ...s.selectedEmail.keywords, $flagged: flagged } },
    }));
  }
  return true;
}

/**
 * One change of a mail's follow-up: writes the task, then mirrors it as
 * $flagged. While it runs, the check that keeps flag and task in step leaves
 * the mail alone; afterwards it runs. A failure after the task was written
 * says so: the follow-up stands, only the mail's flag does not.
 */
async function changeFollowUp(
  emailId: string,
  writeTask: () => Promise<boolean>,
  mirror: () => Promise<unknown>,
  messages: { failed: string; flagFailed: string },
): Promise<boolean> {
  if (pending.has(emailId)) return false;
  pending.add(emailId);
  try {
    let written: boolean;
    try {
      written = await writeTask();
    } catch (error) {
      debug.error("follow-up: task not written", error);
      toast.error(messages.failed);
      return false;
    }
    if (!written) return false;
    try {
      await mirror();
    } catch (error) {
      debug.error("follow-up: flag not mirrored", error);
      toast.error(messages.flagFailed);
    }
    return true;
  } finally {
    pending.delete(emailId);
    afterChange?.();
  }
}

/**
 * Marks a task done from a list that holds only the task (the pane
 * "Upcoming"), as the mail's own "Mark complete" does: a follow-up on a mail
 * of the user's own account clears that mail's flag too. Any other task is
 * only completed. Resolves whether the task was written.
 */
export async function completeTask(
  client: IJMAPClient,
  task: CalendarTask,
  messages: { failed: string; flagFailed: string },
): Promise<boolean> {
  // Its reminders that fired are dismissed with it, so reopened it does not remind of them again.
  const complete = () => useTaskStore.getState().updateTask(client, task.id, completedTaskPatch(task, new Date()));
  const ref = task.isShared ? null : followUpMailRef(task);
  if (!ref || (ref.accountId && ref.accountId !== client.getAccountId())) {
    try {
      return await complete();
    } catch (error) {
      debug.error("tasks: not completed", error);
      toast.error(messages.failed);
      return false;
    }
  }
  return changeFollowUp(ref.emailId, complete, async () => {
    // The row in the list, when it is there, so it follows at once; else the flag as the server has it.
    const listed = useEmailStore.getState().emails.find((e) => e.id === ref.emailId && isOwnMail(e, client));
    if (listed) return mirrorFlag(client, listed, false);
    const [fields] = await client.getEmailFields([ref.emailId], ["keywords"]);
    if (!fields) return true; // The mail is gone: nothing to mirror.
    const keywords = fields.keywords as Record<string, boolean> | undefined;
    return mirrorFlag(client, { id: ref.emailId, keywords: {} }, false, !!keywords?.$flagged);
  }, messages);
}

/** Where the follow-up dialog puts the cursor first. */
export type FollowUpDialogFocus = "action" | "reminder";

/** A reminder without a mail in the dialog: an existing task, or a new one with what was typed. */
export interface ReminderDialogTarget {
  /** The task, or null for a new reminder. */
  taskId: string | null;
  /** What a new reminder is to say, as typed so far. */
  title?: string;
}

interface FollowUpDialogState {
  /** The mail whose follow-up the dialog edits, null while it is closed or shows a reminder. */
  email: Email | null;
  /** The reminder without a mail the dialog edits, null while it is closed or shows a mail's. */
  reminder: ReminderDialogTarget | null;
  focus: FollowUpDialogFocus;
  open: (email: Email, focus?: FollowUpDialogFocus) => void;
  openReminder: (reminder: ReminderDialogTarget, focus?: FollowUpDialogFocus) => void;
  close: () => void;
}

/**
 * The one follow-up dialog of the mail view (`FollowUpDialogHost`), opened
 * from any row, menu or bar for a mail, and from the pane "Upcoming" for a
 * reminder without one.
 */
export const useFollowUpDialog = create<FollowUpDialogState>((set) => ({
  email: null,
  reminder: null,
  focus: "action",
  open: (email, focus = "action") => set({ email, reminder: null, focus }),
  openReminder: (reminder, focus = "action") => set({ email: null, reminder, focus }),
  close: () => set({ email: null, reminder: null }),
}));

/** What the dialog sets: the action as the user typed or picked it, days and times as for a quick choice. */
export interface FollowUpDetails {
  action: string;
  /** Midnight of the due day (a display date), or null for none. */
  due: Date | null;
  /** The reminder as a real instant, or null for none. */
  reminderAt: Date | null;
  note: string;
}

export interface FollowUpControls {
  /** Whether this mail can get a follow-up here. */
  available: boolean;
  /** The mail's follow-up, open or done. */
  task: CalendarTask | null;
  workingTime: WorkingTime;
  /** Sets (or moves) the follow-up to a quick choice. */
  apply: (choice: FollowUpChoice) => Promise<void>;
  /** Sets the follow-up as the dialog says; resolves whether it was written. */
  save: (details: FollowUpDetails) => Promise<boolean>;
  /** Opens the dialog for this mail. */
  openDialog: (focus?: FollowUpDialogFocus) => void;
  markDone: () => Promise<void>;
  remove: () => Promise<void>;
  /** Outlook's Quick Click: none → Today, open → done, done → removed. */
  quickClick: () => Promise<void>;
}

export function useFollowUp(email: Email | null | undefined): FollowUpControls {
  const t = useTranslations("follow_up");
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const index = useFollowUpIndex();
  const workingTime = useWorkingTime();

  const available = enabled && !!email && !email.isScheduled && !email.keywords?.$draft && isOwnMail(email, client);
  const task = available && email ? index.get(email.id) ?? null : null;

  /**
   * Writes the task, then mirrors it as $flagged. A failure after the task
   * was written says so: the follow-up stands, only the mail's flag does not.
   */
  const run = useCallback(async (
    writeTask: (client: IJMAPClient, email: Email) => Promise<boolean>,
    flagged: boolean,
  ): Promise<boolean> => {
    if (!client || !email) return false;
    return changeFollowUp(
      email.id,
      () => writeTask(client, email),
      () => mirrorFlag(client, email, flagged),
      { failed: t("failed"), flagFailed: t("flag_failed") },
    );
  }, [client, email, t]);

  /** Writes a new follow-up into the user's task list. */
  const create = useCallback(async (client: IJMAPClient, email: Email, details: FollowUpDetails) => {
    const calendarStore = useCalendarStore.getState();
    if (calendarStore.calendars.length === 0) await calendarStore.fetchCalendars(client);
    const [calendar] = followUpCalendars(useCalendarStore.getState().calendars);
    if (!calendar) {
      toast.error(t("no_task_list"));
      return false;
    }
    const subject = email.subject || t("no_subject");
    const created = await useTaskStore.getState().createTask(client, buildFollowUpTask({
      title: t("task_title", { action: details.action, subject }),
      mailUrl: appUrl(buildMailMessageLink(email.id, client.getAccountId())),
      subject: email.subject,
      messageId: await messageIdOf(client, email),
      from: email.from?.[0] ?? null,
      calendarId: calendar.id,
      due: details.due,
      reminderAt: details.reminderAt,
      note: details.note,
    }));
    return !!created;
  }, [t]);

  const apply = useCallback(async (choice: FollowUpChoice) => {
    await run(async (client, email) => {
      forgetUnstarredHere(email.id);
      const { due, reminder } = scheduleFollowUp(choice, displayNow(), workingTime);
      const reminderAt = reminder ? fromDisplayDate(reminder) : null;
      if (task) return useTaskStore.getState().updateTask(client, task.id, rescheduleFollowUpTask(due, reminderAt));
      return create(client, email, { action: t("actions.follow_up"), due, reminderAt, note: "" });
    }, true);
  }, [run, task, t, workingTime, create]);

  const save = useCallback((details: FollowUpDetails) => run(async (client, email) => {
    forgetUnstarredHere(email.id);
    const action = details.action.replace(/\s+/g, " ").trim() || t("actions.follow_up");
    if (!task) return create(client, email, { ...details, action });
    // The title changes only with the action, so one set elsewhere stays.
    // The same action in another language (written in German, kept in English) is no change either.
    const title = sameFollowUpAction(action, followUpAction(task))
      ? null
      : t("task_title", { action, subject: followUpMailSummary(task).subject || email.subject || t("no_subject") });
    return useTaskStore.getState().updateTask(client, task.id, editFollowUpTask(task, { ...details, title }));
  }, true), [run, task, t, create]);

  const openDialog = useCallback((focus?: FollowUpDialogFocus) => {
    if (email) useFollowUpDialog.getState().open(email, focus);
  }, [email]);

  const markDone = useCallback(async () => {
    await run(async (client) => (
      !!task && useTaskStore.getState().updateTask(client, task.id, completedTaskPatch(task, new Date()))
    ), false);
  }, [run, task]);

  const remove = useCallback(async () => {
    await run(async (client) => (
      !task || useTaskStore.getState().deleteTask(client, task.id)
    ), false);
  }, [run, task]);

  const quickClick = useCallback(async () => {
    if (!task) return apply("today");
    if (task.progress === "completed") return remove();
    return markDone();
  }, [task, apply, remove, markDone]);

  return { available, task, workingTime, apply, save, openDialog, markDone, remove, quickClick };
}
