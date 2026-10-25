import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFollowUp, useFollowUpTasks } from '../use-follow-ups';
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
  useEmailStore.setState({ emails: [mail], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
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
    expect(client.updateCalendarTask).toHaveBeenLastCalledWith('task-1', {
      due: null, showWithoutTime: true, progress: 'needs-action', alerts: null,
    });
    expect(flagged()).toBe(true);
  });

  it('offers nothing for a mail of a shared folder or with tasks off', () => {
    useEmailStore.setState({ mailboxes: [{ id: 'shared', isShared: true } as never], selectedMailbox: 'shared' });
    const shared = renderHook(() => useFollowUp(mail));
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
    expect(client.toggleStar).toHaveBeenCalledWith('M1', true);
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

describe('useFollowUpTasks', () => {
  it('loads only the calendars follow-ups live in and keeps that scope for pushes', async () => {
    useCalendarStore.setState({
      calendars: [...calendars, { id: 'other', name: 'Other' } as Calendar, { id: 'acc2:x', name: 'Shared', isShared: true } as Calendar],
    });
    renderHook(() => useFollowUpTasks());
    await vi.waitFor(() => expect(client.getCalendarTasks).toHaveBeenCalled());
    expect(client.getCalendarTasks).toHaveBeenCalledWith(['tasks', 'events']);
    expect(useTaskStore.getState().scope).toEqual(['tasks', 'events']);
  });
});
