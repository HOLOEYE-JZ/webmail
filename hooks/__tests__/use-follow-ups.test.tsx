import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  followUpOnMail,
  isFollowUpPending,
  markUnstarredHere,
  unstarredHereMails,
  useFollowUp,
  useFollowUpTasks,
} from '../use-follow-ups';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { useToastStore } from '@/stores/toast-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Email } from '@/lib/jmap/types';

// Outlook's Quick Click on the row's flag: the first click flags the mail for
// today (a task linking it, the mail's $flagged), the next marks it complete,
// the next clears it.

const mail = {
  id: 'M1',
  threadId: 'T1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1,
  receivedAt: '2026-10-26T07:00:00Z',
  subject: 'Offer 4711',
  hasAttachment: false,
} as Email;

const calendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'Tasks', isTasksOnly: true },
] as Calendar[];

function makeClient() {
  let seq = 0;
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async () => [{ id: 'M1', messageId: ['offer@example.com'] }]),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: `task-${++seq}`, uid: 'u', updated: '' }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    getCalendarTasks: vi.fn(async () => [] as CalendarTask[]),
    // The login reaches its own account and the group mailbox `grp`.
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;

beforeEach(() => {
  clearAllHooks();
  useToastStore.setState({ toasts: [] });
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true });
  useCalendarStore.setState({ supportsCalendar: true, calendars });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [mail], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null, searchQuery: '', searchMailboxId: '' });
});

const flagged = () => !!useEmailStore.getState().emails[0].keywords.$flagged;

describe('useFollowUp', () => {
  it('flags for today, then completes, then clears on each quick click', async () => {
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    expect(result.current.available).toBe(true);
    expect(result.current.task).toBeNull();

    await act(() => result.current.quickClick());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written).toMatchObject({
      title: 'task_title',
      calendarIds: { tasks: true },
      progress: 'needs-action',
      showWithoutTime: true,
      relatedTo: { '<offer@example.com>': { '@type': 'Relation' } },
    });
    expect(written.links?.mail).toMatchObject({ rel: 'describedby' });
    // The link names the mail's JMAP account (plan: a group mailbox's mail needs it).
    expect(written.links?.mail.href).toMatch(/\/mail\/message\/M1\?mailAccount=acc$/);
    expect(typeof written.due).toBe('string');
    expect(result.current.task?.id).toBe('task-1');
    expect(flagged()).toBe(true);

    await act(() => result.current.quickClick());
    expect(client.updateCalendarTask).toHaveBeenCalledWith('task-1', { progress: 'completed' });
    expect(result.current.task?.progress).toBe('completed');
    expect(flagged()).toBe(false);

    await act(() => result.current.quickClick());
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('task-1');
    expect(result.current.task).toBeNull();
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
  });

  it('moves an existing follow-up to another day and opens it again', async () => {
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    await act(() => result.current.apply('today'));
    await act(() => result.current.markDone());
    await act(() => result.current.apply('no-date'));
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
    expect(client.updateCalendarTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({
      due: null, showWithoutTime: true, progress: 'needs-action',
    }));
    // The reminder taken off by its path, so no other alert is touched.
    const task = useTaskStore.getState().tasks.find((t) => t.id === 'task-1');
    expect(Object.keys(task?.alerts ?? {})).toEqual([]);
    expect(flagged()).toBe(true);
  });

  it('offers nothing for a mail of a shared account the login does not reach, or with tasks off', () => {
    useEmailStore.setState({ mailboxes: [{ id: 'shared:x', isShared: true, accountId: 'shared' } as never], selectedMailbox: 'shared:x' });
    const shared = renderHook(() => useFollowUp({ ...mail, mailboxIds: { 'shared:x': true } }));
    expect(shared.result.current.available).toBe(false);
    shared.unmount();

    useEmailStore.setState({ mailboxes: [], selectedMailbox: 'inbox' });
    useSettingsStore.setState({ enableCalendarTasks: false });
    const off = renderHook(() => useFollowUp(mail));
    expect(off.result.current.available).toBe(false);
  });

  it('writes no $flagged when a plugin refuses the star, for a listed mail', async () => {
    emailHooks.onBeforeEmailStarToggle.register('t', () => false);
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    await act(() => result.current.apply('today'));
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(flagged()).toBe(false);
  });

  it('asks plugins before it flags a mail the list does not hold', async () => {
    useEmailStore.setState({ emails: [] });
    const before = vi.fn(() => false);
    emailHooks.onBeforeEmailStarToggle.register('t', before);
    const { result } = renderHook(() => useFollowUp(mail));
    await act(() => result.current.apply('today'));
    expect(before).toHaveBeenCalledWith({ emailIds: ['M1'], starred: true });
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('flags a mail the list does not hold directly when no plugin objects', async () => {
    useEmailStore.setState({ emails: [] });
    const { result } = renderHook(() => useFollowUp(mail));
    await act(() => result.current.apply('today'));
    // The account named, so no mail of the same id elsewhere is touched.
    expect(client.toggleStar).toHaveBeenCalledWith('M1', true, 'acc');
  });

  it('flags the listed row of the own account only, never a group mail with the same id', async () => {
    const groupRow = { ...mail, mailboxIds: { 'grp:inbox': true }, keywords: {} } as Email;
    useEmailStore.setState({ emails: [groupRow, { ...mail, keywords: {} }] });
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[1]));
    await act(() => result.current.apply('today'));
    expect(client.toggleStar).toHaveBeenCalledWith('M1', true, 'acc');
    const [group, own] = useEmailStore.getState().emails;
    expect(group.keywords.$flagged).toBeUndefined();
    expect(own.keywords.$flagged).toBe(true);
  });

  it('says the follow-up stands when only the flag failed', async () => {
    useEmailStore.setState({ emails: [] });
    client.toggleStar.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useFollowUp(mail));
    await act(() => result.current.apply('today'));
    expect(result.current.task?.id).toBe('task-1');
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['flag_failed']);
  });

  it('says the follow-up failed when the task could not be written', async () => {
    client.createCalendarTask.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    await act(() => result.current.apply('today'));
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['failed']);
    expect(client.toggleStar).not.toHaveBeenCalled();
  });
});

describe('useFollowUp on a group mailbox\'s mail ("only me")', () => {
  const groupFolder = { id: 'grp:inbox', originalId: 'inbox', accountId: 'grp', accountName: 'sales@', isShared: true } as never;
  // As the folder and search fetches give it: its folders namespaced by the account.
  const groupMail = { ...mail, mailboxIds: { 'grp:inbox': true } } as Email;

  beforeEach(() => {
    useEmailStore.setState({ emails: [groupMail], mailboxes: [groupFolder], selectedMailbox: 'grp:inbox' });
  });

  it('keeps the follow-up in the own task list, links the group\'s mail and never flags it', async () => {
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    expect(result.current.available).toBe(true);
    expect(result.current.onlyMe).toBe(true);
    expect(result.current.mailboxName).toBe('sales@');

    await act(() => result.current.quickClick());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ tasks: true });
    expect(written.links?.mail.href).toMatch(/\/mail\/message\/M1\?mailAccount=grp$/);
    // Its Message-ID read in the group's account.
    expect(client.getEmailFields).toHaveBeenCalledWith(['M1'], ['messageId'], 'grp');
    expect(result.current.task?.id).toBe('task-1');

    await act(() => result.current.quickClick());
    expect(result.current.task?.progress).toBe('completed');
    await act(() => result.current.quickClick());
    expect(result.current.task).toBeNull();
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails[0].keywords.$flagged).toBeUndefined();
  });

  it('finds the group\'s follow-up at its mail, never the own one of a mail with the same id', () => {
    const link = (account: string) => ({ mail: { '@type': 'Link', href: `https://h/mail/message/M1?mailAccount=${account}`, rel: 'describedby', title: 'Offer 4711' } });
    const task = (id: string, account: string) => ({ id, calendarIds: { tasks: true }, progress: 'needs-action', links: link(account) }) as unknown as CalendarTask;
    useTaskStore.setState({ tasks: [task('own', 'acc'), task('group', 'grp')] });
    const inGroup = renderHook(() => useFollowUp(groupMail));
    expect(inGroup.result.current.task?.id).toBe('group');
    inGroup.unmount();

    // The own mail of the same id, even while the group's folder is open.
    const own = renderHook(() => useFollowUp(mail));
    expect(own.result.current.task?.id).toBe('own');
    expect(own.result.current.onlyMe).toBe(false);
  });

  it('takes the account from the mail before the folder on screen', () => {
    // A group mail while the own inbox is open: a narrowed search on the group's folder.
    useEmailStore.setState({ mailboxes: [groupFolder, { id: 'inbox' } as never], selectedMailbox: 'inbox', searchQuery: 'offer', searchMailboxId: 'grp:inbox' });
    expect(renderHook(() => useFollowUp(groupMail)).result.current.onlyMe).toBe(true);
    // Stamped (an aggregate view, a Pro tab): the stamp decides.
    expect(renderHook(() => useFollowUp({ ...mail, sourceClientAccountId: 'login', sourceAccountId: 'grp' })).result.current.onlyMe).toBe(true);
  });

  it('falls back to the folder searched for a mail naming no folder, and offers nothing when that is not certain', () => {
    const bare = { ...mail, mailboxIds: {} } as Email;
    useEmailStore.setState({ mailboxes: [groupFolder, { id: 'inbox' } as never], selectedMailbox: 'inbox', searchQuery: 'offer', searchMailboxId: 'grp:inbox' });
    expect(renderHook(() => useFollowUp(bare)).result.current.onlyMe).toBe(true);
    // Across all folders the account is not certain.
    useEmailStore.setState({ searchMailboxId: '' });
    expect(renderHook(() => useFollowUp(bare)).result.current.available).toBe(false);
    // Folders of two accounts: neither.
    expect(renderHook(() => useFollowUp({ ...mail, mailboxIds: { inbox: true, 'grp:inbox': true } })).result.current.available).toBe(false);
  });

  it('offers nothing for an account the login does not reach, or a mail of another login', () => {
    expect(renderHook(() => useFollowUp({ ...mail, mailboxIds: { 'elsewhere:inbox': true } })).result.current.available).toBe(false);
    expect(renderHook(() => useFollowUp({ ...mail, sourceClientAccountId: 'other-login', sourceAccountId: 'grp' })).result.current.available).toBe(false);
  });
});

describe('useFollowUpTasks', () => {
  it('loads only the calendars follow-ups live in and keeps that scope for pushes', async () => {
    useCalendarStore.setState({
      calendars: [...calendars, { id: 'other', name: 'Other' } as Calendar, { id: 'acc2:x', name: 'Shared', isShared: true } as Calendar],
    });
    renderHook(() => useFollowUpTasks());
    await vi.waitFor(() => expect(client.getCalendarTasks).toHaveBeenCalled());
    expect(client.getCalendarTasks).toHaveBeenCalledWith(['tasks', 'events']);
    expect(useTaskStore.getState().fetchedCalendarIds).toEqual(['tasks', 'events']);
  });
});

describe('the session state of follow-ups', () => {
  const details = { action: 'Call', due: null, reminderAt: null, note: '' };
  const text = { title: (action: string, subject: string) => `${action}: ${subject}`, noSubject: '-', noTaskList: null };

  it('keeps a group mailbox\'s mail and the own mail of the same id apart', async () => {
    let finish: (() => void) | null = null;
    client.createCalendarTask.mockImplementationOnce((task: Partial<CalendarTask>) => new Promise((resolve) => {
      finish = () => resolve({ ...task, id: 'task-g', uid: 'u', updated: '' } as CalendarTask);
    }));
    const writing = followUpOnMail(client as unknown as IJMAPClient, { id: 'M1', subject: 'Offer', keywords: {} }, 'grp', details, text, null);
    await vi.waitFor(() => expect(finish).not.toBeNull());
    expect(isFollowUpPending('grp', 'M1')).toBe(true);
    expect(isFollowUpPending('acc', 'M1')).toBe(false);
    finish!();
    await writing;
    expect(isFollowUpPending('grp', 'M1')).toBe(false);

    markUnstarredHere('acc', 'M1');
    expect(unstarredHereMails('acc')).toEqual(new Set(['M1']));
    expect(unstarredHereMails('grp').size).toBe(0);
  });

  it('forgets the mails the star was taken off once another account is on screen', () => {
    markUnstarredHere('acc', 'M1');
    bumpStoreEpoch();
    expect(unstarredHereMails('acc').size).toBe(0);
  });
});
