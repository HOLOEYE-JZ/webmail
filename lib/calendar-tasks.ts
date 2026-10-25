import { format, parseISO } from "date-fns";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";

/**
 * Tasks shown on the calendar grid (#1107): only tasks with a due date, and
 * only those in a calendar the sidebar currently shows, the same rule the
 * events follow.
 */
export function filterTasksByCalendars(tasks: CalendarTask[], selectedCalendarIds: string[]): CalendarTask[] {
  const selected = new Set(selectedCalendarIds);
  return tasks.filter((task) => Object.keys(task.calendarIds ?? {}).some((id) => selected.has(id)));
}

/**
 * The calendar a new task goes into when none is chosen: the one holding
 * only tasks, else the default calendar, else the first.
 */
export function defaultTaskCalendar<T extends Pick<Calendar, "isTasksOnly" | "isDefault">>(calendars: readonly T[]): T | undefined {
  return calendars.find((c) => c.isTasksOnly) ?? calendars.find((c) => c.isDefault) ?? calendars[0];
}

/**
 * The user's own calendars follow-ups and reminders live in: the task list a
 * new one goes into first (`defaultTaskCalendar`), then the default calendar
 * (where it goes without a task list). Never a shared calendar.
 */
export function followUpCalendars(calendars: readonly Calendar[]): Calendar[] {
  const own = calendars.filter((c) => !c.isShared);
  const fallback = own.find((c) => c.isDefault) ?? own[0];
  return [defaultTaskCalendar(own), fallback].filter((c, i, all): c is Calendar => !!c && all.indexOf(c) === i);
}

/** yyyy-MM-dd of the day a task is due, or null when it has no valid due date. */
export function taskDueDayKey(task: CalendarTask): string | null {
  if (!task.due) return null;
  const due = parseISO(task.due);
  if (Number.isNaN(due.getTime())) return null;
  return format(due, "yyyy-MM-dd");
}

/**
 * Tasks keyed by the day they are due. Within a day, tasks without a time
 * come first, then by due time and title, so the order does not depend on
 * the order the server returned them in.
 */
export function groupTasksByDueDay(tasks: CalendarTask[] | undefined): Map<string, CalendarTask[]> {
  const map = new Map<string, CalendarTask[]>();
  if (!tasks?.length) return map;
  for (const task of tasks) {
    const key = taskDueDayKey(task);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) existing.push(task);
    else map.set(key, [task]);
  }
  for (const dayTasks of map.values()) {
    dayTasks.sort((a, b) => {
      const aTimed = a.showWithoutTime ? 0 : 1;
      const bTimed = b.showWithoutTime ? 0 : 1;
      if (aTimed !== bTimed) return aTimed - bTimed;
      const byDue = (a.due ?? "").localeCompare(b.due ?? "");
      if (byDue !== 0) return byDue;
      return (a.title ?? "").localeCompare(b.title ?? "");
    });
  }
  return map;
}
