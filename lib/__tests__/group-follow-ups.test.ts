import { describe, expect, it } from 'vitest';
import {
  GROUP_OWNER_PARTICIPANT_ID,
  SET_BY_PROPERTY,
  addressOf,
  groupFollowUpsByEmailId,
  groupTaskList,
  groupTaskOwner,
  groupTaskOwnerPatch,
  groupTaskParticipants,
  groupTaskPeople,
  groupTaskSetBy,
  isGroupFollowUpTask,
  isTaskForMe,
  taskListSharees,
} from '../group-follow-ups';
import { buildFollowUpTask, buildReminderTask } from '../follow-ups';
import { dueTaskReminders, isReminderWindowTask, isToastlessTask } from '../task-reminders';
import { dueTaskCount, upcomingTasks } from '../upcoming-tasks';
import { applyPatchObject } from '../jmap/patch-object';
import type { Calendar, CalendarRights, CalendarTask, Principal } from '../jmap/types';

const ME = new Set(['me@example.com', 'jacob@example.com']);
const anna = { id: 'anna', name: 'Anna', email: 'anna@example.com' };
const ben = { id: 'ben', name: 'Ben', email: 'ben@example.com' };
const me = { id: null, name: 'Jacob', email: 'me@example.com' };

const rights = (over: Partial<CalendarRights> = {}): CalendarRights => ({
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true, ...over,
});

let seq = 0;
function task(over: Partial<CalendarTask> = {}): CalendarTask {
  seq += 1;
  return {
    id: `grp:t${seq}`, uid: `u${seq}`, '@type': 'Task', title: `Task ${seq}`, description: '',
    calendarIds: { 'grp:b': true }, accountId: 'grp', isShared: true,
    due: null, start: null, duration: null, timeZone: null, showWithoutTime: true,
    progress: 'needs-action', priority: 0, privacy: 'public', keywords: null, categories: null,
    color: null, created: null, updated: '2026-10-26T08:00:00Z', recurrenceRules: null,
    alerts: null, relatedTo: null, links: null,
    ...over,
  } as CalendarTask;
}

const forAnna = () => groupTaskParticipants(anna, ben);

describe('the owner participant', () => {
  it('names whom it is for by calendarAddress, as owner, with who set it (plan 037 M2)', () => {
    const participants = groupTaskParticipants(anna, me);
    expect(participants[GROUP_OWNER_PARTICIPANT_ID]).toMatchObject({
      '@type': 'Participant',
      name: 'Anna',
      calendarAddress: 'mailto:anna@example.com',
      kind: 'individual',
      roles: { owner: true },
      [SET_BY_PROPERTY]: { name: 'Jacob', email: 'me@example.com' },
    });
  });

  it('is read back only from this app\'s key: another client\'s owner participant is none', () => {
    const t = task({ participants: forAnna() });
    expect(groupTaskOwner(t)).toMatchObject({ key: 'for', email: 'anna@example.com', name: 'Anna', setBy: { name: 'Ben', email: 'ben@example.com' } });
    expect(groupTaskOwner(task({ participants: { for: { calendarAddress: 'mailto:A@Example.com', roles: { attendee: true } } as never } }))).toBeNull();
    expect(groupTaskOwner(task({ participants: { for: { calendarAddress: 'mailto:A@Example.com', roles: { owner: true } } as never } }))?.email).toBe('a@example.com');
    expect(groupTaskOwner(task({ participants: { x: { calendarAddress: 'mailto:a@example.com', roles: { owner: true } } as never } }))).toBeNull();
  });

  it('tells whether it is the user\'s, and whether it is a group follow-up of this app', () => {
    const lists = new Set(['grp:b']);
    const mine = task({ participants: groupTaskParticipants(me, ben) });
    const annas = task({ participants: forAnna() });
    expect(isTaskForMe(mine, ME)).toBe(true);
    expect(isTaskForMe(annas, ME)).toBe(false);
    expect(isGroupFollowUpTask(annas, lists)).toBe(true);
    // Naming no one, in a list not recognised, or another client's participant: not this app's.
    expect(isGroupFollowUpTask(task(), lists)).toBe(false);
    expect(isGroupFollowUpTask(annas, new Set(['other:b']))).toBe(false);
    expect(isGroupFollowUpTask(task({ participants: { x: { calendarAddress: 'mailto:anna@example.com', roles: { owner: true } } as never } }), lists)).toBe(false);
  });

  it('who set it: the property, else the organizer the server keeps', () => {
    expect(groupTaskSetBy(task({ participants: forAnna() }))).toEqual({ name: 'Ben', email: 'ben@example.com' });
    const plain = { for: { calendarAddress: 'mailto:anna@example.com', roles: { owner: true } } as never };
    expect(groupTaskSetBy(task({ participants: plain, organizerCalendarAddress: 'mailto:Carla@example.com' })))
      .toEqual({ name: null, email: 'carla@example.com' });
  });

  it('a change of whom it is for replaces the owner by its path, and none when it stays', () => {
    const t = task({ participants: { ...forAnna(), other: { calendarAddress: 'mailto:x@example.com', roles: {} } as never } });
    const patch = groupTaskOwnerPatch(t, ben, me);
    expect(Object.keys(patch)).toEqual(['participants/for']);
    const after = applyPatchObject(t, patch);
    expect(groupTaskOwner(after)?.email).toBe('ben@example.com');
    expect(after.participants?.other).toBeDefined();
    expect(groupTaskOwnerPatch(t, anna, me)).toEqual({});
    // A task without participants gets the map whole.
    expect(Object.keys(groupTaskOwnerPatch(task(), anna, me))).toEqual(['participants']);
  });

  it('the task builders carry the participants into the group\'s list', () => {
    const followUp = buildFollowUpTask({
      title: 'Call: Offer', mailUrl: 'https://h/mail/message/M1?mailAccount=grp', calendarId: 'grp:b',
      due: null, reminderAt: null, participants: forAnna(),
    });
    expect(followUp.participants?.for?.calendarAddress).toBe('mailto:anna@example.com');
    const reminder = buildReminderTask({ title: 'Dunning', calendarId: 'grp:b', due: null, reminderAt: null, participants: forAnna() });
    expect(reminder.participants?.for?.roles).toEqual({ owner: true });
    expect(buildReminderTask({ title: 'Dunning', calendarId: 'tasks', due: null, reminderAt: null }).participants).toBeUndefined();
  });

  it('addresses compare without mailto: and case', () => {
    expect(addressOf('mailto:Anna@Example.COM')).toBe('anna@example.com');
    expect(addressOf('Anna')).toBeNull();
  });
});

describe('groupTaskPeople', () => {
  const principals = [{ id: 'carla', type: 'individual', name: 'carla@example.com', email: 'carla@example.com', description: 'Carla' }] as Principal[];

  it('for Anna, from Ben', () => {
    expect(groupTaskPeople(task({ participants: forAnna() }), ME, [])).toEqual({ forMe: false, forName: 'Anna', byMe: false, byName: 'Ben' });
  });

  it('for me, set by me: nothing more', () => {
    expect(groupTaskPeople(task({ participants: groupTaskParticipants(me, me) }), ME, [])).toEqual({ forMe: true, forName: null, byMe: false, byName: null });
  });

  it('set by me for Anna', () => {
    expect(groupTaskPeople(task({ participants: groupTaskParticipants(anna, me) }), ME, [])).toMatchObject({ forName: 'Anna', byMe: true, byName: null });
  });

  it('a name the task lacks comes from the directory, else the address\'s local part', () => {
    const participants = { for: { calendarAddress: 'mailto:carla@example.com', roles: { owner: true } } as never };
    expect(groupTaskPeople(task({ participants, organizerCalendarAddress: 'mailto:dan@example.com' }), ME, principals))
      .toEqual({ forMe: false, forName: 'Carla', byMe: false, byName: 'dan' });
  });
});

describe('groupTaskList', () => {
  const cal = (over: Partial<Calendar>) => ({ myRights: rights(), isShared: true, accountId: 'grp', ...over }) as Calendar;

  it('the group account\'s list holding only tasks, else its default calendar; never a user\'s', () => {
    const own = { id: 'tasks', isTasksOnly: true, myRights: rights() } as Calendar;
    const def = cal({ id: 'grp:b', isDefault: true });
    const tasksOnly = cal({ id: 'grp:t', isTasksOnly: true });
    const other = cal({ id: 'x:b', accountId: 'x', isTasksOnly: true });
    expect(groupTaskList([own, other, def], 'grp')?.id).toBe('grp:b');
    expect(groupTaskList([own, def, tasksOnly], 'grp')?.id).toBe('grp:t');
    expect(groupTaskList([own], 'grp')).toBeNull();
  });

  it('only one the user may write to', () => {
    expect(groupTaskList([cal({ id: 'grp:b', isDefault: true, myRights: rights({ mayWriteAll: false, mayWriteOwn: false }) })], 'grp')).toBeNull();
  });
});

describe('taskListSharees', () => {
  const principals = [
    { id: 'anna', type: 'individual', name: 'anna@example.com', email: 'anna@example.com', description: 'Anna' },
    { id: 'ben', type: 'individual', name: 'ben@example.com', email: 'Ben@example.com' },
    { id: 'me', type: 'individual', name: 'me@example.com', email: 'me@example.com' },
    { id: 'team', type: 'group', name: 'team@example.com', email: 'team@example.com' },
    { id: 'noaddress', type: 'individual', name: 'x' },
  ] as Principal[];

  it('the people the list is shared with to read, by name, without the user, groups or those without an address', () => {
    const list = { shareWith: {
      anna: rights(), ben: rights(), me: rights(), team: rights(), noaddress: rights(),
      blind: rights({ mayReadItems: false }), unknown: rights(),
    } } as unknown as Calendar;
    expect(taskListSharees(list, principals, ME, 'me')).toEqual([
      { id: 'anna', name: 'Anna', email: 'anna@example.com' },
      { id: 'ben', name: 'ben@example.com', email: 'ben@example.com' },
    ]);
  });

  it('none when it is shared with no one', () => {
    expect(taskListSharees({ shareWith: null } as Calendar, principals, ME, 'me')).toEqual([]);
  });
});

describe('groupFollowUpsByEmailId', () => {
  const link = (emailId: string, account: string) => ({
    mail: { '@type': 'Link', href: `https://h/mail/message/${emailId}?mailAccount=${account}`, rel: 'describedby' } as never,
  });

  it('every follow-up of the group\'s list on a mail of that account, open first, never a cancelled one', () => {
    const done = task({ links: link('M1', 'grp'), progress: 'completed', updated: '2026-10-27T00:00:00Z' });
    const open = task({ links: link('M1', 'grp') });
    const cancelled = task({ links: link('M1', 'grp'), progress: 'cancelled' });
    const otherAccount = task({ links: link('M1', 'other') });
    const own = { ...task({ links: link('M1', 'grp') }), isShared: false, accountId: undefined };
    const index = groupFollowUpsByEmailId([done, open, cancelled, otherAccount, own], 'grp');
    expect(index.get('M1')?.map((t) => t.id)).toEqual([open.id, done.id]);
  });

});

describe('reminders of a group\'s list', () => {
  const NOW = new Date('2026-10-28T09:30:00Z');
  const alert = {
    'follow-up': {
      '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-28T09:00:00Z' },
      action: 'display', acknowledged: null, relatedTo: null,
    },
  } as CalendarTask['alerts'];
  const scope = { mine: ME, groupListIds: new Set(['grp:b']) };

  it('only for whom it is: the window shows the user\'s, never a colleague\'s', () => {
    const mine = task({ alerts: alert, participants: groupTaskParticipants(me, ben) });
    const annas = task({ alerts: alert, participants: forAnna() });
    expect(isReminderWindowTask(mine, scope)).toBe(true);
    expect(isReminderWindowTask(annas, scope)).toBe(false);
    // Without the scope, as before: no shared task.
    expect(isReminderWindowTask(mine)).toBe(false);
    expect(dueTaskReminders([mine, annas], NOW.getTime(), undefined, scope).map((r) => r.task.id)).toEqual([mine.id]);
  });

  it('the plain toast leaves out this app\'s group follow-ups only; any other shared task is toasted as before', () => {
    const mine = task({ alerts: alert, participants: groupTaskParticipants(me, ben) });
    const annas = task({ alerts: alert, participants: forAnna() });
    expect(isToastlessTask(mine, scope)).toBe(true);
    expect(isToastlessTask(annas, scope)).toBe(true);
    // Naming no one; another client's owner participant; a list not recognised as a group's.
    const nobodys = task({ alerts: alert });
    const foreign = task({ alerts: alert, participants: { x: { calendarAddress: 'mailto:anna@example.com', roles: { owner: true } } as never } });
    const elsewhere = task({ alerts: alert, participants: forAnna(), calendarIds: { 'boss:b': true } });
    for (const t of [nobodys, foreign, elsewhere]) {
      expect(isToastlessTask(t, scope)).toBe(false);
      expect(isReminderWindowTask(t, scope)).toBe(false);
    }
    // Not even for the user: a task for them in a list this app does not know is no window task.
    const minesElsewhere = task({ alerts: alert, participants: groupTaskParticipants(me, ben), calendarIds: { 'boss:b': true } });
    expect(isReminderWindowTask(minesElsewhere, scope)).toBe(false);
  });

  it('a repeating one is no window task, also for the user', () => {
    const series = task({ alerts: alert, participants: groupTaskParticipants(me, ben), recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', interval: 1 }] as never });
    expect(isReminderWindowTask(series, scope)).toBe(false);
  });
});

describe('"Upcoming" with the group tasks for the user', () => {
  const NOW = new Date(2026, 9, 28, 10, 30);
  it('lists them beside the own list\'s, each once, and counts them in the badge', () => {
    const own = { ...task({ due: '2026-10-28T00:00:00' }), id: 'own', isShared: false, accountId: undefined, calendarIds: { tasks: true } };
    const forMe = task({ due: '2026-10-27T00:00:00', participants: groupTaskParticipants(me, ben) });
    const list = upcomingTasks([own, forMe], new Set(['tasks']), NOW, 1, [forMe]);
    expect(list.groups.map((g) => [g.group, g.tasks.map((t) => t.id)])).toEqual([['overdue', [forMe.id]], ['today', ['own']]]);
    expect(dueTaskCount([own], new Set(['tasks']), NOW, [forMe])).toBe(2);
    // Without them, as before.
    expect(dueTaskCount([own, forMe], new Set(['tasks']), NOW)).toBe(1);
  });
});
