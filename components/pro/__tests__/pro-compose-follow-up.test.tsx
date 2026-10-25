import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ProComposeTabBody } from '../pro-compose-tab-body';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useGroupTasks } from '@/stores/group-task-store';
import { resetSentFollowUps } from '@/hooks/use-send-follow-up';
import { cancelAnnouncedSend, resetAnnouncedSends } from '@/lib/plugin-after-send';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// The host path of the composer's "Follow up": the
// compose tab hands the send to the store, then writes the follow-up on the
// sent copy once the mail has left. An undo hold (the "send delay" setting,
// submitted as delayedUntil) holds it back; a send undone writes nothing.

const payload = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (d: Record<string, unknown>) => Promise<void> }) =>
    React.createElement('button', { onClick: () => { void onSend?.(payload.current); } }, 'send'),
}));

vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));

const calendars = [{ id: 'tasks', name: 'Tasks', isTasksOnly: true }] as Calendar[];

function makeClient() {
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async () => [{
      id: 'S1', messageId: ['abc@example.com'], mailboxIds: { sent: true }, keywords: { $seen: true }, subject: 'Quotation',
    }]),
    getMailboxes: vi.fn(async () => []),
    queryEmailFields: vi.fn(async () => []),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: 'task-1', uid: 'u', updated: '' }) as CalendarTask),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    getCalendarTasks: vi.fn(async () => [] as CalendarTask[]),
    hasAccountCapability: vi.fn(() => true),
    getThreadEmails: vi.fn(async () => []),
  };
}

let client: ReturnType<typeof makeClient>;

function sendResult(scheduled: boolean) {
  return {
    scheduled,
    emailId: 'S1',
    emailSubmissionId: 'sub-1',
    emailAccountId: 'acc',
    messageId: 'abc@example.com',
    ...(scheduled ? { sendAt: new Date(Date.now() + 10_000).toISOString() } : {}),
  };
}

const data = { sessionId: 1, mode: 'compose' } as never;

async function send(body: Record<string, unknown>, scheduled: boolean) {
  useEmailStore.setState({ sendEmail: vi.fn(async () => sendResult(scheduled)) as never });
  payload.current = { to: ['bob@example.com'], cc: [], bcc: [], subject: 'Quotation', body: 'Hi', followUp: { choice: 'week' }, ...body };
  render(<ProComposeTabBody tabId="t1" data={data} />);
  await act(async () => { fireEvent.click(screen.getByText('send')); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(2026, 9, 26, 9, 0));
  resetAnnouncedSends();
  resetSentFollowUps();
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login', username: 'me@example.com', identities: [] });
  useSettingsStore.setState({ enableCalendarTasks: true, calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars });
  useTaskStore.setState({ tasks: [] });
  useGroupTasks.setState({ lists: [], tasks: [] });
  useEmailStore.setState({
    emails: [], selectedEmail: null, isScheduledView: false,
    refreshCurrentMailbox: vi.fn(async () => {}) as never,
    refreshScheduledMetadata: vi.fn(async () => {}) as never,
    fetchScheduledEmails: vi.fn(async () => {}) as never,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the compose tab\'s follow-up after sending', () => {
  it('writes it at once for a plain send', async () => {
    await send({}, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
  });

  it('holds it while an undo hold runs, then writes it', async () => {
    await send({ delayedUntil: new Date(Date.now() + 10_000).toISOString(), undoHold: true }, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(client.createCalendarTask).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
  });

  it('never writes it for a send undone in the hold', async () => {
    await send({ delayedUntil: new Date(Date.now() + 10_000).toISOString(), undoHold: true }, true);
    cancelAnnouncedSend('sub-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(client.createCalendarTask).not.toHaveBeenCalled();
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('writes it at once for a send the user scheduled for later', async () => {
    await send({ delayedUntil: '2026-10-30T08:00:00.000Z' }, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
  });
});
