import { describe, it, expect } from 'vitest';
import { parseISO } from 'date-fns';
import { dueTaskCount, upcomingGroupOf, upcomingTasks } from '../upcoming-tasks';
import {
  buildFollowUpTask,
  buildReminderTask,
  editFollowUpTask,
  editReminderTask,
  followUpNote,
  followUpsByEmailId,
} from '../follow-ups';
import { planFollowUpSync } from '@/lib/follow-up-sync';
import { proposedReminder } from '@/lib/follow-up-schedule';
import type { CalendarTask } from '@/lib/jmap/types';

// Display dates: local fields are the user's wall clock. 28.10.2026 is a Wednesday.
const at = (day: number, hour = 0, minute = 0, month = 10) => new Date(2026, month - 1, day, hour, minute);
const NOW = at(28, 10, 30);
const OWN = new Set(['tasks']);

let seq = 0;
function task(over: Partial<CalendarTask> = {}): CalendarTask {
  seq += 1;
  return {
    id: `t${seq}`,
    calendarIds: { tasks: true },
    '@type': 'Task',
    uid: `u${seq}`,
    title: `Task ${seq}`,
    description: '',
    due: null,
    start: null,
    duration: null,
    timeZone: null,
    showWithoutTime: true,
    progress: 'needs-action',
    priority: 0,
    privacy: 'public',
    keywords: null,
    categories: null,
    color: null,
    created: null,
    updated: null,
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
    links: null,
    ...over,
  } as CalendarTask;
}
const day = (text: string | null) => (text ? parseISO(text) : null);
const due = (day: number, month = 10) => `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;

describe('upcomingGroupOf', () => {
  it('sorts by the due day: overdue, today, tomorrow, this week, later', () => {
    expect(upcomingGroupOf(day(due(27)), NOW)).toBe('overdue');
    expect(upcomingGroupOf(day(due(20)), NOW)).toBe('overdue');
    expect(upcomingGroupOf(day(due(28)), NOW)).toBe('today');
    expect(upcomingGroupOf(day('2026-10-28T15:00:00'), NOW)).toBe('today');
    expect(upcomingGroupOf(day(due(29)), NOW)).toBe('tomorrow');
    expect(upcomingGroupOf(day(due(30)), NOW)).toBe('this-week');
    // The week ends on Sunday when it starts on Monday.
    expect(upcomingGroupOf(day(due(1, 11)), NOW)).toBe('this-week');
    expect(upcomingGroupOf(day(due(2, 11)), NOW)).toBe('later');
    expect(upcomingGroupOf(day(null), NOW)).toBe('later');
  });

  it('follows the first day of the week', () => {
    // A week from Sunday ends on Saturday.
    expect(upcomingGroupOf(day(due(31)), NOW, 0)).toBe('this-week');
    expect(upcomingGroupOf(day(due(1, 11)), NOW, 0)).toBe('later');
  });

  it('keeps tomorrow apart even when it is in the next week', () => {
    const sunday = at(1, 9, 0, 11);
    expect(upcomingGroupOf(day(due(2, 11)), sunday)).toBe('tomorrow');
    expect(upcomingGroupOf(day(due(3, 11)), sunday)).toBe('later');
  });
});

describe('upcomingTasks', () => {
  it('lists the open tasks of the own task list by group and counts the rest', () => {
    const late = task({ due: due(26) });
    const today = task({ due: due(28) });
    const tomorrow = task({ due: due(29) });
    const week = task({ due: due(30) });
    const list = upcomingTasks([
      week, tomorrow, today, late,
      task({ due: due(10, 11) }),
      task({ due: null }),
      task({ due: due(28), progress: 'completed' }),
      task({ due: due(28), progress: 'cancelled' }),
      task({ due: due(28), calendarIds: { other: true } }),
      task({ due: due(28), isShared: true }),
    ], OWN, NOW);
    expect(list.groups.map((g) => [g.group, g.tasks.map((t) => t.id)])).toEqual([
      ['overdue', [late.id]],
      ['today', [today.id]],
      ['tomorrow', [tomorrow.id]],
      ['this-week', [week.id]],
    ]);
    expect(list.later).toBe(2);
  });

  it('leaves out empty groups', () => {
    const list = upcomingTasks([task({ due: due(29) })], OWN, NOW);
    expect(list.groups.map((g) => g.group)).toEqual(['tomorrow']);
    expect(list.later).toBe(0);
  });

  it('orders a group by due day, then reminder, then title', () => {
    const alertAt = (hour: number) => ({
      r: { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: at(28, hour).toISOString() }, action: 'display', acknowledged: null, relatedTo: null },
    }) as CalendarTask['alerts'];
    const older = task({ title: 'Z', due: due(20) });
    const newer = task({ title: 'A', due: due(25) });
    const b = task({ title: 'B', due: due(28) });
    const a = task({ title: 'A', due: due(28) });
    const early = task({ title: 'Y', due: due(28), alerts: alertAt(9) });
    const late = task({ title: 'X', due: due(28), alerts: alertAt(15) });
    const list = upcomingTasks([newer, b, late, a, older, early], OWN, NOW);
    expect(list.groups[0].tasks.map((t) => t.title)).toEqual(['Z', 'A']);
    expect(list.groups[1].tasks.map((t) => t.title)).toEqual(['Y', 'X', 'A', 'B']);
  });
});

describe('dueTaskCount', () => {
  it('counts the open tasks of the own list due today or earlier', () => {
    expect(dueTaskCount([
      task({ due: due(20) }),
      task({ due: due(28) }),
      task({ due: '2026-10-28T18:00:00' }),
      task({ due: due(29) }),
      task({ due: null }),
      task({ due: due(20), progress: 'completed' }),
      task({ due: due(20), calendarIds: { other: true } }),
    ], OWN, NOW)).toBe(3);
  });
});

describe('a reminder without a mail', () => {
  it('is a task due that day with its alert and note, and no link', () => {
    const written = buildReminderTask({
      title: '  Check the dunning run ',
      calendarId: 'tasks',
      due: at(28),
      reminderAt: new Date('2026-10-28T13:00:00Z'),
      note: ' after lunch ',
    });
    expect(written).toMatchObject({
      '@type': 'Task',
      title: 'Check the dunning run',
      calendarIds: { tasks: true },
      due: '2026-10-28T00:00:00',
      showWithoutTime: true,
      progress: 'needs-action',
      description: 'after lunch',
    });
    expect(written.alerts?.['follow-up']?.trigger).toEqual({ '@type': 'AbsoluteTrigger', when: '2026-10-28T13:00:00Z' });
    expect(written.links).toBeUndefined();
    expect(written.relatedTo).toBeUndefined();
  });

  it('is never touched by the check that keeps flags and follow-ups in step', () => {
    const reminder = task({ ...buildReminderTask({ title: 'Call back', calendarId: 'tasks', due: at(28), reminderAt: null }), id: 'r1' });
    const followUp = task({
      ...buildFollowUpTask({ title: 'Follow up: Offer', mailUrl: 'https://host/mail/message/M1', calendarId: 'tasks', due: at(28), reminderAt: null }),
      id: 'f1',
    });
    const index = followUpsByEmailId([reminder, followUp]);
    expect([...index.values()].map((t) => t.id)).toEqual(['f1']);
    // Not even a remembered entry for it: it has no mail to flag.
    const plan = planFollowUpSync({
      tasks: [],
      present: new Set(['r1']),
      listed: () => true,
      flags: new Map(),
      mirror: {},
    });
    expect(plan.actions).toEqual([]);
  });

  describe('proposedReminder', () => {
    it('on a due day begun: the next full hour while the workday lasts', () => {
      expect(proposedReminder(at(28), at(28, 10, 30))).toEqual(at(28, 11));
    });

    it('on a due day not begun yet: the start of work', () => {
      expect(proposedReminder(at(28), at(28, 6, 15))).toEqual(at(28, 8));
      expect(proposedReminder(at(30), at(28, 10, 30))).toEqual(at(30, 8));
    });

    it('after the workday, or without a due day: the next working day', () => {
      expect(proposedReminder(at(28), at(28, 16, 10))).toEqual(at(29, 8));
      expect(proposedReminder(null, at(28, 10, 30))).toEqual(at(29, 8));
      // Friday evening: Monday.
      expect(proposedReminder(at(30), at(30, 18))).toEqual(at(2, 8, 0, 11));
    });
  });

  describe('editReminderTask', () => {
    const base = task({ title: 'Call back', due: '2026-10-28T14:30:00', showWithoutTime: false });

    it('keeps a due time set in the task list while the day stays', () => {
      const patch = editReminderTask(base, { title: null, due: at(28), reminderAt: null, note: 'ask for Anna' });
      expect(patch).not.toHaveProperty('due');
      expect(patch).not.toHaveProperty('showWithoutTime');
      expect(patch.description).toBe('ask for Anna');
    });

    it('writes another day with the same time', () => {
      const patch = editReminderTask(base, { title: 'Call back Anna', due: at(29), reminderAt: null, note: '' });
      expect(patch).toMatchObject({ due: '2026-10-29T14:30:00', title: 'Call back Anna' });
      expect(patch).not.toHaveProperty('showWithoutTime');
    });

    it('clears the due day', () => {
      expect(editReminderTask(base, { title: null, due: null, reminderAt: null, note: '' }).due).toBeNull();
    });
  });
});

describe('a task with a time of day', () => {
  const relative = {
    before: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display', acknowledged: null, relatedTo: null },
  } as unknown as CalendarTask['alerts'];
  const timed = task({ title: 'Call back', due: '2026-10-28T14:30:00', showWithoutTime: false, alerts: relative });

  it('keeps its time on another day, so a relative alert still comes before it', () => {
    for (const patch of [
      editReminderTask(timed, { title: null, due: at(30), reminderAt: null, note: '' }),
      editFollowUpTask(timed, { title: null, due: at(30), reminderAt: null, note: '' }),
    ]) {
      expect(patch.due).toBe('2026-10-30T14:30:00');
      expect(patch).not.toHaveProperty('showWithoutTime');
      // The relative alert is not the reminder the dialog shows: untouched.
      expect(patch).not.toHaveProperty('alerts');
    }
  });

  it('a whole-day task stays a whole day', () => {
    const patch = editFollowUpTask(task({ due: due(28) }), { title: null, due: at(30), reminderAt: null, note: '' });
    expect(patch).toMatchObject({ due: '2026-10-30T00:00:00', showWithoutTime: true });
  });
});

describe('a repeating task', () => {
  const daily = (over: Partial<CalendarTask> = {}) => task({
    due: due(20),
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }] as unknown as CalendarTask['recurrenceRules'],
    ...over,
  });

  it('is only counted as later, never overdue, and never in the badge', () => {
    const list = upcomingTasks([daily(), task({ due: due(28) })], OWN, NOW);
    expect(list.groups.map((g) => [g.group, g.tasks.length])).toEqual([['today', 1]]);
    expect(list.later).toBe(1);
    expect(dueTaskCount([daily()], OWN, NOW)).toBe(0);
  });

  it('as Stalwart names its rule, too', () => {
    const stalwart = { ...daily({ recurrenceRules: null }), recurrenceRule: { frequency: 'weekly' } } as CalendarTask;
    expect(upcomingTasks([stalwart], OWN, NOW)).toEqual({ groups: [], later: 1 });
    expect(dueTaskCount([stalwart], OWN, NOW)).toBe(0);
  });

  it('never gets its due day moved from the dialog', () => {
    const patch = editReminderTask(daily(), { title: null, due: at(30), reminderAt: null, note: 'x' });
    expect(patch).not.toHaveProperty('due');
    expect(patch.description).toBe('x');
  });
});

describe('an HTML note', () => {
  const html = task({ description: '<p>Ask <b>Anna</b></p><script>alert(1)</script><p>about the &amp; offer</p>', descriptionContentType: 'text/html' });

  it('is read as text, its markup and scripts not shown', () => {
    const text = followUpNote(html);
    expect(text).toContain('Ask Anna');
    expect(text).toContain('about the & offer');
    expect(text).not.toMatch(/<|alert/);
  });

  it('is never written back as text', () => {
    const patch = editFollowUpTask(html, { title: null, due: null, reminderAt: null, note: 'something else' });
    expect(patch).not.toHaveProperty('description');
  });

  it('a plain note is the description as it is', () => {
    expect(followUpNote(task({ description: ' <b>literal</b> ' }))).toBe('<b>literal</b>');
  });
});
