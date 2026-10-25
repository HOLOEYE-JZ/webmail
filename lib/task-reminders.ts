import { startOfDay } from "date-fns";
import type { CalendarEventAlert, CalendarTask } from "@/lib/jmap/types";
import { buildAlertKey, computeTaskFireTime } from "@/lib/calendar-alerts";
import { applyPatchObject, patchPath } from "@/lib/jmap/patch-object";
import { utcDateTime } from "@/lib/task-dates";
import {
  DEFAULT_WORKING_TIME,
  followUpDueDay,
  followUpReminderAlert,
  isOpenFollowUp,
  isRecurringTask,
  FOLLOW_UP_MAIL_ALERT_ID,
  REPLY_WATCH_ALERT_ID,
  hasFollowUpMailAlert,
  replyWatch,
  replyWatchPath,
  scheduleFollowUp,
  type WorkingTime,
} from "@/lib/follow-ups";
import { isGroupFollowUpTask, isTaskForMe } from "@/lib/group-follow-ups";

/**
 * The reminders window, as Outlook's: every reminder of the user's own tasks
 * that has fired and is still open, until the user acts on it there.
 *
 * Where the state lives: in the task's alert, so every device and client
 * agrees (RFC 8984 §4.5.2):
 *
 * - An alert has been dealt with once its `acknowledged` lies at or after the
 *   time it fires. "Dismiss" sets it; another device that loads the task no
 *   longer shows it.
 * - "Snooze" moves a reminder at a fixed time (an AbsoluteTrigger, what
 *   follow-ups write) to the new time and clears `acknowledged`: any client
 *   understands an alarm at a time. A reminder relative to the due time
 *   (set in the task list or on a phone) is kept as it is and acknowledged,
 *   and a snooze alert at the new time is added next to it, related to it as
 *   its parent, as RFC 8984 describes. Stalwart keeps both (iCalendar
 *   `ACKNOWLEDGED`, and `RELATED-TO;RELTYPE=PARENT` on the snooze alarm).
 * - "Mark complete" completes the task and acknowledges its reminders that
 *   have fired (`completedTaskPatch`), as Outlook's: reopened, it does not
 *   remind of them again.
 * - The dialog's alarm mail (`FOLLOW_UP_MAIL_ALERT_ID`, an alert `action:
 *   email`) is never a row of its own: the server sends it, the window shows
 *   the reminder. Dismissing and snoozing leave it (the server sent it when
 *   it fired; a snooze is this app's matter), so the dialog still reads
 *   "also as a mail"; only a new time set in the dialog or by a quick choice
 *   writes it anew. Completing the task takes it off (`completedTaskPatch`):
 *   Stalwart sends it for a completed task too (plan 037 M1). An alarm mail
 *   set elsewhere is never touched.
 * - Each write names the alerts it changes by path
 *   (`alerts/<id>/acknowledged`), never the whole map, so a change another
 *   device made meanwhile stays.
 *
 * - A follow-up that settles itself when an answer comes (`replyWatch`) has
 *   no alert: its reminder and its dismissal are kept in the watch, and the
 *   window shows it under `REPLY_WATCH_ALERT_ID` as if it were one. It is
 *   held back until the mail's thread was looked at for an answer after it
 *   fell due (`replyCheckedAt`); an answer completes the task instead.
 *
 * Unlike an event's reminder, which is dropped when it is more than ten
 * minutes late, a task's waits here: one that fell due while the app was
 * closed shows when it opens.
 *
 * Which tasks: the user's own (not a shared calendar's), and those of a
 * shared list (a group mailbox's) whose owner participant is the user
 * (lib/group-follow-ups.ts); not repeating. A
 * repeating task's alert is the series' (this app does not expand its
 * occurrences), so dismissing or snoozing it here would change every
 * occurrence; it keeps the plain toast, as before.
 *
 * Pure: times are real instants unless a name says otherwise.
 */

/** Who the user is and which group lists are this app's, for a shared task's reminder. */
export interface GroupReminderScope {
  /** The user's addresses, lower case. */
  mine: ReadonlySet<string>;
  /** The calendar ids of the group task lists this app recognised. */
  groupListIds: ReadonlySet<string>;
}

/**
 * Whether a task's reminders go to the reminders window: one of the user's
 * own list, or a group follow-up of this app for the user
 * (lib/group-follow-ups.ts). Any other shared task keeps the plain toast.
 */
export function isReminderWindowTask(
  task: Pick<CalendarTask, "isShared" | "recurrenceRules" | "calendarIds"> & Partial<Pick<CalendarTask, "participants">>,
  scope?: GroupReminderScope,
): boolean {
  if (isRecurringTask(task)) return false;
  if (!task.isShared) return true;
  return !!scope && isGroupFollowUpTask(task, scope.groupListIds) && isTaskForMe(task, scope.mine);
}

/**
 * Whether a task's reminders are left out of the plain toast: those the
 * window shows, and a group follow-up of this app for someone else (its
 * reminder is theirs alone). Any other shared task is toasted as before.
 */
export function isToastlessTask(
  task: Pick<CalendarTask, "isShared" | "recurrenceRules" | "calendarIds"> & Partial<Pick<CalendarTask, "participants">>,
  scope: GroupReminderScope,
): boolean {
  return isReminderWindowTask(task, scope) || isGroupFollowUpTask(task, scope.groupListIds);
}

/**
 * Whether an alert firing at `fireTimeMs` was dealt with: acknowledged at or
 * after that time (RFC 8984). An acknowledgement that cannot be read counts
 * as one, so nothing nags because of it.
 */
export function isAlertAcknowledged(alert: Pick<CalendarEventAlert, "acknowledged">, fireTimeMs: number): boolean {
  if (!alert.acknowledged) return false;
  const at = new Date(alert.acknowledged).getTime();
  return Number.isNaN(at) || at >= fireTimeMs;
}

/** One row of the reminders window: a task and its alerts that have fired. */
export interface TaskReminder {
  task: CalendarTask;
  /** The task's display alerts that have fired and are not acknowledged. */
  alertIds: string[];
  /** When the latest of them fired. */
  fireTimeMs: number;
  /** Stable while the reminder stands; a snoozed one comes back under a new key. */
  key: string;
}

/** When a reply watch's reminder fires, while it is not dismissed; else null. */
function watchFireTime(task: Partial<Pick<CalendarTask, "relatedTo">>): number | null {
  const watch = replyWatch(task);
  if (!watch?.reminder) return null;
  const fires = watch.reminder.getTime();
  return isAlertAcknowledged({ acknowledged: watch.acknowledged }, fires) ? null : fires;
}

/**
 * The reminders the window shows at `nowMs`: one per task, however many of
 * its alerts fired, the earliest first. Late ones are kept, whatever the
 * delay.
 *
 * With `replyCheckedAt` (when the thread of a follow-up that settles itself
 * on an answer was last looked at, `undefined` for not yet), such a task's
 * reminders are held back until it was looked at after they fell due.
 */
export function dueTaskReminders(
  tasks: readonly CalendarTask[],
  nowMs: number,
  replyCheckedAt?: (taskId: string) => number | undefined,
  scope?: GroupReminderScope,
): TaskReminder[] {
  const reminders: TaskReminder[] = [];
  for (const task of tasks) {
    if (!isOpenFollowUp(task) || !isReminderWindowTask(task, scope)) continue;
    const alertIds: string[] = [];
    let fireTimeMs = -Infinity;
    for (const [alertId, alert] of Object.entries(task.alerts ?? {})) {
      if (!alert || alert.action !== "display") continue;
      const fires = computeTaskFireTime(task, alert.trigger);
      if (fires === null || fires > nowMs) continue;
      if (isAlertAcknowledged(alert, fires)) continue;
      alertIds.push(alertId);
      fireTimeMs = Math.max(fireTimeMs, fires);
    }
    const watchFires = watchFireTime(task);
    if (watchFires !== null && watchFires <= nowMs) {
      alertIds.push(REPLY_WATCH_ALERT_ID);
      fireTimeMs = Math.max(fireTimeMs, watchFires);
    }
    if (alertIds.length === 0) continue;
    if (replyCheckedAt && replyWatch(task) && !((replyCheckedAt(task.id) ?? -Infinity) >= fireTimeMs)) continue;
    alertIds.sort();
    reminders.push({ task, alertIds, fireTimeMs, key: buildAlertKey(task.id, alertIds.join("+"), fireTimeMs) });
  }
  return reminders.sort((a, b) => a.fireTimeMs - b.fireTimeMs || (a.task.title ?? "").localeCompare(b.task.title ?? ""));
}

/**
 * A task's patch that may name single alerts by path
 * (`alerts/<id>/acknowledged`, lib/jmap/patch-object.ts): each write changes
 * only the alerts it means, so a change another device made meanwhile to
 * another alert, or to this one's other parts, is not overwritten.
 */
export type TaskPatch = Partial<CalendarTask>
  & { [path: `alerts/${string}`]: unknown }
  & { [path: `relatedTo/${string}`]: unknown };

function acknowledging(
  task: Partial<Pick<CalendarTask, "relatedTo">>,
  alertIds: readonly string[],
  now: Date,
  skip?: string,
): TaskPatch {
  const patch: TaskPatch = {};
  const at = utcDateTime(now);
  const watch = replyWatch(task);
  for (const id of alertIds) {
    if (id === skip) continue;
    if (id === REPLY_WATCH_ALERT_ID) {
      // Kept in the reply watch, which is no alert.
      if (watch) patch[replyWatchPath(watch.key, "acknowledged") as `relatedTo/${string}`] = at;
      continue;
    }
    patch[`alerts/${patchPath(id)}/acknowledged`] = at;
  }
  return patch;
}

/**
 * The patch that dismisses a reminder: its alerts acknowledged now, nothing
 * else changed. An alarm mail beside one is left as it is: the server sent
 * it when it fired, so there is nothing left to dismiss.
 */
export function dismissTaskReminder(
  task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>,
  alertIds: readonly string[],
  now: Date,
): TaskPatch {
  return acknowledging(task, alertIds, now);
}

/**
 * The patch that completes a task, as Outlook's Mark Complete: done, and its
 * reminders that have fired dismissed, so reopened (in the dialog, on a
 * phone) it does not remind of them again. Alerts still to come stay, but
 * the dialog's own alarm mail is taken off: the server would send it for the
 * done task all the same. A repeating task keeps it (its alerts are the
 * series'), and an alarm mail set elsewhere is left as it is.
 */
export function completedTaskPatch(
  task: Pick<CalendarTask, "alerts" | "start" | "due"> & Partial<Pick<CalendarTask, "recurrenceRules" | "relatedTo">>,
  now: Date,
): TaskPatch {
  const fired: string[] = [];
  for (const [id, alert] of Object.entries(task.alerts ?? {})) {
    if (!alert?.trigger || alert.action === "email") continue;
    const fires = computeTaskFireTime(task as CalendarTask, alert.trigger);
    if (fires !== null && fires <= now.getTime() && !isAlertAcknowledged(alert, fires)) fired.push(id);
  }
  const watchFires = watchFireTime(task);
  if (watchFires !== null && watchFires <= now.getTime()) fired.push(REPLY_WATCH_ALERT_ID);
  const patch: TaskPatch = { progress: "completed", ...acknowledging(task, fired, now) };
  if (hasFollowUpMailAlert(task) && !isRecurringTask(task as Pick<CalendarTask, "recurrenceRules">)) patch[`alerts/${patchPath(FOLLOW_UP_MAIL_ALERT_ID)}`] = null;
  return patch;
}

/**
 * A task's patch as it is written: one that completes an open task
 * (`progress: "completed"`, from any form) does what `completedTaskPatch`
 * does too, unless it says otherwise itself (its own keys win, so a patch
 * made by `completedTaskPatch` is written as it is). A patch that writes the
 * alerts whole gets the same changes in that map, never paths beside it.
 */
export function withCompletion(
  before: Pick<CalendarTask, "alerts" | "start" | "due" | "progress"> & Partial<Pick<CalendarTask, "recurrenceRules" | "relatedTo">> | undefined,
  updates: TaskPatch,
  now: Date,
): TaskPatch {
  if (!before || updates.progress !== "completed" || before.progress === "completed") return updates;
  if (!("alerts" in updates)) return { ...completedTaskPatch(before, now), ...updates };
  const alerts = updates.alerts ?? null;
  const { progress: _progress, ...completion } = completedTaskPatch({ ...before, alerts }, now);
  // The alerts' paths go into the map written; a reply watch's stay paths.
  const toAlerts = Object.fromEntries(Object.entries(completion).filter(([key]) => key.startsWith("alerts/")));
  const besides = Object.fromEntries(Object.entries(completion).filter(([key]) => !key.startsWith("alerts/")));
  const done = applyPatchObject({ alerts: alerts ?? {} }, toAlerts).alerts;
  return { ...besides, ...updates, alerts: alerts && Object.keys(done).length > 0 ? done : null };
}

/** The key of a snooze alert, unused in `alerts`. */
function freeKey(alerts: Record<string, CalendarEventAlert>, base: string): string {
  if (!(base in alerts)) return base;
  let n = 2;
  while (`${base}-${n}` in alerts) n += 1;
  return `${base}-${n}`;
}

/**
 * The patch that has a reminder come again at `at`. Its fired alerts are
 * acknowledged; one at a fixed time (the follow-up's own first) is moved to
 * `at` and opened again (its alarm mail stays: it went when it fired);
 * without one, a snooze alert at `at` is added (or the one added before is
 * moved), related to the first fired alert.
 */
export function snoozeTaskReminder(
  task: Pick<CalendarTask, "alerts"> & Partial<Pick<CalendarTask, "relatedTo">>,
  alertIds: readonly string[],
  at: Date,
  now: Date,
): TaskPatch {
  const alerts = task.alerts ?? {};
  const watch = replyWatch(task);
  if (watch && alertIds.includes(REPLY_WATCH_ALERT_ID)) {
    // A reply watch's reminder moves within the watch; it stays no alert.
    return {
      ...acknowledging(task, alertIds, now, REPLY_WATCH_ALERT_ID),
      [replyWatchPath(watch.key, "reminder")]: utcDateTime(at),
      [replyWatchPath(watch.key, "acknowledged")]: null,
    } as TaskPatch;
  }
  const trigger = { "@type": "AbsoluteTrigger" as const, when: utcDateTime(at) };
  const shown = followUpReminderAlert(task)?.id;
  const absolute = (id: string) => alerts[id]?.trigger?.["@type"] === "AbsoluteTrigger";
  const target = shown && alertIds.includes(shown) && absolute(shown) ? shown : alertIds.find(absolute);
  if (target) {
    return {
      ...acknowledging(task, alertIds, now, target),
      [`alerts/${patchPath(target)}/trigger`]: trigger,
      [`alerts/${patchPath(target)}/acknowledged`]: null,
    };
  }
  const patch = acknowledging(task, alertIds, now);
  const parent = alertIds[0];
  if (!parent) return patch;
  const earlier = Object.entries(alerts).find(([id, alert]) => id !== parent && !!alert?.relatedTo?.[parent]);
  if (earlier) {
    patch[`alerts/${patchPath(earlier[0])}/trigger`] = trigger;
    patch[`alerts/${patchPath(earlier[0])}/acknowledged`] = null;
    return patch;
  }
  const snooze: CalendarEventAlert = {
    "@type": "Alert",
    trigger,
    action: "display",
    acknowledged: null,
    relatedTo: { [parent]: { "@type": "Relation", relation: { parent: true } } },
  };
  patch[`alerts/${patchPath(freeKey(alerts, "snooze"))}`] = snooze;
  return patch;
}

/** The choices of "Remind me again", in the window's order. */
export const SNOOZE_CHOICES = ["5m", "15m", "1h", "4h", "tomorrow", "next-week", "due-day"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

/** What the window offers by default, as the mockup. */
export const DEFAULT_SNOOZE: SnoozeChoice = "15m";

const MINUTES: Partial<Record<SnoozeChoice, number>> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };

/**
 * When each "Remind me again" choice would remind, as real instants:
 *
 * - in 5 / 15 minutes, in 1 / 4 hours: from now;
 * - tomorrow morning: the next working day's start, as the follow-up's
 *   "Tomorrow";
 * - next week's morning: the first working day of next week at its start, as
 *   the follow-up's "Next week";
 * - on the due day: its start of work. Left out when the task has no due day
 *   or that time has passed (a due day of today after the start, or gone).
 *
 * `displayNow` is now on the user's wall clock, `fromDisplay` turns such a
 * time into a real instant (lib/timezone.ts).
 */
export function snoozeTimes(
  task: Pick<CalendarTask, "due">,
  now: Date,
  displayNow: Date,
  work: WorkingTime = DEFAULT_WORKING_TIME,
  fromDisplay: (date: Date) => Date = (date) => date,
): { choice: SnoozeChoice; at: Date }[] {
  const times: { choice: SnoozeChoice; at: Date }[] = [];
  for (const choice of SNOOZE_CHOICES) {
    const minutes = MINUTES[choice];
    if (minutes !== undefined) {
      times.push({ choice, at: new Date(now.getTime() + minutes * 60_000) });
      continue;
    }
    let wall: Date | null = null;
    if (choice === "tomorrow") wall = scheduleFollowUp("tomorrow", displayNow, work).reminder;
    else if (choice === "next-week") wall = scheduleFollowUp("next-week", displayNow, work).reminder;
    else {
      const due = followUpDueDay(task);
      if (due) {
        const start = new Date(startOfDay(due));
        start.setHours(Math.min(Math.max(work.startHour, 0), 23), 0, 0, 0);
        if (start.getTime() > displayNow.getTime()) wall = start;
      }
    }
    if (wall) times.push({ choice, at: fromDisplay(wall) });
  }
  return times;
}
