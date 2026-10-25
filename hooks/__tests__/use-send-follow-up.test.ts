import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { dropFollowUpsOfUnsentMail, findSentCopy, followUpSentMail, resetSentFollowUps, useSendFollowUp, type SentFollowUpText } from '../use-send-follow-up';
import { useGroupTasks } from '@/stores/group-task-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useToastStore } from '@/stores/toast-store';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { DEFAULT_WORKING_TIME, REPLY_WATCH_PROPERTY } from '@/lib/follow-ups';
import { draftFollowUp, resetDraftFollowUps, storedDetails } from '@/lib/send-follow-up';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key),
}));

// The composer's "Follow up" (plan 037 decision 10): once a mail has left, its
// sent copy gets the follow-up, for the user.

const calendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'Tasks', isTasksOnly: true },
] as Calendar[];

const groupList = { id: 'grp:tasks', name: 'Tasks', isShared: true, accountId: 'grp' } as Calendar;

const sentFields = (over: Record<string, unknown> = {}) => ({
  id: 'S1',
  messageId: ['abc@example.com'],
  mailboxIds: { sent: true },
  keywords: { $seen: true },
  subject: 'Quotation SLM',
  from: [{ name: 'Me', email: 'me@example.com' }],
  receivedAt: '2026-10-26T08:00:00Z',
  ...over,
});

function makeClient() {
  let seq = 0;
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async (_ids: string[], _props: string[], _account?: string): Promise<Array<Record<string, unknown>>> => [sentFields()]),
    getMailboxes: vi.fn(async () => [{ id: 'sent', role: 'sent' }, { id: 'drafts', role: 'drafts' }]),
    queryEmailFields: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: `task-${++seq}`, uid: 'u', updated: '' }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    getCalendarTasks: vi.fn(async () => [] as CalendarTask[]),
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

const text: SentFollowUpText = {
  title: (action, subject) => `${action}: ${subject}`,
  noSubject: '(no subject)',
  followUp: 'Follow up',
  noTaskList: 'no_task_list',
  failed: 'failed',
  flagFailed: 'flag_failed',
  notFound: 'not_found',
  groupGone: 'group_gone',
};

// Monday 26.10.2026, 10:00 on the wall clock.
const MONDAY = new Date(2026, 9, 26, 10, 0);
const noWait = async () => {};

let client: ReturnType<typeof makeClient>;
const asClient = () => client as unknown as IJMAPClient;

beforeEach(() => {
  clearAllHooks();
  resetDraftFollowUps();
  resetSentFollowUps();
  useToastStore.setState({ toasts: [] });
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: asClient(), activeAccountId: 'login', username: 'me@example.com', identities: [] });
  useSettingsStore.setState({ enableCalendarTasks: true });
  useCalendarStore.setState({ supportsCalendar: true, calendars, participantIdentities: [] });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [], selectedEmail: null });
  useGroupTasks.setState({ lists: [], tasks: [] });
});

describe('findSentCopy', () => {
  it('takes the mail the send created once it is filed and carries the Message-ID', async () => {
    const copy = await findSentCopy(asClient(), { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' }, [0], noWait);
    expect(copy).toMatchObject({ id: 'S1', subject: 'Quotation SLM', messageId: 'abc@example.com' });
    // The own account: none named.
    expect(client.getEmailFields.mock.calls[0][2]).toBeUndefined();
  });

  it('waits while the copy is still a draft, and asks a group mailbox\'s account', async () => {
    client.getEmailFields
      .mockResolvedValueOnce([sentFields({ keywords: { $draft: true } })])
      .mockResolvedValueOnce([sentFields()]);
    const waited: number[] = [];
    const copy = await findSentCopy(asClient(), { emailId: 'S1', accountId: 'grp', messageId: 'abc@example.com' }, [0, 2000], async (ms) => { waited.push(ms); });
    expect(copy?.id).toBe('S1');
    expect(waited).toEqual([2000]);
    expect(client.getEmailFields.mock.calls[1][2]).toBe('grp');
    expect(client.queryEmailFields).not.toHaveBeenCalled();
  });

  it('else finds it in Sent by its Message-ID', async () => {
    client.getEmailFields.mockResolvedValue([]);
    client.queryEmailFields.mockResolvedValue([sentFields({ id: 'other', messageId: ['zzz@example.com'] }), sentFields({ id: 'S9' })]);
    const copy = await findSentCopy(asClient(), { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' }, [0], noWait);
    expect(copy?.id).toBe('S9');
    expect(client.queryEmailFields).toHaveBeenCalledWith({ inMailbox: 'sent' }, expect.any(Array), undefined, 30);
  });

  it('gives up after the last wait', async () => {
    client.getEmailFields.mockResolvedValue([]);
    expect(await findSentCopy(asClient(), { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' }, [0, 1, 1], noWait)).toBeNull();
    expect(client.getEmailFields).toHaveBeenCalledTimes(3);
  });
});

describe('followUpSentMail', () => {
  it('a no-answer choice: the own list, settling on an answer, the reminder at the day\'s start, the sent copy flagged', async () => {
    const written = await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' }, { choice: 'three-workdays' }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    expect(written).toBe(true);
    const task = client.createCalendarTask.mock.calls[0][0];
    expect(task).toMatchObject({
      title: 'Follow up: Quotation SLM',
      calendarIds: { tasks: true },
      due: '2026-10-29T00:00:00',
      alerts: null,
    });
    expect(task.links?.mail.href).toMatch(/\/mail\/message\/S1\?mailAccount=acc$/);
    const relation = task.relatedTo?.['<abc@example.com>'] as unknown as Record<string, { reminder: string }>;
    expect(new Date(relation[REPLY_WATCH_PROPERTY].reminder)).toEqual(new Date(2026, 9, 29, 8, 0));
    expect(client.toggleStar).toHaveBeenCalledWith('S1', true, 'acc');
  });

  it('from a group mailbox: only the own list, nothing set on the group\'s mail', async () => {
    useGroupTasks.setState({ lists: [{ accountId: 'grp', name: 'sales@example.com', list: groupList }] });
    await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'grp', messageId: 'abc@example.com' }, { choice: 'week' }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    const task = client.createCalendarTask.mock.calls[0][0];
    expect(task.calendarIds).toEqual({ tasks: true });
    expect(task.links?.mail.href).toMatch(/\?mailAccount=grp$/);
    expect(task.due).toBe('2026-11-02T00:00:00');
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('the dialog\'s group list when it chose it and the directory still names the group', async () => {
    useGroupTasks.setState({ lists: [{ accountId: 'grp', name: 'sales@example.com', list: groupList }] });
    const details = storedDetails({
      action: 'Call', due: new Date(2026, 10, 3), reminderAt: null, note: '', groupAccountId: 'grp',
      person: { id: 'p2', name: 'Anna', email: 'anna@example.com' },
    });
    await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'grp', messageId: 'abc@example.com' }, { choice: 'custom', details }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    const task = client.createCalendarTask.mock.calls[0][0];
    expect(task).toMatchObject({ title: 'Call: Quotation SLM', calendarIds: { 'grp:tasks': true }, due: '2026-11-03T00:00:00' });
    expect(Object.values(task.participants ?? {})[0]).toMatchObject({ calendarAddress: 'mailto:anna@example.com' });
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['task-1']);
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('the own list after all, said, when the group is no longer one the directory names', async () => {
    const details = storedDetails({ action: 'Call', due: null, reminderAt: null, note: '', groupAccountId: 'grp', person: null });
    await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'grp', messageId: 'abc@example.com' }, { choice: 'custom', details }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    expect(client.createCalendarTask.mock.calls[0][0].calendarIds).toEqual({ tasks: true });
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['group_gone']);
  });

  it('writes nothing, said, when the sent copy never shows', async () => {
    client.getEmailFields.mockResolvedValue([]);
    expect(await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' }, { choice: 'week' }, MONDAY, DEFAULT_WORKING_TIME, text, [0])).toBe(false);
    expect(client.createCalendarTask).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['not_found']);
  });

  it('nothing for an account the login does not reach', async () => {
    expect(await followUpSentMail(asClient(), { emailId: 'S1', accountId: 'elsewhere', messageId: null }, { choice: 'week' }, MONDAY, DEFAULT_WORKING_TIME, text, [0])).toBe(false);
    expect(client.getEmailFields).not.toHaveBeenCalled();
  });
});

describe('useSendFollowUp', () => {
  const result = { scheduled: false, emailId: 'S1', emailSubmissionId: 'sub', emailAccountId: 'acc', messageId: 'abc@example.com' };

  it('nothing without a choice, with tasks off, or for another login\'s mail', () => {
    const { result: hook } = renderHook(() => useSendFollowUp());
    expect(hook.current(result, {})).toBeUndefined();
    expect(hook.current(result, { followUp: { choice: 'week' }, localAccountId: 'other-login' })).toBeUndefined();
    act(() => useSettingsStore.setState({ enableCalendarTasks: false }));
    const off = renderHook(() => useSendFollowUp());
    expect(off.result.current(result, { followUp: { choice: 'week' } })).toBeUndefined();
  });

  it('writes when it runs, and keeps the choice of a send that can be taken back', async () => {
    const { result: hook } = renderHook(() => useSendFollowUp());
    const then = hook.current({ ...result, scheduled: true, sendAt: '2026-10-26T10:00:10Z' }, { followUp: { choice: 'week' } });
    expect(draftFollowUp('S1')).toEqual({ choice: 'week' });
    expect(client.createCalendarTask).not.toHaveBeenCalled();
    await act(async () => { then?.(); });
    await vi.waitFor(() => expect(client.createCalendarTask).toHaveBeenCalledTimes(1));
  });
});

describe('dropFollowUpsOfUnsentMail', () => {
  const sent = { emailId: 'S1', accountId: 'acc', messageId: 'abc@example.com' };
  const colleagues = { id: 'colleague', calendarIds: { tasks: true }, progress: 'needs-action', links: { mail: { '@type': 'Link', href: 'https://h/mail/message/S1?mailAccount=acc', rel: 'describedby' } } } as unknown as CalendarTask;

  it('takes off only the follow-up this send wrote, and its flag', async () => {
    await followUpSentMail(asClient(), sent, { choice: 'week' }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    useTaskStore.setState((s) => ({ tasks: [...s.tasks, colleagues] }));
    await dropFollowUpsOfUnsentMail(asClient(), 'S1', 'acc');
    expect(client.deleteCalendarTask.mock.calls).toEqual([['task-1']]);
    expect(client.toggleStar).toHaveBeenLastCalledWith('S1', false, 'acc');
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['colleague']);
  });

  it('a group list\'s task by its id, never another one there', async () => {
    useGroupTasks.setState({ lists: [{ accountId: 'grp', name: 'sales@example.com', list: groupList }] });
    const details = storedDetails({ action: 'Call', due: null, reminderAt: null, note: '', groupAccountId: 'grp', person: null });
    await followUpSentMail(asClient(), { ...sent, accountId: 'grp' }, { choice: 'custom', details }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    useGroupTasks.setState((s) => ({ tasks: [...s.tasks, { ...colleagues, id: 'grp-colleague', isShared: true, accountId: 'grp' } as CalendarTask] }));
    await dropFollowUpsOfUnsentMail(asClient(), 'S1', 'grp');
    expect(client.deleteCalendarTask.mock.calls).toEqual([['task-1']]);
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['grp-colleague']);
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('waits for a write still running before it takes it off', async () => {
    let release!: (v: Array<Record<string, unknown>>) => void;
    client.getEmailFields.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const writing = followUpSentMail(asClient(), sent, { choice: 'week' }, MONDAY, DEFAULT_WORKING_TIME, text, [0]);
    const dropping = dropFollowUpsOfUnsentMail(asClient(), 'S1', 'acc');
    release([sentFields()]);
    await writing;
    await dropping;
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('task-1');
    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('leaves everything alone when this session\'s sends wrote none for the mail', async () => {
    useTaskStore.setState({ tasks: [colleagues] });
    await dropFollowUpsOfUnsentMail(asClient(), 'S1', 'acc');
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(client.toggleStar).not.toHaveBeenCalled();
  });
});
