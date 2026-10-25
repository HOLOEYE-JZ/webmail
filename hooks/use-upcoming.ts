"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { startOfDay } from "date-fns";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { toast } from "@/stores/toast-store";
import { displayNow } from "@/lib/timezone";
import { debug } from "@/lib/debug";
import { buildReminderTask, editReminderTask, followUpMailRef, type WorkingTime } from "@/lib/follow-ups";
import { dueTaskCount, upcomingTasks, type UpcomingList } from "@/lib/upcoming-tasks";
import type { CalendarTask } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { locateFollowUpMail } from "./use-follow-up-sync";
import {
  followUpCalendars,
  useFollowUpDialog,
  useFollowUpsEnabled,
  useWorkingTime,
  type FollowUpDetails,
} from "./use-follow-ups";

/** How often the pane and the badge look at the clock, so a new day moves the groups. */
const CLOCK_MS = 60_000;

/** Now on the user's wall clock (a display date), refreshed every minute. */
export function useDisplayNow(): Date {
  const [now, setNow] = useState(() => displayNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(displayNow()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The ids of the calendars that make up the user's own task list. */
function useOwnTaskListIds(): ReadonlySet<string> {
  const calendars = useCalendarStore((s) => s.calendars);
  return useMemo(() => new Set(followUpCalendars(calendars).map((c) => c.id)), [calendars]);
}

const NOTHING_UPCOMING: UpcomingList = { groups: [], later: 0 };

/**
 * The pane "Upcoming": the user's open tasks by due day. It reads the task
 * store, which every change made here and every push refreshes, so it
 * follows them at once.
 */
export function useUpcomingTasks(): UpcomingList {
  const enabled = useFollowUpsEnabled();
  const tasks = useTaskStore((s) => s.tasks);
  const ids = useOwnTaskListIds();
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  const now = useDisplayNow();
  const day = startOfDay(now).getTime();
  return useMemo(
    () => (enabled ? upcomingTasks(tasks, ids, new Date(day), firstDayOfWeek) : NOTHING_UPCOMING),
    [enabled, tasks, ids, day, firstDayOfWeek],
  );
}

/** The rail's badge: what is due for the user today or earlier; 0 while follow-ups are off. */
export function useDueTaskCount(): number {
  const enabled = useFollowUpsEnabled();
  const tasks = useTaskStore((s) => s.tasks);
  const ids = useOwnTaskListIds();
  const now = useDisplayNow();
  const day = startOfDay(now).getTime();
  return useMemo(() => (enabled ? dueTaskCount(tasks, ids, new Date(day)) : 0), [enabled, tasks, ids, day]);
}

/**
 * Opens a task from a list that holds only the task (the pane "Upcoming",
 * the reminders window): a mail's follow-up opens its mail through
 * `openMail` (a moved mail found again first, the task pointed at it), any
 * other task the follow-up dialog. A mail that is gone is said, and the
 * dialog opens instead.
 */
export async function openTaskItem(
  client: IJMAPClient,
  task: CalendarTask,
  openMail: (emailId: string, mailAccountId: string | null) => void,
  mailGone: string,
): Promise<void> {
  const mail = followUpMailRef(task);
  if (!mail) {
    useFollowUpDialog.getState().openReminder({ taskId: task.id });
    return;
  }
  const found = mail.accountId && mail.accountId !== client.getAccountId()
    ? { kind: "unknown" as const, emailId: mail.emailId }
    : await locateFollowUpMail(client, task);
  if (found.kind === "present" || found.kind === "unknown") {
    openMail(found.emailId, mail.accountId);
    return;
  }
  toast.error(mailGone);
  useFollowUpDialog.getState().openReminder({ taskId: task.id });
}

/** The calendar a new reminder goes into: the one follow-ups go into. */
async function reminderCalendar(client: IJMAPClient): Promise<string | null> {
  const calendarStore = useCalendarStore.getState();
  if (calendarStore.calendars.length === 0) await calendarStore.fetchCalendars(client);
  return followUpCalendars(useCalendarStore.getState().calendars)[0]?.id ?? null;
}

/**
 * Adds a reminder without a mail, due today, without an alert: the pane's
 * line on Enter. Resolves whether it was written.
 */
export async function addReminderToday(
  client: IJMAPClient,
  title: string,
  messages: { failed: string; noTaskList: string },
): Promise<boolean> {
  const text = title.trim();
  if (!text) return false;
  try {
    const calendarId = await reminderCalendar(client);
    if (!calendarId) {
      toast.error(messages.noTaskList);
      return false;
    }
    const created = await useTaskStore.getState().createTask(client, buildReminderTask({
      title: text,
      calendarId,
      due: startOfDay(displayNow()),
      reminderAt: null,
    }));
    return !!created;
  } catch (error) {
    debug.error("reminder: not written", error);
    toast.error(messages.failed);
    return false;
  }
}

export interface ReminderControls {
  /** Whether the dialog can show it: follow-ups on, and the task (if any) still there. */
  available: boolean;
  /** The task, or null for a new reminder. */
  task: CalendarTask | null;
  workingTime: WorkingTime;
  /** Writes it as the dialog says; `details.action` is what to do, the title. */
  save: (details: FollowUpDetails) => Promise<boolean>;
  remove: () => Promise<void>;
}

/** The dialog's handle on a reminder without a mail (or any task of the user's own list that is not a mail's). */
export function useReminder(taskId: string | null): ReminderControls {
  const t = useTranslations("follow_up");
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const task = useTaskStore((s) => (taskId ? s.tasks.find((x) => x.id === taskId) ?? null : null));
  const workingTime = useWorkingTime();
  const available = enabled && !!client && (!taskId || !!task);

  const save = useCallback(async (details: FollowUpDetails) => {
    if (!client) return false;
    const title = details.action.replace(/\s+/g, " ").trim();
    if (!title) return false;
    try {
      if (task) {
        const patch = editReminderTask(task, { ...details, title: title === task.title ? null : title });
        return await useTaskStore.getState().updateTask(client, task.id, patch);
      }
      const calendarId = await reminderCalendar(client);
      if (!calendarId) {
        toast.error(t("no_task_list"));
        return false;
      }
      const created = await useTaskStore.getState().createTask(client, buildReminderTask({
        title,
        calendarId,
        due: details.due,
        reminderAt: details.reminderAt,
        note: details.note,
      }));
      return !!created;
    } catch (error) {
      debug.error("reminder: not written", error);
      toast.error(t("reminder.failed"));
      return false;
    }
  }, [client, task, t]);

  const remove = useCallback(async () => {
    if (!client || !task) return;
    try {
      await useTaskStore.getState().deleteTask(client, task.id);
    } catch (error) {
      debug.error("reminder: not deleted", error);
      toast.error(t("reminder.failed"));
    }
  }, [client, task, t]);

  return { available, task, workingTime, save, remove };
}
