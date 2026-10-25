"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
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
import {
  DEFAULT_WORKING_TIME,
  buildFollowUpTask,
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
function useWorkingTime(): WorkingTime {
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
function isOwnMail(email: Email, client: IJMAPClient | null): boolean {
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

// Mails whose follow-up is being written, so a double click writes one task.
const pending = new Set<string>();

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
 */
async function mirrorFlag(client: IJMAPClient, email: Email, flagged: boolean): Promise<boolean> {
  const store = useEmailStore.getState();
  const listed = store.emails.find((e) => e.id === email.id && emailKeyFor(e) === emailKeyFor(email));
  if (listed) {
    if (!!listed.keywords?.$flagged === flagged) return true;
    // The list's own toggle asks plugins and updates the row.
    return store.toggleStar(client, email.id, emailKeyFor(email));
  }
  // Not in the list (opened by a link, or an unfolded conversation's older
  // mail): ask plugins as the list's toggle does, then write the keyword.
  const current = store.selectedEmail?.id === email.id ? store.selectedEmail : email;
  if (!!current.keywords?.$flagged === flagged) return true;
  if (emailHooks.onBeforeEmailStarToggle.size > 0
    && !(await emailHooks.onBeforeEmailStarToggle.intercept({ emailIds: [email.id], starred: flagged }))) {
    return false;
  }
  await client.toggleStar(email.id, flagged);
  void emailHooks.onEmailStarToggle.emit({ emailIds: [email.id], starred: flagged });
  if (store.selectedEmail?.id === email.id) {
    useEmailStore.setState((s) => ({
      selectedEmail: s.selectedEmail && { ...s.selectedEmail, keywords: { ...s.selectedEmail.keywords, $flagged: flagged } },
    }));
  }
  return true;
}

export interface FollowUpControls {
  /** Whether this mail can get a follow-up here. */
  available: boolean;
  /** The mail's follow-up, open or done. */
  task: CalendarTask | null;
  workingTime: WorkingTime;
  /** Sets (or moves) the follow-up to a quick choice. */
  apply: (choice: FollowUpChoice) => Promise<void>;
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
  ) => {
    if (!client || !email || pending.has(email.id)) return;
    pending.add(email.id);
    try {
      let written: boolean;
      try {
        written = await writeTask(client, email);
      } catch (error) {
        debug.error("follow-up: task not written", error);
        toast.error(t("failed"));
        return;
      }
      if (!written) return;
      try {
        await mirrorFlag(client, email, flagged);
      } catch (error) {
        debug.error("follow-up: flag not mirrored", error);
        toast.error(t("flag_failed"));
      }
    } finally {
      pending.delete(email.id);
    }
  }, [client, email, t]);

  const apply = useCallback((choice: FollowUpChoice) => run(async (client, email) => {
    const { due, reminder } = scheduleFollowUp(choice, displayNow(), workingTime);
    const reminderAt = reminder ? fromDisplayDate(reminder) : null;
    const store = useTaskStore.getState();
    if (task) return store.updateTask(client, task.id, rescheduleFollowUpTask(due, reminderAt));
    const calendarStore = useCalendarStore.getState();
    if (calendarStore.calendars.length === 0) await calendarStore.fetchCalendars(client);
    const [calendar] = followUpCalendars(useCalendarStore.getState().calendars);
    if (!calendar) {
      toast.error(t("no_task_list"));
      return false;
    }
    const subject = email.subject || t("no_subject");
    const created = await store.createTask(client, buildFollowUpTask({
      title: t("task_title", { subject }),
      mailUrl: appUrl(buildMailMessageLink(email.id, client.getAccountId())),
      subject: email.subject,
      messageId: await messageIdOf(client, email),
      calendarId: calendar.id,
      due,
      reminderAt,
    }));
    return !!created;
  }, true), [run, task, t, workingTime]);

  const markDone = useCallback(() => run(async (client) => (
    !!task && useTaskStore.getState().updateTask(client, task.id, { progress: "completed" })
  ), false), [run, task]);

  const remove = useCallback(() => run(async (client) => (
    !task || useTaskStore.getState().deleteTask(client, task.id)
  ), false), [run, task]);

  const quickClick = useCallback(async () => {
    if (!task) return apply("today");
    if (task.progress === "completed") return remove();
    return markDone();
  }, [task, apply, remove, markDone]);

  return { available, task, workingTime, apply, markDone, remove, quickClick };
}
