import { addYears, format, startOfDay } from "date-fns";
import { parseDate } from "@/lib/task-dates";
import type { CalendarEvent, CalendarRecurrenceRule, CalendarTask } from "@/lib/jmap/types";
import { expandRecurringEvents } from "@/lib/recurrence-expansion";
import { followUpDueDay, followUpMailRef, followUpReminder } from "@/lib/follow-ups";
import { isOpenTask, isRecurringTask } from "@/lib/calendar-tasks";
import { isGroupFollowUpTask, isInGroupList, isTaskForMe } from "@/lib/group-follow-ups";
import { upcomingGroupOf } from "@/lib/upcoming-tasks";
import type { TaskViewFilter } from "@/stores/task-store";

/**
 * The task list in the calendar, grouped by when a task is due (plan 037
 * decisions 7, 11): overdue, today, tomorrow, this week, later, without a
 * date, done. Overdue to this week as "Upcoming" beside the mail list
 * (lib/upcoming-tasks.ts) has them.
 *
 * Which tasks it lists is its scope:
 *
 * - `all`: the calendars the sidebar shows, as the list always did.
 * - `mine`: every task of the user's own account (any of its calendars) and
 *   the tasks of a group mailbox's list that are for the user.
 * - `follow-ups`: of those, the ones on a mail.
 * - `reminders`: of those, the ones without a mail.
 * - `group:<account>`: everything in that group mailbox's task list,
 *   whoever it is for.
 *
 * The status filter and "show completed" apply on top, as before; asking
 * for the completed ones shows them whatever "show completed" says.
 *
 * A repeating task stands at its next occurrence from today on (its due day
 * is the series' first, which would keep it overdue for good); one with
 * none to come stands without a date. It is never overdue.
 *
 * Pure: `now` is a display date (see lib/timezone.ts).
 */

export const TASK_LIST_GROUPS = ["overdue", "today", "tomorrow", "this-week", "later", "no-date", "done"] as const;
export type TaskListGroup = (typeof TASK_LIST_GROUPS)[number];

export const TASK_LIST_SCOPES = ["all", "mine", "follow-ups", "reminders"] as const;
/** Which tasks the list shows; a group mailbox's list by its account. */
export type TaskListScope = (typeof TASK_LIST_SCOPES)[number] | `group:${string}`;

/** The scope of a group mailbox's list. */
export function groupScope(accountId: string): TaskListScope {
  return `group:${accountId}`;
}

/** The group account a scope names, or null for any other scope. */
export function scopeGroupAccount(scope: TaskListScope): string | null {
  return scope.startsWith("group:") ? scope.slice("group:".length) : null;
}

/** How far ahead a repeating task's next occurrence is looked for. */
const OCCURRENCE_HORIZON_YEARS = 2;

const LOCAL = "yyyy-MM-dd'T'HH:mm:ss";

type TaskTimes = Pick<CalendarTask, "id" | "due" | "start" | "showWithoutTime" | "recurrenceRules">;

/**
 * Where a repeating task stands: its next occurrence on or after `now`'s day
 * (`due`, a wall time, is that occurrence's due date-time); `ended` when the
 * series has none to come; `unknown` when that cannot be told cheaply (a
 * COUNT series begun so long ago that the expansion gives up before today),
 * which the list treats as still running.
 */
export type NextOccurrence = { kind: "next"; due: Date } | { kind: "ended" } | { kind: "unknown" };

function rulesOf(task: TaskTimes): CalendarRecurrenceRule[] {
  // Stalwart names a task's rule `recurrenceRule`, RFC 8984 `recurrenceRules`.
  const raw = task as { recurrenceRule?: CalendarRecurrenceRule | null };
  return task.recurrenceRules?.length ? task.recurrenceRules : raw.recurrenceRule ? [raw.recurrenceRule] : [];
}

/**
 * A repeating task's next occurrence. The series runs from the task's start,
 * else its due date (RFC 8984 §5.2.4); each occurrence is due as far after
 * its start as the task is. An override's own `due` or `start` moves its
 * occurrence, an excluded one is left out (as `expandRecurringEvents` does).
 */
export function nextOccurrence(task: TaskTimes, now: Date): NextOccurrence {
  // Asked several times per render (group, order, the row's date): once per task and day.
  const day = startOfDay(now).getTime();
  const cached = occurrenceCache.get(task);
  if (cached?.day === day) return cached.next;
  const next = computeNextOccurrence(task, now);
  occurrenceCache.set(task, { day, next });
  return next;
}

const occurrenceCache = new WeakMap<object, { day: number; next: NextOccurrence }>();

function computeNextOccurrence(task: TaskTimes, now: Date): NextOccurrence {
  const raw = task as {
    recurrenceOverrides?: Record<string, Partial<CalendarTask> & { excluded?: boolean }> | null;
    excludedRecurrenceRules?: CalendarRecurrenceRule[] | null;
  };
  const rules = rulesOf(task);
  const start = parseDate(task.start);
  const due = parseDate(task.due);
  const anchor = start ?? due;
  if (rules.length === 0 || !anchor) return { kind: "ended" };
  const offset = start && due ? due.getTime() - start.getTime() : 0;
  const overrides = raw.recurrenceOverrides ?? null;
  const series = (withRules: CalendarRecurrenceRule[], plain = false) => ({
    id: task.id,
    uid: task.id,
    calendarIds: {},
    start: format(anchor, LOCAL),
    duration: "PT0S",
    showWithoutTime: task.showWithoutTime !== false,
    // Wall times, as the task's due date-time is read everywhere in the list.
    timeZone: null,
    recurrenceRules: withRules,
    recurrenceOverrides: plain ? null : overrides,
    excludedRecurrenceRules: plain ? null : raw.excludedRecurrenceRules ?? null,
  }) as unknown as CalendarEvent;

  const from = startOfDay(now);
  // An occurrence that starts before today may be due today or later.
  const rangeStart = new Date(from.getTime() - Math.max(offset, 0));
  let next: Date | null = null;
  const occurrences = expandRecurringEvents(
    [series(rules)],
    format(rangeStart, LOCAL),
    format(addYears(from, OCCURRENCE_HORIZON_YEARS), LOCAL),
  );
  for (const occurrence of occurrences) {
    const override = occurrence.recurrenceId ? overrides?.[occurrence.recurrenceId] : undefined;
    const occurrenceStart = parseDate(occurrence.start);
    const occurrenceDue = parseDate(override?.due) ?? (occurrenceStart ? new Date(occurrenceStart.getTime() + offset) : null);
    if (!occurrenceDue || occurrenceDue.getTime() < from.getTime()) continue;
    if (!next || occurrenceDue.getTime() < next.getTime()) next = occurrenceDue;
  }
  if (next) return { kind: "next", due: next };

  // None to come: ended only when every rule is known to have run out.
  for (const rule of rules) {
    const until = parseDate(rule.until);
    if (until && until.getTime() < from.getTime()) continue;
    if (rule.count) {
      // Every date the rule made before today, exclusions included (they count, RFC 5545).
      const made = expandRecurringEvents([series([rule], true)], format(anchor, LOCAL), format(from, LOCAL)).length;
      if (made >= rule.count) continue;
    }
    return { kind: "unknown" };
  }
  return { kind: "ended" };
}

/** The day of a repeating task's next occurrence, or null when there is none to tell. */
export function nextOccurrenceDay(task: TaskTimes, now: Date): Date | null {
  const next = nextOccurrence(task, now);
  return next.kind === "next" ? startOfDay(next.due) : null;
}

/** When a task is due as the list shows it: its due date-time, a repeating one's next occurrence's. */
export function taskListDue(task: TaskTimes, now: Date): Date | null {
  if (!isRecurringTask(task)) return parseDate(task.due);
  const next = nextOccurrence(task, now);
  return next.kind === "next" ? next.due : null;
}

/** The day a task stands at in the list: its due day, a repeating one's next occurrence. */
export function taskListDay(task: TaskTimes, now: Date): Date | null {
  return isRecurringTask(task) ? nextOccurrenceDay(task, now) : followUpDueDay(task);
}

/** Where a task stands in the list. */
export function taskListGroupOf(
  task: TaskTimes & Pick<CalendarTask, "progress">,
  now: Date,
  firstDayOfWeek = 1,
): TaskListGroup {
  if (!isOpenTask(task)) return "done";
  if (isRecurringTask(task)) {
    const next = nextOccurrence(task, now);
    // A series that may still run but whose next time cannot be told: later, never "no date".
    if (next.kind === "unknown") return "later";
    if (next.kind === "ended") return "no-date";
    return upcomingGroupOf(next.due, now, firstDayOfWeek);
  }
  const day = followUpDueDay(task);
  if (!day) return "no-date";
  return upcomingGroupOf(day, now, firstDayOfWeek);
}

/** The user and the group lists, which decide what is theirs. */
export interface TaskListContext {
  /** The user's own addresses, lower case. */
  mine: ReadonlySet<string>;
  /** The group mailboxes' task lists the app recognised: the account and its list's calendar id. */
  groupLists: readonly { accountId: string; listId: string }[];
  /** The calendars the sidebar shows (scope `all`). */
  selectedCalendarIds: readonly string[];
}

/**
 * The tasks of the task store and of the group lists' store as one list,
 * each once. A task both hold (the calendar reads every calendar, group
 * lists too) is taken from the group lists' store when it lies in a group
 * list, else from the task store: every write made here updates both (the
 * group ones through hooks/use-group-follow-ups.ts), so the store that owns
 * the list is current, and no client clock is weighed against the server's.
 */
export function mergeTaskSources(
  tasks: readonly CalendarTask[],
  groupTasks: readonly CalendarTask[],
  groupListIds: ReadonlySet<string>,
): CalendarTask[] {
  const byId = new Map<string, CalendarTask>();
  for (const task of tasks) byId.set(task.id, task);
  for (const task of groupTasks) {
    if (!byId.has(task.id) || isInGroupList(task, groupListIds)) byId.set(task.id, task);
  }
  return [...byId.values()];
}

/** Whether a task is the user's: of their own account, or a group list's task for them. */
export function isMyTask(task: CalendarTask, context: TaskListContext): boolean {
  if (!task.isShared) return true;
  const groupListIds = new Set(context.groupLists.map((l) => l.listId));
  return isGroupFollowUpTask(task, groupListIds) && isTaskForMe(task, context.mine);
}

/** The tasks a scope holds, before the status filter. */
export function tasksInScope(tasks: readonly CalendarTask[], scope: TaskListScope, context: TaskListContext): CalendarTask[] {
  const group = scopeGroupAccount(scope);
  if (group !== null) {
    const listIds = new Set(context.groupLists.filter((l) => l.accountId === group).map((l) => l.listId));
    return tasks.filter((task) => isInGroupList(task, listIds));
  }
  switch (scope) {
    case "mine":
      return tasks.filter((task) => isMyTask(task, context));
    case "follow-ups":
      return tasks.filter((task) => isMyTask(task, context) && !!followUpMailRef(task));
    case "reminders":
      return tasks.filter((task) => isMyTask(task, context) && !followUpMailRef(task));
    default: {
      const selected = new Set(context.selectedCalendarIds);
      return tasks.filter((task) => Object.keys(task.calendarIds ?? {}).some((id) => selected.has(id)));
    }
  }
}

/** The status filter and "show completed", as the list always applied them. */
export function tasksByStatus(
  tasks: readonly CalendarTask[],
  filter: TaskViewFilter,
  showCompleted: boolean,
  now: Date,
  firstDayOfWeek = 1,
): CalendarTask[] {
  switch (filter) {
    case "pending":
      return tasks.filter((task) => task.progress === "needs-action" || task.progress === "in-process");
    case "completed":
      return tasks.filter((task) => task.progress === "completed");
    case "overdue":
      return tasks.filter((task) => taskListGroupOf(task, now, firstDayOfWeek) === "overdue");
    default:
      return showCompleted ? [...tasks] : tasks.filter(isOpenTask);
  }
}

export interface TaskListSection {
  group: TaskListGroup;
  tasks: CalendarTask[];
}

/**
 * The list's sections, those that hold a task, in `TASK_LIST_GROUPS`' order.
 * Within one: by due date-time, then the reminder, then the priority (1 first, none
 * last), then the title; done ones the latest done first.
 */
export function taskListSections(tasks: readonly CalendarTask[], now: Date, firstDayOfWeek = 1): TaskListSection[] {
  const byGroup = new Map<TaskListGroup, { task: CalendarTask; day: number }[]>();
  for (const task of tasks) {
    const group = taskListGroupOf(task, now, firstDayOfWeek);
    const list = byGroup.get(group) ?? [];
    list.push({ task, day: group === "done" ? 0 : taskListDue(task, now)?.getTime() ?? Infinity });
    byGroup.set(group, list);
  }
  return TASK_LIST_GROUPS
    .filter((group) => byGroup.has(group))
    .map((group) => {
      const entries = [...(byGroup.get(group) ?? [])];
      entries.sort(group === "done" ? (a, b) => compareDone(a.task, b.task) : compareOpen);
      return { group, tasks: entries.map((e) => e.task) };
    });
}

function compareOpen(a: { task: CalendarTask; day: number }, b: { task: CalendarTask; day: number }): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  const remA = followUpReminder(a.task)?.getTime() ?? Infinity;
  const remB = followUpReminder(b.task)?.getTime() ?? Infinity;
  if (remA !== remB) return remA < remB ? -1 : 1;
  const priA = a.task.priority || 10;
  const priB = b.task.priority || 10;
  if (priA !== priB) return priA - priB;
  return (a.task.title ?? "").localeCompare(b.task.title ?? "");
}

function compareDone(a: CalendarTask, b: CalendarTask): number {
  const when = (t: CalendarTask) => Date.parse(t.progressUpdated ?? t.updated ?? "") || 0;
  const diff = when(b) - when(a);
  return diff !== 0 ? diff : (a.title ?? "").localeCompare(b.title ?? "");
}

export interface TaskListInput extends TaskListContext {
  tasks: readonly CalendarTask[];
  scope: TaskListScope;
  filter: TaskViewFilter;
  showCompleted: boolean;
  now: Date;
  firstDayOfWeek?: number;
}

/** The list as it shows: the scope's tasks, filtered, in sections. */
export function taskList(input: TaskListInput): TaskListSection[] {
  const inScope = tasksInScope(input.tasks, input.scope, input);
  const shown = tasksByStatus(inScope, input.filter, input.showCompleted, input.now, input.firstDayOfWeek);
  return taskListSections(shown, input.now, input.firstDayOfWeek);
}
