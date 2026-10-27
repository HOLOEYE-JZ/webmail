import { describe, expect, it } from 'vitest';
import {
  groupScope,
  mergeTaskSources,
  nextOccurrence,
  nextOccurrenceDay,
  scopeGroupAccount,
  taskList,
  taskListGroupOf,
  tasksByStatus,
  tasksInScope,
  type TaskListContext,
} from '@/lib/task-list';
import { buildFollowUpTask, buildReminderTask } from '@/lib/follow-ups';
import type { CalendarRecurrenceRule, CalendarTask } from '@/lib/jmap/types';

// Wednesday 28.10.2026, 10:30 on the wall clock; weeks start on Monday.
const NOW = new Date(2026, 9, 28, 10, 30);
const day = (d: number, month = 9) => new Date(2026, month, d);

function stored(task: Partial<CalendarTask>, id: string, over: Partial<CalendarTask> = {}): CalendarTask {
  return { uid: id, updated: '2026-10-26T08:00:00Z', priority: 0, ...task, id, ...over } as CalendarTask;
}

const reminder = (id: string, due: Date | null, over: Partial<CalendarTask> = {}) =>
  stored(buildReminderTask({ title: id, calendarId: 'tasks', due, reminderAt: null }), id, over);

const followUp = (id: string, due: Date | null, over: Partial<CalendarTask> = {}) => stored(buildFollowUpTask({
  title: 'Call: Offer 4711',
  mailUrl: 'https://host/mail/message/M1',
  subject: 'Offer 4711',
  from: { name: 'Lena Brandt', email: 'lena@example.com' },
  calendarId: 'tasks',
  due,
  reminderAt: null,
}), id, over);

const owner = (email: string) => ({
  for: { '@type': 'Participant', name: email, calendarAddress: `mailto:${email}`, roles: { owner: true } } as never,
});

/** A task of the group's list `grp:b`, for `email` (none: for nobody). */
const groupTask = (id: string, due: Date | null, email: string | null, over: Partial<CalendarTask> = {}) =>
  reminder(id, due, {
    calendarIds: { 'grp:b': true },
    isShared: true,
    accountId: 'grp',
    ...(email ? { participants: owner(email) } : {}),
    ...over,
  });

const weekly: CalendarRecurrenceRule = { '@type': 'RecurrenceRule', frequency: 'weekly' } as CalendarRecurrenceRule;
const daily: CalendarRecurrenceRule = { '@type': 'RecurrenceRule', frequency: 'daily' } as CalendarRecurrenceRule;

const context: TaskListContext = {
  mine: new Set(['me@example.com']),
  groupLists: [{ accountId: 'grp', listId: 'grp:b' }],
  selectedCalendarIds: ['tasks'],
};

describe('taskListGroupOf', () => {
  it('groups by the due day: overdue, today, tomorrow, this week, later, no date, done', () => {
    const groupOf = (task: CalendarTask) => taskListGroupOf(task, NOW, 1);
    expect(groupOf(reminder('a', day(27)))).toBe('overdue');
    expect(groupOf(reminder('b', day(28)))).toBe('today');
    expect(groupOf(reminder('c', day(29)))).toBe('tomorrow');
    expect(groupOf(reminder('d', day(1, 10)))).toBe('this-week'); // Sunday
    expect(groupOf(reminder('e', day(2, 10)))).toBe('later'); // next Monday
    expect(groupOf(reminder('f', null))).toBe('no-date');
    expect(groupOf(reminder('g', day(27), { progress: 'completed' }))).toBe('done');
    expect(groupOf(reminder('h', null, { progress: 'cancelled' }))).toBe('done');
  });

  it('puts a repeating task at its next occurrence, never overdue', () => {
    // Weekly since a Monday long ago: next Monday.
    expect(taskListGroupOf(reminder('w', day(5), { recurrenceRules: [weekly] }), NOW, 1)).toBe('later');
    // Weekly since a Thursday: tomorrow.
    expect(taskListGroupOf(reminder('t', day(1), { recurrenceRules: [weekly] }), NOW, 1)).toBe('tomorrow');
    // Daily: today, as Stalwart names its rule too.
    const stalwart = reminder('d', new Date(2025, 0, 1)) as CalendarTask & { recurrenceRule?: unknown };
    stalwart.recurrenceRule = daily;
    expect(taskListGroupOf(stalwart, NOW, 1)).toBe('today');
  });

  it('puts a series with nothing to come under no date', () => {
    const ended = reminder('x', day(1), { recurrenceRules: [{ ...weekly, count: 2 }] });
    expect(nextOccurrenceDay(ended, NOW)).toBeNull();
    expect(taskListGroupOf(ended, NOW, 1)).toBe('no-date');
  });
});

describe('tasksInScope', () => {
  const own = reminder('own', day(28));
  const otherOwnList = reminder('private', day(28), { calendarIds: { private: true } });
  const mail = followUp('mail', day(29));
  const forMe = groupTask('for-me', day(28), 'me@example.com');
  const forAnna = groupTask('for-anna', day(28), 'anna@example.com');
  const forNobody = groupTask('for-nobody', day(28), null);
  const colleague = reminder('colleague', day(28), { calendarIds: { 'anna:cal': true }, isShared: true, participants: owner('me@example.com') });
  const all = [own, otherOwnList, mail, forMe, forAnna, forNobody, colleague];
  const ids = (scope: Parameters<typeof tasksInScope>[1]) => tasksInScope(all, scope, context).map((t) => t.id);

  it('for me: every task of the own account and the group tasks for me', () => {
    expect(ids('mine')).toEqual(['own', 'private', 'mail', 'for-me']);
  });

  it('follow-ups are the ones on a mail, reminders the others', () => {
    expect(ids('follow-ups')).toEqual(['mail']);
    expect(ids('reminders')).toEqual(['own', 'private', 'for-me']);
  });

  it("a group's scope is everything in its list, whoever it is for", () => {
    expect(ids(groupScope('grp'))).toEqual(['for-me', 'for-anna', 'for-nobody']);
    expect(ids(groupScope('other'))).toEqual([]);
    expect(scopeGroupAccount(groupScope('grp'))).toBe('grp');
    expect(scopeGroupAccount('mine')).toBeNull();
  });

  it('all: the calendars shown, as before', () => {
    expect(ids('all')).toEqual(['own', 'mail']);
  });
});

describe('tasksByStatus', () => {
  const tasks = [
    reminder('open', day(30)),
    reminder('late', day(26)),
    reminder('done', day(26), { progress: 'completed' }),
    reminder('cancelled', day(26), { progress: 'cancelled' }),
    reminder('series', day(5), { recurrenceRules: [weekly] }),
  ];
  const ids = (filter: Parameters<typeof tasksByStatus>[1], showCompleted: boolean) =>
    tasksByStatus(tasks, filter, showCompleted, NOW, 1).map((t) => t.id);

  it('shows the open ones, all with "show completed"', () => {
    expect(ids('all', false)).toEqual(['open', 'late', 'series']);
    expect(ids('all', true)).toEqual(['open', 'late', 'done', 'cancelled', 'series']);
  });

  it('asking for the completed ones shows them whatever "show completed" says', () => {
    expect(ids('completed', false)).toEqual(['done']);
  });

  it('overdue leaves a repeating task out', () => {
    expect(ids('overdue', false)).toEqual(['late']);
  });
});

describe('taskList', () => {
  it('lists the sections in order, sorted by day, reminder, priority and title, done ones the latest first', () => {
    const sections = taskList({
      ...context,
      tasks: [
        reminder('later', day(20, 10)),
        reminder('b', day(28)),
        reminder('a', day(28)),
        reminder('urgent', day(28), { priority: 1 }),
        reminder('early', day(28), {
          alerts: { 'follow-up': { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(2026, 9, 28, 8).toISOString() } } as never },
        }),
        reminder('none', null),
        reminder('done-old', day(1), { progress: 'completed', progressUpdated: '2026-10-01T10:00:00Z' }),
        reminder('done-new', day(1), { progress: 'completed', progressUpdated: '2026-10-20T10:00:00Z' }),
      ],
      scope: 'mine',
      filter: 'all',
      showCompleted: true,
      now: NOW,
      firstDayOfWeek: 1,
    });
    expect(sections.map((s) => [s.group, s.tasks.map((t) => t.id)])).toEqual([
      ['today', ['early', 'urgent', 'a', 'b']],
      ['later', ['later']],
      ['no-date', ['none']],
      ['done', ['done-new', 'done-old']],
    ]);
  });
});

describe('mergeTaskSources', () => {
  it("keeps each task once: a group list's from the group store, any other from the task store", () => {
    const inTaskStore = groupTask('g', day(28), 'me@example.com', { updated: '2026-10-27T08:00:00Z', title: 'task store' });
    const inGroupStore = { ...inTaskStore, updated: '2026-10-20T08:00:00Z', title: 'group store' };
    const onlyGroup = groupTask('created', day(28), 'me@example.com');
    const own = reminder('own', null);
    const listIds = new Set(['grp:b']);
    expect(mergeTaskSources([inTaskStore, own], [inGroupStore, onlyGroup, { ...own, title: 'other' }], listIds).map((t) => [t.id, t.title]))
      .toEqual([['g', 'group store'], ['own', 'own'], ['created', 'created']]);
  });
});

describe('nextOccurrence', () => {
  const weeklyOn = (day: string, over: Partial<CalendarRecurrenceRule> = {}) =>
    ({ '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day }], ...over }) as CalendarRecurrenceRule;

  it('counts from the start and keeps the due date as far after it', () => {
    // Starts Mondays 09:00, due two days later (Wednesday 17:00).
    const task = reminder('s', null, {
      start: '2026-10-05T09:00:00', due: '2026-10-07T17:00:00', showWithoutTime: false, recurrenceRules: [weeklyOn('mo')],
    });
    // Wednesday 28.10.: the occurrence of Monday 26.10. is due today at 17:00.
    expect(nextOccurrence(task, NOW)).toEqual({ kind: 'next', due: new Date(2026, 9, 28, 17, 0) });
    expect(taskListGroupOf(task, NOW, 1)).toBe('today');
  });

  it("leaves an excluded occurrence out and takes a moved one's own due date", () => {
    const base = { start: '2026-10-01T00:00:00', due: '2026-10-01T00:00:00', recurrenceRules: [weekly] };
    const excluded = reminder('x', null, { ...base, recurrenceOverrides: { '2026-10-29T00:00:00': { excluded: true } } } as never);
    expect(nextOccurrence(excluded, NOW)).toEqual({ kind: 'next', due: day(5, 10) });
    const moved = reminder('m', null, { ...base, recurrenceOverrides: { '2026-10-29T00:00:00': { due: '2026-11-03T00:00:00' } } } as never);
    expect(nextOccurrence(moved, NOW)).toEqual({ kind: 'next', due: day(3, 10) });
  });

  it('ends at UNTIL and after COUNT', () => {
    expect(nextOccurrence(reminder('u', day(1), { recurrenceRules: [{ ...weekly, until: '2026-10-20T00:00:00' }] }), NOW)).toEqual({ kind: 'ended' });
    expect(nextOccurrence(reminder('u2', day(1), { recurrenceRules: [{ ...weekly, until: '2026-11-30T00:00:00' }] }), NOW)).toEqual({ kind: 'next', due: day(29) });
    expect(nextOccurrence(reminder('c', day(1), { recurrenceRules: [{ ...weekly, count: 2 }] }), NOW)).toEqual({ kind: 'ended' });
  });

  it('takes a COUNT series begun too long ago to count as still running: later, not without a date', () => {
    const old = reminder('old', new Date(2015, 0, 1), { recurrenceRules: [{ ...daily, count: 10000 }] });
    // The expansion gives up after 2,000 steps from 2015: it cannot tell the next one.
    expect(nextOccurrence(old, NOW)).toEqual({ kind: 'unknown' });
    expect(taskListGroupOf(old, NOW, 1)).toBe('later');
  });
});
