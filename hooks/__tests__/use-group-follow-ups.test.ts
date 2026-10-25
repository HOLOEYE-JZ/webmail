import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressesOf } from '../use-group-follow-ups';
import { isGroupAccount } from '@/lib/group-follow-ups';
import {
  DIRECTORY_RETRY_MS,
  findGroupTaskLists,
  PUSH_DEBOUNCE_MS,
  refreshGroupTasksFor,
  useGroupTasks,
} from '@/stores/group-task-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Principal } from '@/lib/jmap/types';

const rights = { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true } as Calendar['myRights'];
const cal = (over: Partial<Calendar>) => ({ myRights: rights, ...over }) as Calendar;

const calendars = [
  cal({ id: 'tasks', isTasksOnly: true, accountId: 'me' }),
  cal({ id: 'grp:b', isShared: true, isDefault: true, accountId: 'grp', accountName: 'sales@example.com' }),
  // A colleague's calendar shared with the user, whose mail the login also reaches: not a group's.
  cal({ id: 'anna:b', isShared: true, isDefault: true, accountId: 'anna', accountName: 'anna@example.com' }),
  // A group the login reaches for calendars only.
  cal({ id: 'cal:b', isShared: true, isDefault: true, accountId: 'cal', accountName: 'cal@example.com' }),
];

const principals = [
  { id: 'grp', type: 'group', name: 'sales@example.com' },
  { id: 'anna', type: 'individual', name: 'anna@example.com' },
  { id: 'cal', type: 'group', name: 'cal@example.com' },
] as Principal[];

const task = (id: string, calendarId: string, progress = 'needs-action') => ({ id, calendarIds: { [calendarId]: true }, isShared: true, progress }) as unknown as CalendarTask;

function makeClient() {
  return {
    getAccountId: () => 'me',
    hasAccountCapability: (_c: string, accountId?: string) => accountId === 'grp' || accountId === 'anna',
    getPrincipals: vi.fn(async () => principals),
    getCalendarTaskList: vi.fn(async (_ids?: string[]) => ({
      tasks: [task('grp:1', 'grp:b'), task('grp:2', 'grp:other'), task('grp:3', 'grp:b', 'completed'), task('grp:4', 'grp:b', 'cancelled')],
      complete: true,
    })),
    getCalendarTasks: vi.fn(),
  };
}

let client: ReturnType<typeof makeClient>;

beforeEach(() => {
  client = makeClient();
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useCalendarStore.setState({ calendars });
});

afterEach(() => {
  useGroupTasks.getState().clear();
});

describe('the group task lists', () => {
  it('one per group account the login reaches for mail, never a user\'s, nor the own account', async () => {
    const { lists } = await findGroupTaskLists(client as unknown as IJMAPClient, calendars);
    expect(lists).toEqual([{ accountId: 'grp', name: 'sales@example.com', list: calendars[1] }]);
  });

  it('only an account the directory names a group: none named, or no directory, is no group', async () => {
    expect(isGroupAccount('grp', principals)).toBe(true);
    expect(isGroupAccount('anna', principals)).toBe(false);
    expect(isGroupAccount('boss', principals)).toBe(false);
    expect(isGroupAccount('grp', [])).toBe(false);
    client.getPrincipals.mockResolvedValue([]);
    const found = await findGroupTaskLists(client as unknown as IJMAPClient, calendars);
    expect(found).toEqual({ lists: [], directoryRead: false });
  });

  it('asks the directory again later when it could not be read, and then offers the group', async () => {
    vi.useFakeTimers();
    try {
      client.getPrincipals.mockResolvedValueOnce([]);
      await useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
      expect(useGroupTasks.getState().lists).toEqual([]);
      expect(client.getCalendarTaskList).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DIRECTORY_RETRY_MS);
      expect(useGroupTasks.getState().lists.map((l) => l.accountId)).toEqual(['grp']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read begun before a local write, or overtaken by a later read, does not overwrite', async () => {
    let answer: (v: { tasks: CalendarTask[]; complete: boolean }) => void = () => {};
    client.getCalendarTaskList.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
    await vi.waitFor(() => expect(client.getCalendarTaskList).toHaveBeenCalledTimes(1));
    useGroupTasks.getState().addLocal(task('grp:new', 'grp:b'));
    answer({ tasks: [task('grp:old', 'grp:b')], complete: true });
    await pending;
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['grp:new']);

    // An older read answering after a newer one is dropped.
    let older: (v: { tasks: CalendarTask[]; complete: boolean }) => void = () => {};
    client.getCalendarTaskList.mockImplementationOnce(() => new Promise((resolve) => { older = resolve; }));
    const first = useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
    await vi.waitFor(() => expect(client.getCalendarTaskList).toHaveBeenCalledTimes(2));
    await useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
    older({ tasks: [task('grp:stale', 'grp:b')], complete: true });
    await first;
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['grp:1']);
  });

  it('loads only those lists\' open tasks, apart from the task store', async () => {
    await useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
    expect(client.getCalendarTaskList).toHaveBeenCalledWith(['grp:b']);
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['grp:1']);
  });

  it('reads them again after pushes, once for a burst, only when a list lies in a changed account', async () => {
    await useGroupTasks.getState().refresh(client as unknown as IJMAPClient);
    client.getCalendarTaskList.mockClear();
    vi.useFakeTimers();
    try {
      refreshGroupTasksFor(client as unknown as IJMAPClient, ['other']);
      await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
      expect(client.getCalendarTaskList).not.toHaveBeenCalled();
      for (let i = 0; i < 5; i++) refreshGroupTasksFor(client as unknown as IJMAPClient, ['grp']);
      await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
      expect(client.getCalendarTaskList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('addressesOf', () => {
  it('the login\'s identities, calendar addresses and login name, lower case; not another login\'s', () => {
    expect([...addressesOf(
      [{ email: 'Me@Example.com' }, { email: 'other@x.com', localAccountId: 'second' }],
      'jacob@example.com',
      [{ calendarAddress: 'mailto:Alias@Example.com' }],
    )].sort()).toEqual(['alias@example.com', 'jacob@example.com', 'me@example.com']);
  });
});
