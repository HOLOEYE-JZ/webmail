import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { locateFollowUpMail, useFollowUpSync } from '../use-follow-up-sync';
import { forgetUnstarredHere, useFollowUp } from '../use-follow-ups';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { clearAllHooks, taskHooks } from '@/lib/plugin-hooks';
import { buildFollowUpTask, followUpMailRef } from '@/lib/follow-ups';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarTask, Email } from '@/lib/jmap/types';

// The follow-up's task is the original, the mail's $flagged its mirror. Both
// are changed elsewhere too (the task list, a phone, another mail client);
// each check brings the other side along.

interface ServerMail { keywords: Record<string, boolean>; from?: { name?: string; email: string }[]; messageId?: string[] }

function followUp(id: string, emailId: string, over: Partial<CalendarTask> = {}, mailAccount = 'acc'): CalendarTask {
  return {
    ...buildFollowUpTask({
      title: 'Follow up: Offer',
      mailUrl: `https://mail.example/mail/message/${emailId}?mailAccount=${mailAccount}`,
      subject: 'Offer',
      messageId: [`${emailId}@example.com`],
      from: { name: 'Rita Vogt', email: 'rita@kessler.example' },
      calendarId: 'tasks',
      due: null,
      reminderAt: null,
    }),
    id,
    uid: id,
    updated: '2026-10-26T08:00:00Z',
    ...over,
  } as CalendarTask;
}

function makeServer() {
  const server = {
    mails: new Map<string, ServerMail>(),
    tasks: [] as CalendarTask[],
    /** Whether the next task loads read every task; false: they lose `missing`. */
    complete: true,
    missing: [] as string[],
  };
  const client = {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async (ids: string[]) => ids
      .filter((id) => server.mails.has(id))
      .map((id) => ({ id, ...server.mails.get(id) }))),
    queryEmailFields: vi.fn(async (filter: { header?: string[] }) => [...server.mails.entries()]
      .filter(([, m]) => m.messageId?.some((mid) => `<${mid}>` === filter.header?.[1]))
      .map(([id, m]) => ({ id, messageId: m.messageId }))),
    toggleStar: vi.fn(async (id: string, flagged: boolean) => {
      const mail = server.mails.get(id);
      if (mail) mail.keywords = { ...mail.keywords, $flagged: flagged };
    }),
    getCalendarTasks: vi.fn(async () => server.tasks.map((t) => ({ ...t }))),
    getCalendarTaskList: vi.fn(async () => ({
      tasks: server.tasks.filter((t) => server.complete || !server.missing.includes(t.id)).map((t) => ({ ...t })),
      complete: server.complete,
    })),
    updateCalendarTask: vi.fn(async (id: string, patch: Partial<CalendarTask>) => {
      server.tasks = server.tasks.map((t) => (t.id === id ? { ...t, ...patch, updated: '2026-10-26T09:00:00Z' } : t));
      return id;
    }),
    deleteCalendarTask: vi.fn(async (id: string) => { server.tasks = server.tasks.filter((t) => t.id !== id); }),
  };
  return { server, client };
}

let server: ReturnType<typeof makeServer>['server'];
let client: ReturnType<typeof makeServer>['client'];
const asClient = () => client as unknown as IJMAPClient;

const flagOf = (id: string) => !!server.mails.get(id)?.keywords.$flagged;

/** The tasks as a fetch (a push, the task list) loads them, then the checks that follow. */
async function load() {
  await act(async () => {
    await useTaskStore.getState().fetchTasks(asClient(), ['tasks']);
    await vi.advanceTimersByTimeAsync(5000);
  });
}

/** A push: something changed in the account, a mail's keywords perhaps. */
async function push() {
  await act(async () => {
    useEmailStore.setState({ lastPushUpdate: Date.now() + Math.random() });
    await vi.advanceTimersByTimeAsync(5000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  forgetUnstarredHere('M1');
  clearAllHooks();
  ({ server, client } = makeServer());
  useAuthStore.setState({ isAuthenticated: true, client: asClient(), activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true });
  useCalendarStore.setState({ supportsCalendar: true, calendars: [] });
  useTaskStore.setState({ tasks: [], scope: undefined, loadedBy: null });
  useEmailStore.setState({ emails: [], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null, lastPushUpdate: null });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A follow-up open on a flagged mail, seen in step once. */
async function inStep() {
  server.mails.set('M1', { keywords: { $flagged: true }, messageId: ['M1@example.com'] });
  server.tasks = [followUp('T1', 'M1')];
  renderHook(() => useFollowUpSync());
  await load();
  expect(client.toggleStar).not.toHaveBeenCalled();
}

describe('useFollowUpSync', () => {
  it('clears the flag when the task is completed elsewhere', async () => {
    await inStep();
    server.tasks = [{ ...server.tasks[0], progress: 'completed', updated: '2026-10-26T10:00:00Z' }];
    await load();
    expect(flagOf('M1')).toBe(false);
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('clears the flag when the task is deleted elsewhere', async () => {
    await inStep();
    server.tasks = [];
    await load();
    expect(flagOf('M1')).toBe(false);
  });

  it('clears the flag when the task is completed in Bulwark\'s task list', async () => {
    await inStep();
    await act(async () => {
      await useTaskStore.getState().toggleTaskComplete(asClient(), useTaskStore.getState().tasks[0]);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(flagOf('M1')).toBe(false);
  });

  it('sets the flag again when the task is reopened', async () => {
    await inStep();
    server.tasks = [{ ...server.tasks[0], progress: 'completed', updated: '2026-10-26T10:00:00Z' }];
    await load();
    server.tasks = [{ ...server.tasks[0], progress: 'needs-action', updated: '2026-10-26T11:00:00Z' }];
    await load();
    expect(flagOf('M1')).toBe(true);
  });

  it('deletes the open task when the flag is cleared elsewhere, as Outlook\'s Clear Flag', async () => {
    await inStep();
    server.mails.get('M1')!.keywords = {};
    await push();
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('T1');
    expect(server.tasks).toEqual([]);
    expect(useTaskStore.getState().tasks).toEqual([]);
    // Its own delete starts nothing further.
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('keeps a task completed in another tab a moment ago: the flag it cleared deletes nothing', async () => {
    await inStep();
    // The other tab completed the task and cleared the flag; this tab's list still has it open.
    server.tasks = [{ ...server.tasks[0], progress: 'completed', updated: '2026-10-26T10:00:00Z' }];
    server.mails.get('M1')!.keywords = {};
    await push();
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0].progress).toBe('completed');
  });

  it('leaves a flag set elsewhere on a mail without a follow-up', async () => {
    await inStep();
    server.mails.set('M2', { keywords: { $flagged: true } });
    await push();
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(client.getEmailFields).not.toHaveBeenCalledWith(expect.arrayContaining(['M2']), expect.anything());
  });

  it('leaves a flag set elsewhere on a mail whose follow-up is done', async () => {
    server.mails.set('M1', { keywords: {} });
    server.tasks = [followUp('T1', 'M1', { progress: 'completed' })];
    renderHook(() => useFollowUpSync());
    await load();
    server.mails.get('M1')!.keywords = { $flagged: true };
    await push();
    await load();
    expect(flagOf('M1')).toBe(true);
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('starts no further change from its own writes', async () => {
    await inStep();
    server.tasks = [{ ...server.tasks[0], progress: 'completed', updated: '2026-10-26T10:00:00Z' }];
    await load();
    expect(client.toggleStar).toHaveBeenCalledTimes(1);
    await push();
    await load();
    await push();
    expect(client.toggleStar).toHaveBeenCalledTimes(1);
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(client.updateCalendarTask).not.toHaveBeenCalled();
  });

  it('flags the mail of a follow-up written here, and then finds it in step', async () => {
    server.mails.set('M1', { keywords: {}, messageId: ['M1@example.com'], from: [{ name: 'Rita Vogt', email: 'rita@kessler.example' }] });
    const mail = { id: 'M1', threadId: 'X', mailboxIds: { inbox: true }, keywords: {}, size: 1, receivedAt: '2026-10-26T07:00:00Z', subject: 'Offer', from: [{ name: 'Rita Vogt', email: 'rita@kessler.example' }] } as unknown as Email;
    useEmailStore.setState({ emails: [mail] });
    useCalendarStore.setState({ calendars: [{ id: 'tasks', name: 'Tasks', isTasksOnly: true }] as never });
    Object.assign(client, {
      createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => {
        const created = { ...task, id: 'T9', uid: 'T9', updated: '2026-10-26T08:00:00Z' } as CalendarTask;
        server.tasks.push(created);
        return created;
      }),
      getEmailFields: client.getEmailFields,
    });
    renderHook(() => useFollowUpSync());
    await load();
    const { result } = renderHook(() => useFollowUp(useEmailStore.getState().emails[0]));
    await act(async () => {
      await result.current.apply('today');
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(flagOf('M1')).toBe(true);
    expect(server.tasks[0].links?.from).toMatchObject({ title: 'Rita Vogt' });
    await load();
    await push();
    expect(client.toggleStar).toHaveBeenCalledTimes(1);
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('leaves the follow-ups of another account\'s mail alone', async () => {
    server.mails.set('M1', { keywords: {} });
    server.tasks = [followUp('T1', 'M1', {}, 'group')];
    renderHook(() => useFollowUpSync());
    await load();
    expect(client.getEmailFields).not.toHaveBeenCalled();
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('judges no task deleted from a list not loaded (another login, a fetch under way)', async () => {
    await inStep();
    await act(async () => {
      useTaskStore.getState().clearTasks();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('keeps the task of a deleted mail', async () => {
    await inStep();
    server.mails.delete('M1');
    await push();
    await load();
    expect(server.tasks).toHaveLength(1);
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('adds the sender to a follow-up written before it was kept', async () => {
    const older = followUp('T1', 'M1');
    delete older.links!.from;
    server.mails.set('M1', { keywords: { $flagged: true }, from: [{ name: 'Rita Vogt', email: 'rita@kessler.example' }] });
    server.tasks = [older];
    renderHook(() => useFollowUpSync());
    await load();
    expect(server.tasks[0].links?.from).toMatchObject({ href: 'mailto:rita@kessler.example', title: 'Rita Vogt' });
  });
});

describe('useFollowUpSync takes nothing away on a list read in part', () => {
  it('changes nothing when a load fails and lists no task', async () => {
    await inStep();
    server.complete = false;
    server.missing = ['T1'];
    await load();
    expect(useTaskStore.getState().loadedBy).toBeNull();
    expect(flagOf('M1')).toBe(true);
    expect(client.toggleStar).not.toHaveBeenCalled();
    // Nor does a push afterwards, nor one whose flag was cleared elsewhere.
    server.mails.get('M1')!.keywords = {};
    await push();
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(server.tasks).toHaveLength(1);
  });

  it('deletes no task for a cleared flag when the reload before it is read in part', async () => {
    await inStep();
    server.mails.get('M1')!.keywords = {};
    server.complete = false;
    await push();
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    // Once the task list loads in full again, the Clear Flag goes through.
    server.complete = true;
    await load();
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('T1');
  });

  it('clears no flag for a task the list lacks until a complete load shows it gone', async () => {
    await inStep();
    // The list lost the task here; the reload before clearing its flag is read in part and lacks it too.
    server.complete = false;
    server.missing = ['T1'];
    await act(async () => {
      useTaskStore.setState({ tasks: [] });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.toggleStar).not.toHaveBeenCalled();
  });
});

describe('useFollowUpSync tries again after a failure', () => {
  it('clears the flag of a completed task at the next check when the first write failed', async () => {
    await inStep();
    client.toggleStar.mockRejectedValueOnce(new Error('down'));
    server.tasks = [{ ...server.tasks[0], progress: 'completed', updated: '2026-10-26T10:00:00Z' }];
    await load();
    expect(flagOf('M1')).toBe(true);
    await push();
    expect(flagOf('M1')).toBe(false);
  });

  it('deletes the task at the next check when the first delete failed', async () => {
    await inStep();
    client.deleteCalendarTask.mockRejectedValueOnce(new Error('down'));
    server.mails.get('M1')!.keywords = {};
    await push();
    expect(server.tasks).toHaveLength(1);
    await push();
    expect(server.tasks).toEqual([]);
    expect(flagOf('M1')).toBe(false);
  });
});

describe('the star taken off in the app', () => {
  const row = { id: 'M1', threadId: 'X', mailboxIds: { inbox: true }, keywords: { $flagged: true }, size: 1, receivedAt: '2026-10-26T07:00:00Z', subject: 'Offer' } as unknown as Email;

  it('completes the follow-up, never deletes it', async () => {
    useEmailStore.setState({ emails: [row] });
    await inStep();
    await act(async () => {
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      // The push of its own write comes at once.
      useEmailStore.setState({ lastPushUpdate: Date.now() });
      await vi.advanceTimersByTimeAsync(5000);
    });
    await push();
    await load();
    expect(flagOf('M1')).toBe(false);
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(server.tasks[0].progress).toBe('completed');
  });

  it('puts the star back when the follow-up cannot be completed', async () => {
    useEmailStore.setState({ emails: [row] });
    await inStep();
    taskHooks.onBeforeTaskUpdate.register('t', () => false);
    await act(async () => {
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      await vi.advanceTimersByTimeAsync(5000);
    });
    await push();
    expect(flagOf('M1')).toBe(true);
    expect(server.tasks[0].progress).toBe('needs-action');
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('completes a follow-up whose star was taken off before the task list held it', async () => {
    useEmailStore.setState({ emails: [row] });
    await inStep();
    // The list is not loaded (just opened, another scope) when the star comes off.
    await act(async () => {
      useTaskStore.getState().clearTasks();
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      useEmailStore.setState({ lastPushUpdate: Date.now() });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(server.tasks[0].progress).toBe('needs-action');
    await load();
    await push();
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(server.tasks[0].progress).toBe('completed');
    expect(flagOf('M1')).toBe(false);
  });

  it('never deletes the follow-up when neither completing it nor putting the star back works', async () => {
    useEmailStore.setState({ emails: [row] });
    await inStep();
    const veto = taskHooks.onBeforeTaskUpdate.register('t', () => false);
    await act(async () => {
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      client.toggleStar.mockRejectedValue(new Error('down'));
      await vi.advanceTimersByTimeAsync(5000);
    });
    await push();
    await load();
    await push();
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(server.tasks[0].progress).toBe('needs-action');
    // Once the task can be written, the next check completes it.
    veto.dispose();
    client.toggleStar.mockReset();
    await load();
    expect(server.tasks[0].progress).toBe('completed');
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('lifts the mark when the star is set again in the app: a later Clear Flag elsewhere deletes as usual', async () => {
    useEmailStore.setState({ emails: [row] });
    await inStep();
    await act(async () => {
      useTaskStore.getState().clearTasks();
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      await useEmailStore.getState().toggleStar(asClient(), 'M1');
      await vi.advanceTimersByTimeAsync(5000);
    });
    await load();
    expect(flagOf('M1')).toBe(true);
    server.mails.get('M1')!.keywords = {};
    await push();
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('T1');
  });

  it('leaves the follow-up of a star taken off another account\'s mail alone', async () => {
    useEmailStore.setState({ emails: [{ ...row, sourceAccountId: 'group' } as Email] });
    await inStep();
    await act(async () => {
      await useEmailStore.getState().toggleStar(asClient(), 'M1', 'group:M1');
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.updateCalendarTask).not.toHaveBeenCalled();
    expect(server.tasks[0].progress).toBe('needs-action');
  });
});

describe('locateFollowUpMail', () => {
  it('finds a moved mail by its id, which a move keeps', async () => {
    server.mails.set('M1', { keywords: {} });
    expect(await locateFollowUpMail(asClient(), followUp('T1', 'M1'))).toEqual({ kind: 'present', emailId: 'M1' });
  });

  it('finds a mail under a new id by its Message-ID and points the task at it', async () => {
    server.mails.set('M7', { keywords: {}, messageId: ['M1@example.com'] });
    const task = followUp('T1', 'M1');
    server.tasks = [task];
    useTaskStore.setState({ tasks: [task] });
    expect(await locateFollowUpMail(asClient(), task)).toEqual({ kind: 'present', emailId: 'M7' });
    expect(followUpMailRef(server.tasks[0])).toEqual({ emailId: 'M7', accountId: 'acc' });
  });

  it('says a deleted mail is gone', async () => {
    expect(await locateFollowUpMail(asClient(), followUp('T1', 'M1'))).toEqual({ kind: 'gone' });
  });

  it('offers the link as it is when the server cannot be asked', async () => {
    client.getEmailFields.mockRejectedValueOnce(new Error('down'));
    expect(await locateFollowUpMail(asClient(), followUp('T1', 'M1'))).toEqual({ kind: 'unknown', emailId: 'M1' });
  });
});
