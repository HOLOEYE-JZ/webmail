import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKING_TIME,
  buildFollowUpTask,
  dueDistance,
  followUpMailRef,
  followUpReminder,
  followUpState,
  followUpsByEmailId,
  rescheduleFollowUpTask,
  scheduleFollowUp,
  threadFollowUpEmail,
  type FollowUpChoice,
  type WorkingTime,
} from '../follow-ups';
import type { CalendarTask } from '@/lib/jmap/types';

// Display dates: local fields are the user's wall clock. 26.10.2026 is a Monday.
const at = (day: number, hour = 0, minute = 0, month = 10) => new Date(2026, month - 1, day, hour, minute);

function schedule(choice: FollowUpChoice, now: Date, work?: WorkingTime) {
  const { due, reminder } = scheduleFollowUp(choice, now, work);
  return { due: due?.toString() ?? null, reminder: reminder?.toString() ?? null };
}

const expected = (due: Date | null, reminder: Date | null) => ({
  due: due?.toString() ?? null,
  reminder: reminder?.toString() ?? null,
});

describe('scheduleFollowUp', () => {
  describe('on a Monday morning with the default working time (08:00-17:00, Mon-Fri)', () => {
    const now = at(26, 7, 55);

    it('Today: due today, reminded an hour before the workday ends', () => {
      expect(schedule('today', now)).toEqual(expected(at(26), at(26, 16)));
    });

    it('Tomorrow: due tomorrow, reminded when the workday starts', () => {
      expect(schedule('tomorrow', now)).toEqual(expected(at(27), at(27, 8)));
    });

    it('This week: due Friday, reminded two workdays on', () => {
      expect(schedule('this-week', now)).toEqual(expected(at(30), at(28, 8)));
    });

    it('Next week: due next Friday, reminded next Monday morning', () => {
      expect(schedule('next-week', now)).toEqual(expected(at(6, 0, 0, 11), at(2, 8, 0, 11)));
    });

    it('No date: neither a due day nor a reminder', () => {
      expect(schedule('no-date', now)).toEqual(expected(null, null));
    });
  });

  it('leaves out a Today reminder that already passed', () => {
    expect(schedule('today', at(26, 16, 30))).toEqual(expected(at(26), null));
  });

  it('Tomorrow on a Friday is Monday', () => {
    expect(schedule('tomorrow', at(30, 10))).toEqual(expected(at(2, 0, 0, 11), at(2, 8, 0, 11)));
  });

  it('This week on a Thursday reminds on Friday, never after the due day', () => {
    expect(schedule('this-week', at(29, 7))).toEqual(expected(at(30), at(30, 8)));
  });

  it('This week on the last workday is due today, its reminder dropped once the day has started', () => {
    expect(schedule('this-week', at(30, 7))).toEqual(expected(at(30), at(30, 8)));
    expect(schedule('this-week', at(30, 10))).toEqual(expected(at(30), null));
  });

  it('This week on a weekend is due today, the week\'s workdays being over', () => {
    expect(schedule('this-week', at(31, 10))).toEqual(expected(at(31), null));
    expect(schedule('this-week', at(1, 10, 0, 11))).toEqual(expected(at(1, 0, 0, 11), null));
  });

  it('Next week on a weekend is the coming week', () => {
    expect(schedule('next-week', at(31, 10))).toEqual(expected(at(6, 0, 0, 11), at(2, 8, 0, 11)));
    expect(schedule('next-week', at(1, 10, 0, 11))).toEqual(expected(at(6, 0, 0, 11), at(2, 8, 0, 11)));
  });

  it('Today on a weekend is still today', () => {
    expect(schedule('today', at(31, 10))).toEqual(expected(at(31), at(31, 16)));
  });

  it('follows the working hours and days', () => {
    // 09:00-18:00, Sunday to Thursday, weeks from Sunday. 25.10. is a Sunday.
    const work: WorkingTime = { startHour: 9, endHour: 18, workingDays: [0, 1, 2, 3, 4], firstDayOfWeek: 0 };
    const now = at(25, 7);
    expect(schedule('today', now, work)).toEqual(expected(at(25), at(25, 17)));
    expect(schedule('tomorrow', now, work)).toEqual(expected(at(26), at(26, 9)));
    expect(schedule('this-week', now, work)).toEqual(expected(at(29), at(27, 9)));
    expect(schedule('next-week', now, work)).toEqual(expected(at(5, 0, 0, 11), at(1, 9, 0, 11)));
    // Thursday is the last workday: Tomorrow skips the weekend.
    expect(schedule('tomorrow', at(29, 12), work)).toEqual(expected(at(1, 0, 0, 11), at(1, 9, 0, 11)));
  });

  it('takes the week from the first day of the week', () => {
    // Weeks from Sunday: on Sunday 25.10. "this week" is 25.-31.10.
    const work = { ...DEFAULT_WORKING_TIME, firstDayOfWeek: 0 };
    expect(schedule('this-week', at(25, 10), work)).toEqual(expected(at(30), at(27, 8)));
    expect(schedule('next-week', at(25, 10), work)).toEqual(expected(at(6, 0, 0, 11), at(2, 8, 0, 11)));
  });

  it('falls back to Monday to Friday without working days', () => {
    const work = { ...DEFAULT_WORKING_TIME, workingDays: [] };
    expect(schedule('tomorrow', at(30, 10), work)).toEqual(expected(at(2, 0, 0, 11), at(2, 8, 0, 11)));
  });

  it('crosses a month and a year', () => {
    // 31.12.2026 is a Thursday.
    const now = new Date(2026, 11, 31, 9);
    const { due, reminder } = scheduleFollowUp('next-week', now);
    expect(due).toEqual(new Date(2027, 0, 8));
    expect(reminder).toEqual(new Date(2027, 0, 4, 8));
  });
});

describe('buildFollowUpTask', () => {
  it('writes the title, the due day, the reminder, the link and the Message-ID', () => {
    const task = buildFollowUpTask({
      title: 'Follow up: Offer 4711',
      mailUrl: 'https://mail.example.com/mail/message/M123',
      subject: 'Offer 4711',
      messageId: ['abc@example.com'],
      calendarId: 'cal-tasks',
      due: at(30),
      reminderAt: new Date('2026-10-28T07:00:00.000Z'),
    });

    expect(task).toEqual({
      '@type': 'Task',
      title: 'Follow up: Offer 4711',
      calendarIds: { 'cal-tasks': true },
      due: '2026-10-30T00:00:00',
      showWithoutTime: true,
      progress: 'needs-action',
      alerts: {
        'follow-up': {
          '@type': 'Alert',
          trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-28T07:00:00Z' },
          action: 'display',
          acknowledged: null,
          relatedTo: null,
        },
      },
      links: {
        mail: {
          '@type': 'Link',
          href: 'https://mail.example.com/mail/message/M123',
          cid: null,
          contentType: null,
          size: null,
          rel: 'describedby',
          display: null,
          title: 'Offer 4711',
        },
      },
      relatedTo: { '<abc@example.com>': { '@type': 'Relation', relation: { parent: true } } },
    });
  });

  it('writes neither due day nor reminder for No date, and no relation without a Message-ID', () => {
    const task = buildFollowUpTask({
      title: 'Follow up: (no subject)',
      mailUrl: '/mail/message/M1',
      calendarId: 'c',
      due: null,
      reminderAt: null,
    });
    expect(task.due).toBeNull();
    expect(task.alerts).toBeNull();
    expect(task.relatedTo).toBeNull();
    expect(task.links?.mail.title).toBeNull();
  });

  it('keeps a Message-ID given with brackets once', () => {
    const task = buildFollowUpTask({
      title: 't', mailUrl: '/mail/message/M1', calendarId: 'c', due: null, reminderAt: null,
      messageId: '<x@y>',
    });
    expect(Object.keys(task.relatedTo ?? {})).toEqual(['<x@y>']);
  });
});

describe('rescheduleFollowUpTask', () => {
  it('sets the new day and reminder and opens the task again', () => {
    expect(rescheduleFollowUpTask(at(27), null)).toEqual({
      due: '2026-10-27T00:00:00',
      showWithoutTime: true,
      progress: 'needs-action',
      alerts: null,
    });
  });
});

function makeTask(id: string, overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id,
    calendarIds: { c: true },
    '@type': 'Task',
    uid: id,
    title: 'Follow up: ' + id,
    description: '',
    due: '2026-10-30T00:00:00',
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
    updated: '2026-10-26T00:00:00Z',
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
    ...overrides,
  };
}

const mailLink = (href: string, rel: string | null = 'describedby') => ({
  mail: { '@type': 'Link' as const, href, cid: null, contentType: null, size: null, rel, display: null, title: null },
});

describe('followUpMailRef', () => {
  it('reads the mail id and its JMAP account from the permalink, with a locale, a mount prefix and a query', () => {
    expect(followUpMailRef({ links: mailLink('https://host/webmail/de/mail/message/Ma%2Fb?account=x&mailAccount=acc%3A1') }))
      .toEqual({ emailId: 'Ma/b', accountId: 'acc:1' });
    expect(followUpMailRef({ links: mailLink('/mail/message/M1') })).toEqual({ emailId: 'M1', accountId: null });
  });

  it('is null for a task without a mail link', () => {
    expect(followUpMailRef({ links: null })).toBeNull();
    expect(followUpMailRef({ links: mailLink('https://host/mail/message/M1', null) })).toBeNull();
    expect(followUpMailRef({ links: mailLink('https://host/calendar/event/E1') })).toBeNull();
  });
});

describe('followUpsByEmailId', () => {
  it('maps the own follow-ups by mail, the open one first', () => {
    const done = makeTask('done', { links: mailLink('/mail/message/M1'), progress: 'completed', updated: '2026-10-27T00:00:00Z' });
    const open = makeTask('open', { links: mailLink('/mail/message/M1') });
    const shared = makeTask('acc:shared', { links: mailLink('/mail/message/M2'), isShared: true });
    const plain = makeTask('plain');
    const map = followUpsByEmailId([done, open, shared, plain]);
    expect([...map.keys()]).toEqual(['M1']);
    expect(map.get('M1')?.id).toBe('open');
  });

  it('keeps the follow-ups of the mail account asked for, and those naming none', () => {
    const own = makeTask('own', { links: mailLink('/mail/message/M1?mailAccount=me') });
    const group = makeTask('group', { links: mailLink('/mail/message/M2?mailAccount=group') });
    const unnamed = makeTask('unnamed', { links: mailLink('/mail/message/M3') });
    expect([...followUpsByEmailId([own, group, unnamed], 'me').keys()]).toEqual(['M1', 'M3']);
  });
});

describe('threadFollowUpEmail', () => {
  const mails = [
    { id: 'M1', receivedAt: '2026-10-20T08:00:00Z' },
    { id: 'M3', receivedAt: '2026-10-22T08:00:00Z' },
    { id: 'M2', receivedAt: '2026-10-21T08:00:00Z' },
  ];
  it('is the newest mail of the conversation with a follow-up', () => {
    expect(threadFollowUpEmail(mails, new Map([['M1', 1], ['M2', 1]]))?.id).toBe('M2');
  });
  it('is null when none has one', () => {
    expect(threadFollowUpEmail(mails, new Map())).toBeNull();
  });
});

describe('followUpState', () => {
  const now = at(26, 12);
  it('is overdue once the due day has passed, done when completed', () => {
    expect(followUpState({ due: '2026-10-26T00:00:00', progress: 'needs-action' }, now)).toBe('open');
    expect(followUpState({ due: '2026-10-25T00:00:00', progress: 'needs-action' }, now)).toBe('overdue');
    expect(followUpState({ due: null, progress: 'needs-action' }, now)).toBe('open');
    expect(followUpState({ due: '2026-10-25T00:00:00', progress: 'completed' }, now)).toBe('done');
  });
});

describe('followUpReminder', () => {
  it('reads the absolute trigger', () => {
    const task = buildFollowUpTask({
      title: 't', mailUrl: '/mail/message/M1', calendarId: 'c', due: null,
      reminderAt: new Date('2026-10-28T07:00:00Z'),
    });
    expect(followUpReminder(task as CalendarTask)?.toISOString()).toBe('2026-10-28T07:00:00.000Z');
    expect(followUpReminder({ alerts: null })).toBeNull();
  });
});

describe('dueDistance', () => {
  const now = at(26, 12);
  it('names the day as the row chip says it', () => {
    expect(dueDistance(null, now)).toEqual({ kind: 'none' });
    expect(dueDistance(at(26), now)).toEqual({ kind: 'today' });
    expect(dueDistance(at(27), now)).toEqual({ kind: 'tomorrow' });
    expect(dueDistance(at(29), now)).toEqual({ kind: 'weekday', day: at(29) });
    expect(dueDistance(at(2, 0, 0, 11), now)).toEqual({ kind: 'date', day: at(2, 0, 0, 11) });
    expect(dueDistance(at(25), now)).toEqual({ kind: 'yesterday' });
    expect(dueDistance(at(23), now)).toEqual({ kind: 'days_ago', count: 3 });
  });
});
