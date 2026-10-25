import { applyPatchObject } from '../jmap/patch-object';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKING_TIME,
  buildFollowUpTask,
  dueDistance,
  editFollowUpTask,
  followUpAction,
  followUpActionKey,
  followUpReminderAlert,
  followUpMailAlertIds,
  hasFollowUpMailAlert,
  mailReminderOffered,
  buildReminderTask,
  otherFollowUpAlerts,
  sameFollowUpAction,
  followUpNote,
  proposedFollowUpReminder,
  followUpMailRef,
  followUpReminder,
  followUpState,
  followUpsByEmailId,
  isOtherAccountMail,
  mailAccountOfMailboxIds,
  rescheduleFollowUpTask,
  retitle,
  scheduleFollowUp,
  threadFollowUpEmail,
  type FollowUpChoice,
  type WorkingTime,
} from '../follow-ups';
import type { CalendarEventAlert, CalendarTask } from '@/lib/jmap/types';

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
    expect(rescheduleFollowUpTask({ alerts: null }, at(27), null)).toEqual({
      due: '2026-10-27T00:00:00',
      showWithoutTime: true,
      progress: 'needs-action',
    });
    expect(rescheduleFollowUpTask({ alerts: null }, at(27), new Date('2026-10-27T07:00:00Z')).alerts).toEqual({
      'follow-up': { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-27T07:00:00Z' }, action: 'display', acknowledged: null, relatedTo: null },
    });
  });

  it('moves the reminder it shows by its path, leaving every other alert', () => {
    const phone: CalendarEventAlert = { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display', acknowledged: null, relatedTo: null };
    const own: CalendarEventAlert = { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-26T15:00:00Z' }, action: 'display', acknowledged: '2026-10-26T15:01:00Z', relatedTo: null };
    const task = { alerts: { 'follow-up': own, phone } };
    const patch = rescheduleFollowUpTask(task, at(27), new Date('2026-10-27T07:00:00Z'));
    expect(patch).not.toHaveProperty('alerts');
    expect(applyPatchObject(task, patch).alerts).toEqual({
      'follow-up': { ...own, trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-27T07:00:00Z' }, acknowledged: null },
      phone,
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

  it('counts a link naming no account as the own account\'s, never a group mailbox\'s', () => {
    const own = makeTask('own', { links: mailLink('/mail/message/M1?mailAccount=me') });
    const group = makeTask('group', { links: mailLink('/mail/message/M1?mailAccount=group') });
    const unnamed = makeTask('unnamed', { links: mailLink('/mail/message/M3') });
    // The same Email id in two accounts: each account's follow-up at its own mail.
    expect(followUpsByEmailId([own, group, unnamed], 'group', 'me').get('M1')?.id).toBe('group');
    expect([...followUpsByEmailId([own, group, unnamed], 'group', 'me').keys()]).toEqual(['M1']);
    expect(followUpsByEmailId([own, group, unnamed], 'me', 'me').get('M1')?.id).toBe('own');
    expect([...followUpsByEmailId([own, group, unnamed], 'me', 'me').keys()]).toEqual(['M1', 'M3']);
  });
});

describe('isOtherAccountMail', () => {
  it('is a mail of a group mailbox: a link naming another account than the own', () => {
    expect(isOtherAccountMail({ emailId: 'M1', accountId: 'group' }, 'me')).toBe(true);
    expect(isOtherAccountMail({ emailId: 'M1', accountId: 'me' }, 'me')).toBe(false);
    expect(isOtherAccountMail({ emailId: 'M1', accountId: null }, 'me')).toBe(false);
    expect(isOtherAccountMail(null, 'me')).toBe(false);
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

describe('the dialog: action, note and reminder read back from the task', () => {
  const input = {
    title: 'Follow up: Offer 4711',
    mailUrl: 'https://mail.example.com/mail/message/M123',
    subject: 'Offer 4711',
    calendarId: 'cal-tasks',
    due: at(30),
    reminderAt: null,
  };
  const mailLink = (title: string | null) => ({
    mail: { '@type': 'Link' as const, href: 'https://host/mail/message/M1?mailAccount=acc', cid: null, contentType: null, size: null, rel: 'describedby', display: null, title },
  });

  it('reads the action as the title before the mail subject', () => {
    expect(followUpAction({ title: 'Write a quote: Offer 4711', links: mailLink('Offer 4711') })).toBe('Write a quote');
    // French puts a space before the colon.
    expect(followUpAction({ title: 'Assurer un suivi : Offre', links: mailLink('Offre') })).toBe('Assurer un suivi');
    // The subject may hold a colon itself.
    expect(followUpAction({ title: 'Call: Re: Offer', links: mailLink('Re: Offer') })).toBe('Call');
  });

  it('reads the action of a mail without a subject by the title it was given', () => {
    expect(followUpAction({ title: 'Reply: (no subject)', links: mailLink(null) })).toBe('Reply');
    // Written in German, read in another language.
    expect(followUpAction({ title: 'Anrufen: (kein Betreff)', links: mailLink(null) })).toBe('Anrufen');
  });

  it('takes a title changed elsewhere whole as the action', () => {
    expect(followUpAction({ title: 'Ring Claire back', links: mailLink('Offer 4711') })).toBe('Ring Claire back');
    // Ending in the subject without a separator is no action of ours either.
    expect(followUpAction({ title: 'About Offer 4711', links: mailLink('Offer 4711') })).toBe('About Offer 4711');
    expect(followUpAction({ title: 'Offer 4711', links: mailLink('Offer 4711') })).toBe('Offer 4711');
  });

  it('keeps the note as the description', () => {
    const task = buildFollowUpTask({ ...input, note: '  Two units, delivery January  ' });
    expect(task.description).toBe('Two units, delivery January');
    expect(followUpNote({ description: '  x ' })).toBe('x');
    expect(buildFollowUpTask(input)).not.toHaveProperty('description');
  });

  it('proposes the due day\'s start of work as the reminder, else the next working day\'s', () => {
    const monday = at(26, 7, 0);
    expect(proposedFollowUpReminder(at(29), monday)).toEqual(at(29, 8));
    // Due today, but work has started: tomorrow.
    expect(proposedFollowUpReminder(at(26), at(26, 9, 0))).toEqual(at(27, 8));
    // No due day; Friday afternoon: Monday.
    expect(proposedFollowUpReminder(null, at(30, 15, 0))).toEqual(at(2, 8, 0, 11));
  });

  it('writes every field, the title only when the action changed, and opens a completed one again', () => {
    const task = { title: 'Follow up: Offer', description: '', progress: 'completed' as const, alerts: null };
    const reminderAt = new Date('2026-10-28T09:00:00Z');
    expect(editFollowUpTask(task, { title: 'Call: Offer', due: at(29), reminderAt, note: ' ask for Lena ' })).toEqual({
      title: 'Call: Offer',
      due: '2026-10-29T00:00:00',
      showWithoutTime: true,
      alerts: {
        'follow-up': {
          '@type': 'Alert',
          trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-28T09:00:00Z' },
          action: 'display',
          acknowledged: null,
          relatedTo: null,
        },
      },
      description: 'ask for Lena',
      progress: 'needs-action',
    });
    expect(editFollowUpTask(
      { title: 'Follow up: Offer', description: 'ask for Lena', progress: 'in-process', alerts: null },
      { title: null, due: null, reminderAt: null, note: 'ask for Lena' },
    )).toEqual({ due: null, showWithoutTime: true });
  });

  const alert = (trigger: CalendarEventAlert['trigger'], acknowledged: string | null = null): CalendarEventAlert => ({
    '@type': 'Alert', trigger, action: 'display', acknowledged, relatedTo: null,
  });
  const relative = alert({ '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' });
  const own = (when: string, acknowledged: string | null = null) => alert({ '@type': 'AbsoluteTrigger', when }, acknowledged);
  const base = { title: 'Call: Offer', description: '', progress: 'needs-action' as const };

  it('leaves the alerts alone while the reminder stays: a note changed keeps a relative one and an acknowledged one', () => {
    const alerts = { 'follow-up': own('2026-10-28T09:00:00Z', '2026-10-28T09:01:00Z'), phone: relative };
    const patch = editFollowUpTask({ ...base, alerts }, {
      title: null, due: at(29), reminderAt: new Date('2026-10-28T09:00:00Z'), note: 'new note',
    });
    expect(patch).not.toHaveProperty('alerts');
    expect(patch.description).toBe('new note');
  });

  it('replaces or removes only the reminder it shows, keeping every other alert', () => {
    const alerts = { 'follow-up': own('2026-10-28T09:00:00Z', '2026-10-28T09:01:00Z'), phone: relative };
    const moved = editFollowUpTask({ ...base, alerts }, {
      title: null, due: at(29), reminderAt: new Date('2026-10-29T10:00:00Z'), note: '',
    });
    // By its path only, so an alert another device changed meanwhile is not written back.
    expect(moved).not.toHaveProperty('alerts');
    expect(moved).toHaveProperty(['alerts/follow-up'], own('2026-10-29T10:00:00Z'));
    expect(applyPatchObject({ ...base, alerts }, moved).alerts).toEqual({ 'follow-up': own('2026-10-29T10:00:00Z'), phone: relative });
    const off = editFollowUpTask({ ...base, alerts }, { title: null, due: at(29), reminderAt: null, note: '' });
    expect(off).toHaveProperty(['alerts/follow-up'], null);
    expect(applyPatchObject({ ...base, alerts }, off).alerts).toEqual({ phone: relative });
    // A task without alerts gets its map whole.
    expect(editFollowUpTask({ ...base, alerts: null }, {
      title: null, due: at(29), reminderAt: new Date('2026-10-29T10:00:00Z'), note: '',
    }).alerts).toEqual({ 'follow-up': own('2026-10-29T10:00:00Z') });
  });

  it('shows and changes a fixed-time alert set elsewhere under its own key', () => {
    const task = { ...base, alerts: { phone: relative, 'ios-1': own('2026-10-28T09:00:00Z') } };
    expect(followUpReminderAlert(task)).toEqual({ id: 'ios-1', when: new Date('2026-10-28T09:00:00Z') });
    expect(otherFollowUpAlerts(task)).toBe(1);
    expect(applyPatchObject(task, editFollowUpTask(task, { title: null, due: at(29), reminderAt: new Date('2026-10-29T10:00:00Z'), note: '' })).alerts)
      .toEqual({ phone: relative, 'ios-1': own('2026-10-29T10:00:00Z') });
    // Only a relative one: no reminder shown, but it is counted.
    expect(followUpReminderAlert({ alerts: { phone: relative } })).toBeNull();
    expect(otherFollowUpAlerts({ alerts: { phone: relative } })).toBe(1);
  });
});

describe('actions across languages', () => {
  it('knows a built-in action in any locale, and nothing else', () => {
    expect(followUpActionKey('Nachverfolgen')).toBe('follow_up');
    expect(followUpActionKey('follow UP')).toBe('follow_up');
    expect(followUpActionKey('Anrufen')).toBe('call');
    expect(followUpActionKey('Angebot schreiben')).toBeNull();
    expect(followUpActionKey('')).toBeNull();
  });

  it('takes the same built-in action in two languages for the same', () => {
    expect(sameFollowUpAction('Call', 'Anrufen')).toBe(true);
    expect(sameFollowUpAction('Follow up', 'Nachverfolgen')).toBe(true);
    expect(sameFollowUpAction('Write a quote', ' write a  quote')).toBe(true);
    expect(sameFollowUpAction('Call', 'Reply')).toBe(false);
    expect(sameFollowUpAction('Angebot schreiben', 'Write a quote')).toBe(false);
  });
});

describe('the reminder also as a mail (its own alert action: email, a second ahead)', () => {
  const alert = (when: string, action: CalendarEventAlert['action'] = 'display', acknowledged: string | null = null): CalendarEventAlert => ({
    '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when }, action, acknowledged, relatedTo: null,
  });
  const relative: CalendarEventAlert = {
    '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display', acknowledged: null, relatedTo: null,
  };
  const base = { title: 'Call: Offer', description: '', progress: 'needs-action' as const };
  const nine = '2026-10-28T09:00:00Z';
  const ten = '2026-10-29T10:00:00Z';
  // A second ahead: Stalwart queues only a task's next alarm, the first of two at one time.
  const nineMail = '2026-10-28T08:59:59Z';
  const tenMail = '2026-10-29T09:59:59Z';

  it('writes the alarm mail a second before the reminder, for a follow-up and a reminder without a mail', () => {
    const task = buildFollowUpTask({
      title: 't', mailUrl: '/mail/message/M1', calendarId: 'c', due: at(30), reminderAt: new Date(nine), mailReminder: true,
    });
    expect(task.alerts).toEqual({ 'follow-up': alert(nine), 'follow-up-mail': alert(nineMail, 'email') });
    const reminder = buildReminderTask({ title: 'Dunning run', calendarId: 'c', due: at(30), reminderAt: new Date(nine), mailReminder: true });
    expect(reminder.alerts).toEqual({ 'follow-up': alert(nine), 'follow-up-mail': alert(nineMail, 'email') });
    // Without a reminder there is no mail either.
    expect(buildReminderTask({ title: 'x', calendarId: 'c', due: null, reminderAt: null, mailReminder: true }).alerts).toBeNull();
  });

  it('knows its own by the key alone, whatever its time; one set elsewhere is another reminder', () => {
    const task = { alerts: { 'follow-up': alert(nine), 'follow-up-mail': alert(nineMail, 'email') } };
    expect(followUpReminderAlert(task)).toEqual({ id: 'follow-up', when: new Date(nine) });
    expect(followUpMailAlertIds(task)).toEqual(['follow-up-mail']);
    expect(otherFollowUpAlerts(task)).toBe(0);
    // Its own, at another time (moved elsewhere): still the box's.
    expect(hasFollowUpMailAlert({ alerts: { 'follow-up': alert(nine), 'follow-up-mail': alert(ten, 'email') } })).toBe(true);
    // Another key, even at the same time: not the box's, counted as another reminder.
    const foreign = { alerts: { 'follow-up': alert(nine), phone: alert(nineMail, 'email') } };
    expect(hasFollowUpMailAlert(foreign)).toBe(false);
    expect(otherFollowUpAlerts(foreign)).toBe(1);
    // An alarm mail alone is no reminder Bulwark shows.
    expect(followUpReminderAlert({ alerts: { 'follow-up-mail': alert(nine, 'email') } })).toBeNull();
  });

  it('adds it, moves it with the reminder, and takes it off with the box or the reminder', () => {
    const plain = { ...base, alerts: { 'follow-up': alert(nine), phone: relative } };
    const added = editFollowUpTask(plain, { title: null, due: at(29), reminderAt: new Date(nine), note: '', mailReminder: true });
    // The reminder itself is not touched: its acknowledged stays.
    expect(added).not.toHaveProperty(['alerts/follow-up']);
    expect(applyPatchObject(plain, added).alerts).toEqual({ 'follow-up': alert(nine), phone: relative, 'follow-up-mail': alert(nineMail, 'email') });

    const both = { ...base, alerts: { 'follow-up': alert(nine, 'display', '2026-10-28T09:01:00Z'), 'follow-up-mail': alert(nineMail, 'email'), phone: relative } };
    const unchanged = editFollowUpTask(both, { title: null, due: at(29), reminderAt: new Date(nine), note: 'n', mailReminder: true });
    expect(Object.keys(unchanged).filter((k) => k.startsWith('alerts'))).toEqual([]);
    // Left out (the dialog did not offer it): kept as the task has it, moved along.
    const moved = editFollowUpTask(both, { title: null, due: at(29), reminderAt: new Date(ten), note: '' });
    expect(applyPatchObject(both, moved).alerts).toEqual({ 'follow-up': alert(ten), 'follow-up-mail': alert(tenMail, 'email'), phone: relative });
    const boxOff = editFollowUpTask(both, { title: null, due: at(29), reminderAt: new Date(nine), note: '', mailReminder: false });
    expect(boxOff).toEqual(expect.objectContaining({ 'alerts/follow-up-mail': null }));
    expect(boxOff).not.toHaveProperty(['alerts/follow-up']);
    const reminderOff = editFollowUpTask(both, { title: null, due: at(29), reminderAt: null, note: '', mailReminder: true });
    expect(applyPatchObject(both, reminderOff).alerts).toEqual({ phone: relative });

    // A task without alerts gets its map whole.
    expect(editFollowUpTask({ ...base, alerts: null }, { title: null, due: at(29), reminderAt: new Date(ten), note: '', mailReminder: true }).alerts)
      .toEqual({ 'follow-up': alert(ten), 'follow-up-mail': alert(tenMail, 'email') });
  });

  it('never touches an alarm mail set elsewhere: not by the box, a new time or no reminder', () => {
    const foreign = alert(nine, 'email');
    const task = { ...base, alerts: { 'follow-up': alert(nine), phone: foreign } };
    for (const edit of [
      { reminderAt: new Date(ten), mailReminder: false },
      { reminderAt: new Date(ten), mailReminder: true },
      { reminderAt: null, mailReminder: false },
    ]) {
      const after = applyPatchObject(task, editFollowUpTask(task, { title: null, due: at(29), note: '', ...edit }));
      expect(after.alerts?.phone).toEqual(foreign);
    }
    expect(applyPatchObject(task, rescheduleFollowUpTask(task, at(29), new Date(ten))).alerts?.phone).toEqual(foreign);
  });

  it('moves along with a quick choice, and is taken off with its reminder there', () => {
    const both = { alerts: { 'follow-up': alert(nine), 'follow-up-mail': alert(nineMail, 'email') } };
    expect(applyPatchObject(both, rescheduleFollowUpTask(both, at(29), new Date(ten))).alerts)
      .toEqual({ 'follow-up': alert(ten), 'follow-up-mail': alert(tenMail, 'email') });
    expect(applyPatchObject(both, rescheduleFollowUpTask(both, at(29), null)).alerts).toEqual({});
  });

  it('is offered only in the user\'s own list, and not for a follow-up that settles itself on an answer', () => {
    expect(mailReminderOffered({ isShared: false })).toBe(true);
    expect(mailReminderOffered({})).toBe(true);
    // A group mailbox's list: the server would mail the group's inbox.
    expect(mailReminderOffered({ isShared: true })).toBe(false);
    expect(mailReminderOffered(null)).toBe(false);
    expect(mailReminderOffered({ isShared: false }, true)).toBe(false);
  });
});

describe('mailAccountOfMailboxIds', () => {
  it('reads the account from namespaced folder ids, bare ones being the own account', () => {
    expect(mailAccountOfMailboxIds({ 'grp:inbox': true, 'grp:done': true }, 'me')).toBe('grp');
    expect(mailAccountOfMailboxIds({ inbox: true }, 'me')).toBe('me');
  });

  it('is undefined without folders and null for folders of several accounts', () => {
    expect(mailAccountOfMailboxIds({}, 'me')).toBeUndefined();
    expect(mailAccountOfMailboxIds(undefined, 'me')).toBeUndefined();
    expect(mailAccountOfMailboxIds({ inbox: true, 'grp:inbox': true }, 'me')).toBeNull();
  });
});

describe('retitle', () => {
  const text = { title: (action: string, subject: string) => `${action}: ${subject}`, noSubject: '(no subject)' };
  const task = buildFollowUpTask({ title: 'Anrufen: Offer', mailUrl: '/mail/message/M1', subject: 'Offer', calendarId: 'c', due: null, reminderAt: null }) as CalendarTask;

  it('keeps the title for the same action, also in another language', () => {
    expect(retitle(task, 'Anrufen', 'Offer', text)).toBeNull();
    expect(retitle(task, 'Call', 'Offer', text)).toBeNull();
  });

  it('names the subject the task keeps, else the mail\'s, else none', () => {
    expect(retitle(task, 'Reply', 'Re: Offer', text)).toBe('Reply: Offer');
    const bare = { ...task, links: null };
    expect(retitle(bare, 'Reply', 'Re: Offer', text)).toBe('Reply: Re: Offer');
    expect(retitle(bare, 'Reply', '', text)).toBe('Reply: (no subject)');
  });
});
