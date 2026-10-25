import { startOfDay } from "date-fns";
import type { CalendarEventAlert, CalendarTask } from "@/lib/jmap/types";
import { buildAlertKey, computeTaskFireTime } from "@/lib/calendar-alerts";
import { patchPath } from "@/lib/jmap/patch-object";
import {
  DEFAULT_WORKING_TIME,
  followUpDueDay,
  followUpReminderAlert,
  isOpenFollowUp,
  isRecurringTask,
  scheduleFollowUp,
  type WorkingTime,
} from "@/lib/follow-ups";

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
 * - Each write names the alerts it changes by path
 *   (`alerts/<id>/acknowledged`), never the whole map, so a change another
 *   device made meanwhile stays.
 *
 * Unlike an event's reminder, which is dropped when it is more than ten
 * minutes late, a task's waits here: one that fell due while the app was
 * closed shows when it opens.
 *
 * Which tasks: the user's own (not a shared calendar's), not repeating. A
 * repeating task's alert is the series' (this app does not expand its
 * occurrences), so dismissing or snoozing it here would change every
 * occurrence; it keeps the plain toast, as before.
 *
 * Pure: times are real instants unless a name says otherwise.
 */

/** Whether a task's reminders go to the reminders window. */
export function isReminderWindowTask(task: Pick<CalendarTask, "isShared" | "recurrenceRules">): boolean {
  return !task.isShared && !isRecurringTask(task);
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

/**
 * The reminders the window shows at `nowMs`: one per task, however many of
 * its alerts fired, the earliest first. Late ones are kept, whatever the
 * delay.
 */
export function dueTaskReminders(tasks: readonly CalendarTask[], nowMs: number): TaskReminder[] {
  const reminders: TaskReminder[] = [];
  for (const task of tasks) {
    if (!task.alerts || !isOpenFollowUp(task) || !isReminderWindowTask(task)) continue;
    const alertIds: string[] = [];
    let fireTimeMs = -Infinity;
    for (const [alertId, alert] of Object.entries(task.alerts)) {
      if (!alert || alert.action !== "display") continue;
      const fires = computeTaskFireTime(task, alert.trigger);
      if (fires === null || fires > nowMs) continue;
      if (isAlertAcknowledged(alert, fires)) continue;
      alertIds.push(alertId);
      fireTimeMs = Math.max(fireTimeMs, fires);
    }
    if (alertIds.length === 0) continue;
    alertIds.sort();
    reminders.push({ task, alertIds, fireTimeMs, key: buildAlertKey(task.id, alertIds.join("+"), fireTimeMs) });
  }
  return reminders.sort((a, b) => a.fireTimeMs - b.fireTimeMs || (a.task.title ?? "").localeCompare(b.task.title ?? ""));
}

/** A UTCDateTime without fractional seconds (RFC 8620 §1.4). */
function utcDateTime(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A task's patch that may name single alerts by path
 * (`alerts/<id>/acknowledged`, lib/jmap/patch-object.ts): each write changes
 * only the alerts it means, so a change another device made meanwhile to
 * another alert, or to this one's other parts, is not overwritten.
 */
export type TaskPatch = Partial<CalendarTask> & { [path: `alerts/${string}`]: unknown };

function acknowledging(alertIds: readonly string[], now: Date, skip?: string): TaskPatch {
  const patch: TaskPatch = {};
  const at = utcDateTime(now);
  for (const id of alertIds) {
    if (id !== skip) patch[`alerts/${patchPath(id)}/acknowledged`] = at;
  }
  return patch;
}

/** The patch that dismisses a reminder: its alerts acknowledged now, nothing else changed. */
export function dismissTaskReminder(
  _task: Pick<CalendarTask, "alerts">,
  alertIds: readonly string[],
  now: Date,
): TaskPatch {
  return acknowledging(alertIds, now);
}

/**
 * The patch that completes a task, as Outlook's Mark Complete: done, and its
 * reminders that have fired dismissed, so reopened (in the dialog, on a
 * phone) it does not remind of them again. Alerts still to come stay.
 */
export function completedTaskPatch(
  task: Pick<CalendarTask, "alerts" | "start" | "due">,
  now: Date,
): TaskPatch {
  const fired: string[] = [];
  for (const [id, alert] of Object.entries(task.alerts ?? {})) {
    if (!alert?.trigger) continue;
    const fires = computeTaskFireTime(task as CalendarTask, alert.trigger);
    if (fires !== null && fires <= now.getTime() && !isAlertAcknowledged(alert, fires)) fired.push(id);
  }
  return { progress: "completed", ...acknowledging(fired, now) };
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
 * `at` and opened again; without one, a snooze alert at `at` is added (or the
 * one added before is moved), related to the first fired alert.
 */
export function snoozeTaskReminder(
  task: Pick<CalendarTask, "alerts">,
  alertIds: readonly string[],
  at: Date,
  now: Date,
): TaskPatch {
  const alerts = task.alerts ?? {};
  const trigger = { "@type": "AbsoluteTrigger" as const, when: utcDateTime(at) };
  const shown = followUpReminderAlert(task)?.id;
  const absolute = (id: string) => alerts[id]?.trigger?.["@type"] === "AbsoluteTrigger";
  const target = shown && alertIds.includes(shown) && absolute(shown) ? shown : alertIds.find(absolute);
  if (target) {
    return {
      ...acknowledging(alertIds, now, target),
      [`alerts/${patchPath(target)}/trigger`]: trigger,
      [`alerts/${patchPath(target)}/acknowledged`]: null,
    };
  }
  const patch = acknowledging(alertIds, now);
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
