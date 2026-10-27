import { addDays, differenceInCalendarDays } from "date-fns";
import type { CalendarTask } from "@/lib/jmap/types";
import { followUpDueDay, followUpReminder } from "@/lib/follow-ups";
import { isOpenTask, isRecurringTask } from "@/lib/calendar-tasks";
import { startOfWeekOf } from "@/lib/follow-up-schedule";

/**
 * "Upcoming for me", the tasks panel beside the mail list, as Outlook's To-Do bar:
 * the user's open tasks by when they are due.
 *
 * Which tasks: every open task of the user's own task list, the calendars
 * follow-ups live in (`followUpCalendars`), whoever made it: a follow-up on a
 * mail, a reminder without one, a task from the task list or a phone. Not a
 * shared calendar's. As Outlook's To-Do bar, which lists all tasks, not only
 * flagged mails. Besides them, the tasks of a group mailbox's list that are
 * for the user (`forMe`, lib/group-follow-ups.ts).
 *
 * A repeating task stands under "later" and never in the badge: its due
 * day is the series' first, which would keep it overdue for good, and a
 * check box here would end the whole series. The task list handles its
 * occurrences.
 *
 * Pure: `now` is a display date (see lib/timezone.ts).
 */

/** The near groups of the due day, before "later" (further out, or no due day). */
export type DueGroup = "overdue" | "today" | "tomorrow" | "this-week";

/** Where a task due on `due` stands: one of the near groups, or "later" (further out, or no due day). */
export function upcomingGroupOf(due: Date | null, now: Date, firstDayOfWeek = 1): DueGroup | "later" {
  if (!due) return "later";
  const days = differenceInCalendarDays(due, now);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const weekEnd = addDays(startOfWeekOf(now, firstDayOfWeek), 6);
  return differenceInCalendarDays(due, weekEnd) <= 0 ? "this-week" : "later";
}

/** The panel's groups, in order, as Outlook's To-Do bar has them. */
export const UPCOMING_GROUPS = ["overdue", "today", "tomorrow", "this-week", "next-week", "later", "no-date"] as const;
export type UpcomingGroup = (typeof UPCOMING_GROUPS)[number];

/** The far groups, folded until the user opens them. */
export const FOLDED_GROUPS: ReadonlySet<UpcomingGroup> = new Set(["next-week", "later", "no-date"]);

/** How many tasks without a due day the panel lists, the newest; the rest are in the task list. */
export const NO_DATE_SHOWN = 20;

/** The panel's group of a task due on `due`: next week apart from later, no due day its own. */
export function paneGroupOf(due: Date | null, now: Date, firstDayOfWeek = 1): UpcomingGroup {
  if (!due) return "no-date";
  const near = upcomingGroupOf(due, now, firstDayOfWeek);
  if (near !== "later") return near;
  const nextWeekEnd = addDays(startOfWeekOf(now, firstDayOfWeek), 13);
  return differenceInCalendarDays(due, nextWeekEnd) <= 0 ? "next-week" : "later";
}

/** Whether a task belongs to the user's own task list (one of `calendarIds`, not shared). */
function isOwnListTask(task: CalendarTask, calendarIds: ReadonlySet<string>): boolean {
  if (task.isShared) return false;
  return Object.keys(task.calendarIds ?? {}).some((id) => calendarIds.has(id));
}

/** The own list's tasks and the group tasks for the user, each once. */
function mineOf(
  tasks: readonly CalendarTask[],
  calendarIds: ReadonlySet<string>,
  forMe: readonly CalendarTask[],
): CalendarTask[] {
  const ids = new Set(forMe.map((t) => t.id));
  return [...tasks.filter((t) => isOwnListTask(t, calendarIds) && !ids.has(t.id)), ...forMe];
}

/** Due day first (none last), then the reminder (none last), then the title. */
function compareUpcoming(a: CalendarTask, b: CalendarTask): number {
  const dueA = followUpDueDay(a)?.getTime() ?? Infinity;
  const dueB = followUpDueDay(b)?.getTime() ?? Infinity;
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  const remA = followUpReminder(a)?.getTime() ?? Infinity;
  const remB = followUpReminder(b)?.getTime() ?? Infinity;
  if (remA !== remB) return remA < remB ? -1 : 1;
  return (a.title ?? "").localeCompare(b.title ?? "");
}

/** Newest first: by when it was made, else last changed. */
function compareNewest(a: CalendarTask, b: CalendarTask): number {
  const at = (task: CalendarTask) => Date.parse(task.created ?? task.updated ?? "") || 0;
  return at(b) - at(a);
}

export interface UpcomingGroupList {
  group: UpcomingGroup;
  /** The tasks listed: all of the group, "no date" only its newest `NO_DATE_SHOWN`. */
  tasks: CalendarTask[];
  /** How many open tasks the group holds. */
  count: number;
}

export interface UpcomingList {
  /** The groups that hold a task, in `UPCOMING_GROUPS`' order. */
  groups: UpcomingGroupList[];
}

/** The panel's contents from the task list. */
export function upcomingTasks(
  tasks: readonly CalendarTask[],
  calendarIds: ReadonlySet<string>,
  now: Date,
  firstDayOfWeek = 1,
  forMe: readonly CalendarTask[] = [],
): UpcomingList {
  const byGroup = new Map<UpcomingGroup, CalendarTask[]>();
  for (const task of mineOf(tasks, calendarIds, forMe)) {
    if (!isOpenTask(task)) continue;
    const group = isRecurringTask(task) ? "later" : paneGroupOf(followUpDueDay(task), now, firstDayOfWeek);
    const list = byGroup.get(group) ?? [];
    list.push(task);
    byGroup.set(group, list);
  }
  return {
    groups: UPCOMING_GROUPS
      .filter((group) => byGroup.has(group))
      .map((group) => {
        const all = byGroup.get(group) ?? [];
        const tasks = group === "no-date" ? [...all].sort(compareNewest).slice(0, NO_DATE_SHOWN) : [...all].sort(compareUpcoming);
        return { group, tasks, count: all.length };
      }),
  };
}

/** The rail's badge: the user's open tasks due today or earlier. */
export function dueTaskCount(
  tasks: readonly CalendarTask[],
  calendarIds: ReadonlySet<string>,
  now: Date,
  forMe: readonly CalendarTask[] = [],
): number {
  let count = 0;
  for (const task of mineOf(tasks, calendarIds, forMe)) {
    if (!isOpenTask(task) || isRecurringTask(task)) continue;
    const due = followUpDueDay(task);
    if (due && differenceInCalendarDays(due, now) <= 0) count += 1;
  }
  return count;
}
