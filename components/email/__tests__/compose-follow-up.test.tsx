import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeFollowUp } from '../compose-follow-up';
import { useGroupTasks } from '@/hooks/use-group-follow-ups';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { detailsOf, type SendFollowUp } from '@/lib/send-follow-up';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

const TEXTS: Record<string, string> = {
  'actions.follow_up': 'Follow up',
  custom: 'Custom…',
  'send.no_answer_by': 'Remind me if no answer by {day}',
};
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const text = TEXTS[key];
    if (text) return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
    return values ? `${key}${JSON.stringify(values)}` : key;
  },
  useLocale: () => 'en',
  // Days as "29.10.", so the choices can be read.
  useFormatter: () => ({ dateTime: (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.` }),
}));

// Monday 26.10.2026, 09:00 on the wall clock.
const NOW = new Date(2026, 9, 26, 9, 0);

const calendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'My tasks', isTasksOnly: true },
] as Calendar[];

function makeClient(fromAccount = 'acc') {
  return {
    getAccountId: () => 'acc',
    resolveSendAccountId: vi.fn(async () => fromAccount),
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  } as unknown as IJMAPClient;
}

function Row({ client, initial = null, onChange }: { client: IJMAPClient; initial?: SendFollowUp | null; onChange: (v: SendFollowUp | null) => void }) {
  return (
    <ComposeFollowUp
      value={initial}
      onChange={onChange}
      client={client}
      fromEmail="me@example.com"
      fromName="Me"
      subject="Quotation SLM"
    />
  );
}

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'login', username: 'me@example.com', identities: [] });
  useSettingsStore.setState({ enableCalendarTasks: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars, participantIdentities: [] });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useEmailStore.setState({ mailboxes: [] });
  useGroupTasks.setState({ lists: [], tasks: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ComposeFollowUp', () => {
  it('offers none, three working days, a week and custom, with their days', async () => {
    render(<Row client={makeClient()} onChange={vi.fn()} />);
    await act(async () => {});
    const options = Array.from((field('composer-follow-up-choice') as unknown as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual([
      'send.none',
      'Remind me if no answer by 29.10.',
      'Remind me if no answer by 2.11.',
      'Custom…',
    ]);
  });

  it('a no-answer choice is kept as the composer\'s, with what it does said', async () => {
    const onChange = vi.fn();
    const client = makeClient();
    const { rerender } = render(<Row client={client} onChange={onChange} />);
    await act(async () => {});
    fireEvent.change(field('composer-follow-up-choice'), { target: { value: 'three-workdays' } });
    expect(onChange).toHaveBeenCalledWith({ choice: 'three-workdays' });
    rerender(<Row client={client} initial={{ choice: 'three-workdays' }} onChange={onChange} />);
    expect(screen.getByTestId('composer-follow-up-hint').textContent).toBe('send.hint_no_answer send.where_own');
    fireEvent.change(field('composer-follow-up-choice'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('custom opens the dialog before sending, settling on an answer three working days on, and keeps its choices', async () => {
    const onChange = vi.fn();
    render(<Row client={makeClient()} onChange={onChange} />);
    await act(async () => {});
    fireEvent.change(field('composer-follow-up-choice'), { target: { value: 'custom' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('follow-up-hint').textContent).toBe('send.dialog_hint');
    expect(field('follow-up-due').value).toBe('2026-10-29');
    expect(field('follow-up-settles-on-reply').checked).toBe(true);
    fireEvent.click(screen.getByTestId('follow-up-action'));
    fireEvent.click(screen.getByRole('option', { name: 'actions.call' }));
    fireEvent.click(screen.getByTestId('follow-up-note-add'));
    fireEvent.change(field('follow-up-note'), { target: { value: 'ask for the order' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const value = onChange.mock.calls[0][0] as Extract<SendFollowUp, { choice: 'custom' }>;
    expect(value.choice).toBe('custom');
    expect(detailsOf(value.details)).toMatchObject({
      action: 'actions.call',
      due: new Date(2026, 9, 29),
      note: 'ask for the order',
      settlesOnReply: true,
      groupAccountId: null,
    });
    expect(screen.queryByTestId('follow-up-dialog')).toBeNull();
  });

  it('from a group mailbox: only mine by default, the group\'s list when the dialog chooses it', async () => {
    const list = { id: 'grp:tasks', name: 'Tasks', isShared: true, accountId: 'grp' } as Calendar;
    useGroupTasks.setState({ lists: [{ accountId: 'grp', name: 'sales@example.com', list }] });
    const onChange = vi.fn();
    const client = makeClient('grp');
    const { rerender } = render(<Row client={client} initial={{ choice: 'week' }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByTestId('composer-follow-up-hint').textContent).toContain('send.where_group'));

    fireEvent.change(field('composer-follow-up-choice'), { target: { value: 'custom' } });
    expect(screen.getByTestId('follow-up-kept').textContent).toContain('kept_only_me');
    fireEvent.click(screen.getByTestId('follow-up-visible'));
    fireEvent.click(screen.getByTestId('follow-up-visible-group'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    const value = onChange.mock.calls[0][0] as Extract<SendFollowUp, { choice: 'custom' }>;
    expect(value.details.groupAccountId).toBe('grp');
    expect(value.details.person).toBeNull();

    // Opened again, it shows what was chosen.
    rerender(<Row client={client} initial={value} onChange={onChange} />);
    expect(screen.getByTestId('composer-follow-up-hint').textContent).toContain('group.list_of');
    fireEvent.click(screen.getByTestId('composer-follow-up-change'));
    expect(screen.getByTestId('follow-up-visible').textContent).toBe('sales@example.com');
    fireEvent.click(screen.getByTestId('follow-up-visible'));
    expect(screen.getByTestId('follow-up-visible-group').getAttribute('aria-selected')).toBe('true');
  });

  it('shows nothing while follow-ups are off', () => {
    useSettingsStore.setState({ enableCalendarTasks: false });
    render(<Row client={makeClient()} onChange={vi.fn()} />);
    expect(screen.queryByTestId('composer-follow-up')).toBeNull();
  });
});
