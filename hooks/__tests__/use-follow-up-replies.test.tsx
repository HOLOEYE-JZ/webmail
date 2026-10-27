import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkReplies, forgetFlaggedMails, lookForReply, useReplyChecks } from '../use-follow-up-replies';
import { useToastStore } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useTaskStore } from '@/stores/task-store';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { buildFollowUpTask } from '@/lib/follow-ups';
import { replyWatch } from '@/lib/follow-up-replies';
import { dueTaskReminders } from '@/lib/task-reminders';
import { applyPatchObject } from '@/lib/jmap/patch-object';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarTask } from '@/lib/jmap/types';

// Before a follow-up that settles on an answer reminds, its mail's thread is
// looked at; an answer completes the task instead.

interface ServerMail {
  account: string;
  threadId: string;
  messageId: string[];
  inReplyTo?: string[];
  references?: string[];
  receivedAt: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from?: { email: string }[];
}

const NOW = new Date('2026-10-28T09:30:00Z').getTime();

function makeServer() {
  const mails = new Map<string, ServerMail>();
  let tasks: CalendarTask[] = [];
  const of = (account?: string) => account ?? 'acc';
  const client = {
    getAccountId: () => 'acc',
    hasAccountCapability: vi.fn((_c: string, accountId?: string) => accountId === 'acc' || accountId === 'group'),
    getEmailFields: vi.fn(async (ids: string[], _props: string[], account?: string) => ids
      .filter((id) => mails.get(id)?.account === of(account))
      .map((id) => ({ id, ...mails.get(id) }))),
    queryEmailFields: vi.fn(async (filter: { inThread?: string }, _props: string[], account?: string) => [...mails.entries()]
      .filter(([, m]) => m.account === of(account) && m.threadId === filter.inThread)
      .map(([id, m]) => ({ id, ...m }))),
    getIdentities: vi.fn(async () => [{ id: 'i1', email: 'me@example.com' }]),
    getSharedAccounts: vi.fn(() => [{ id: 'acc', name: 'me@example.com' }, { id: 'group', name: 'sales@example.com' }]),
    getMailboxes: vi.fn(async (account?: string) => [
      { id: 'inbox', role: 'inbox', accountId: of(account) },
      { id: 'sent', role: 'sent', accountId: of(account) },
      { id: 'drafts', role: 'drafts', accountId: of(account) },
    ]),
    toggleStar: vi.fn(async (id: string, flagged: boolean, account?: string) => {
      const mail = mails.get(id);
      if (mail && mail.account === of(account)) mail.keywords = { ...mail.keywords, $flagged: flagged };
    }),
    updateCalendarTask: vi.fn(async (id: string, patch: Partial<CalendarTask>) => {
      tasks = tasks.map((t) => (t.id === id ? applyPatchObject(t, patch) : t));
      return id;
    }),
  };
  return { mails, client, tasks: () => tasks, setTasks: (t: CalendarTask[]) => { tasks = t; } };
}

let server: ReturnType<typeof makeServer>;
const asClient = () => server.client as unknown as IJMAPClient;

function followUp(id: string, emailId: string, mailAccount: string | null = null, over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    ...buildFollowUpTask({
      title: 'Follow up: Offer',
      mailUrl: `https://mail.example/mail/message/${emailId}${mailAccount ? `?mailAccount=${mailAccount}` : ''}`,
      subject: 'Offer',
      messageId: [`${emailId}@example.com`],
      calendarId: 'tasks',
      due: new Date(2026, 9, 30),
      reminderAt: new Date(NOW - 10 * 60_000),
      settlesOnReply: true,
    }),
    id,
    uid: id,
    updated: '2026-10-26T08:00:00Z',
    ...over,
  } as CalendarTask;
}

function flagged(id: string, account = 'acc', over: Partial<ServerMail> = {}) {
  server.mails.set(id, {
    account, threadId: `th-${id}`, messageId: [`${id}@example.com`], receivedAt: '2026-10-26T08:00:00Z',
    mailboxIds: { sent: true }, keywords: { $flagged: account === 'acc' }, ...over,
  });
}

function answer(id: string, to: string, account = 'acc', over: Partial<ServerMail> = {}) {
  server.mails.set(id, {
    account, threadId: `th-${to}`, messageId: [`${id}@kessler.example`], inReplyTo: [`${to}@example.com`],
    references: [`${to}@example.com`], receivedAt: '2026-10-27T10:00:00Z', mailboxIds: { inbox: true }, keywords: {}, ...over,
  });
}

async function check() {
  useTaskStore.setState({ tasks: server.tasks() });
  await checkReplies(asClient(), {
    now: () => NOW,
    lastPushMs: null,
    note: (at) => `Answer received on ${at.toISOString().slice(0, 10)}`,
  });
  server.setTasks(useTaskStore.getState().tasks);
}

const shown = () => dueTaskReminders(useTaskStore.getState().tasks, NOW, (id) => useReplyChecks.getState().checkedAt[id]);

beforeEach(() => {
  clearAllHooks();
  server = makeServer();
  useReplyChecks.getState().reset();
  forgetFlaggedMails();
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({ isAuthenticated: true, client: asClient(), activeAccountId: 'login' });
  useTaskStore.setState({ tasks: [], fetchedCalendarIds: undefined, loadedBy: null });
  useEmailStore.setState({ emails: [], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null, lastPushUpdate: null });
});

describe('checkReplies', () => {
  it('completes a follow-up an answer settled, with a note, and clears its mail\'s flag: no reminder', async () => {
    flagged('M1');
    answer('A1', 'M1');
    server.setTasks([followUp('T1', 'M1', null, { description: 'Ask about the price' })]);
    expect(dueTaskReminders(server.tasks(), NOW, () => undefined)).toEqual([]);
    await check();
    const task = server.tasks()[0];
    expect(task.progress).toBe('completed');
    expect(task.description).toBe('Ask about the price\nAnswer received on 2026-10-27');
    expect(replyWatch(task)?.answeredAt).toBe('2026-10-27T10:00:00Z');
    expect(server.mails.get('M1')?.keywords.$flagged).toBe(false);
    expect(shown()).toEqual([]);
  });

  it('lets the reminder come when no answer came', async () => {
    flagged('M1');
    server.setTasks([followUp('T1', 'M1')]);
    expect(shown()).toEqual([]);
    await check();
    expect(server.tasks()[0].progress).toBe('needs-action');
    expect(shown().map((r) => r.task.id)).toEqual(['T1']);
    expect(server.mails.get('M1')?.keywords.$flagged).toBe(true);
  });

  it('counts no mail the user sent into the thread', async () => {
    flagged('M1');
    answer('S1', 'M1', 'acc', { mailboxIds: { sent: true } });
    server.setTasks([followUp('T1', 'M1')]);
    await check();
    expect(server.tasks()[0].progress).toBe('needs-action');
  });

  it('looks in the group mailbox\'s account for a group mail\'s follow-up, and sets no flag there', async () => {
    flagged('G1', 'group');
    answer('GA', 'G1', 'group');
    server.setTasks([followUp('T1', 'G1', 'group')]);
    await check();
    expect(server.client.queryEmailFields).toHaveBeenCalledWith({ inThread: 'th-G1' }, expect.any(Array), 'group', expect.any(Number));
    expect(server.tasks()[0].progress).toBe('completed');
    expect(server.client.toggleStar).not.toHaveBeenCalled();
  });

  it('counts neither an own nudge filed elsewhere nor a group\'s answer from its own address', async () => {
    flagged('M1');
    answer('N1', 'M1', 'acc', { mailboxIds: { archive: true }, from: [{ email: 'me@example.com' }] });
    flagged('G1', 'group');
    answer('GA', 'G1', 'group', { from: [{ email: 'sales@example.com' }] });
    server.setTasks([followUp('T1', 'M1'), followUp('T2', 'G1', 'group')]);
    await check();
    expect(server.tasks().map((t) => t.progress)).toEqual(['needs-action', 'needs-action']);
  });

  it('an answer whose task cannot be written lets the reminder come, quietly', async () => {
    flagged('M1');
    answer('A1', 'M1');
    server.setTasks([followUp('T1', 'M1')]);
    server.client.updateCalendarTask.mockRejectedValue(new Error('refused'));
    await check();
    expect(server.tasks()[0].progress).toBe('needs-action');
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(shown().map((r) => r.task.id)).toEqual(['T1']);
  });

  it('lets the reminder come when the mail cannot be looked at', async () => {
    server.setTasks([followUp('T1', 'GONE'), followUp('T2', 'X1', 'elsewhere')]);
    await check();
    expect(server.tasks().map((t) => t.progress)).toEqual(['needs-action', 'needs-action']);
    expect(shown().map((r) => r.task.id).sort()).toEqual(['T1', 'T2']);
  });

  it('looks a task up only once until it is due again', async () => {
    flagged('M1');
    server.setTasks([followUp('T1', 'M1')]);
    await check();
    await check();
    expect(server.client.queryEmailFields).toHaveBeenCalledTimes(1);
  });

  it('looks a thread up again with one query: the flagged mail\'s thread is kept', async () => {
    flagged('M1');
    server.setTasks([followUp('T1', 'M1')]);
    await check();
    useReplyChecks.getState().reset();
    await check();
    expect(server.client.getEmailFields).toHaveBeenCalledTimes(1);
    expect(server.client.queryEmailFields).toHaveBeenCalledTimes(2);
  });
});

describe('lookForReply', () => {
  it('answers unknown when the server fails', async () => {
    flagged('M1');
    server.client.queryEmailFields.mockRejectedValueOnce(new Error('down'));
    const task = followUp('T1', 'M1');
    expect(await lookForReply(asClient(), task, replyWatch(task)!)).toEqual({ kind: 'unknown' });
  });
});
