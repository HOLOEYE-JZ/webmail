import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpDialog } from '../follow-up-dialog';
import { FollowUpChip, FollowUpFlagButton, FollowUpInfoBar } from '../follow-up';
import { useFollowUpDialog } from '@/hooks/use-follow-ups';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Email } from '@/lib/jmap/types';

// A few texts as the locales have them, so a title written can be read back;
// the rest is the key with its values.
const TEXTS: Record<string, string> = {
  task_title: '{action}: {subject}',
  'actions.follow_up': 'Follow up',
  'actions.call': 'Call',
  'actions.reply': 'Reply',
  no_subject: '(no subject)',
  action_other: 'Other…',
};
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const text = TEXTS[key];
    if (text) return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
    return values ? `${key}${JSON.stringify(values)}` : key;
  },
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d) }),
}));

// Monday 26.10.2026, 09:00 on the wall clock.
const NOW = new Date(2026, 9, 26, 9, 0);

const mail = {
  id: 'M1',
  threadId: 'T1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1,
  receivedAt: '2026-10-26T07:00:00Z',
  subject: 'Offer 4711',
  from: [{ name: 'Lena Brandt', email: 'lena@example.com' }],
  hasAttachment: false,
} as Email;

const calendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'My tasks', isTasksOnly: true },
] as Calendar[];

function followUp(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'task-1',
    calendarIds: { tasks: true },
    '@type': 'Task',
    uid: 'u',
    title: 'Write a quote: Offer 4711',
    description: 'Two units',
    due: '2026-10-29T00:00:00',
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
    updated: '2026-10-26T08:00:00Z',
    recurrenceRules: null,
    alerts: {
      'follow-up': {
        '@type': 'Alert',
        trigger: { '@type': 'AbsoluteTrigger', when: new Date(2026, 9, 28, 10, 0).toISOString() },
        action: 'display',
        acknowledged: null,
        relatedTo: null,
      },
    },
    relatedTo: null,
    links: {
      mail: { '@type': 'Link', href: 'https://host/mail/message/M1?mailAccount=acc', cid: null, contentType: null, size: null, rel: 'describedby', display: null, title: 'Offer 4711' },
    },
    ...over,
  };
}

function makeClient() {
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async () => [{ id: 'M1', messageId: ['offer@example.com'] }]),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: 'task-new', uid: 'u', updated: '' }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
  };
}

let client: ReturnType<typeof makeClient>;
const flagged = () => !!useEmailStore.getState().emails[0].keywords.$flagged;
const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [{ ...mail, keywords: { ...mail.keywords } }], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FollowUpDialog', () => {
  it('writes a new follow-up with its action, due day, reminder and note, and flags the mail', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="action" onClose={onClose} />);

    // A new one starts as Outlook's Custom does: due tomorrow, no reminder.
    expect(field('follow-up-action').value).toBe('Follow up');
    expect(field('follow-up-due').value).toBe('2026-10-27');
    expect(field('follow-up-reminder-on').checked).toBe(false);
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('kept_in{"list":"My tasks"}');

    fireEvent.change(field('follow-up-action'), { target: { value: 'Call' } });
    fireEvent.click(screen.getByTestId('follow-up-dialog-this-week'));
    // The quick choice sets the reminder too: two working days on, at 08:00.
    expect(field('follow-up-due').value).toBe('2026-10-30');
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(field('follow-up-reminder-day').value).toBe('2026-10-28');
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '10:30' } });
    fireEvent.change(screen.getByTestId('follow-up-note'), { target: { value: 'Ask for the drawing' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.createCalendarTask).toHaveBeenCalledTimes(1);
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written).toMatchObject({
      title: 'Call: Offer 4711',
      description: 'Ask for the drawing',
      due: '2026-10-30T00:00:00',
      calendarIds: { tasks: true },
    });
    expect(new Date(written.alerts!['follow-up'].trigger['@type'] === 'AbsoluteTrigger' ? written.alerts!['follow-up'].trigger.when : '')).toEqual(new Date(2026, 9, 28, 10, 30));
    expect(flagged()).toBe(true);
  });

  it('reads every field back from the task', () => {
    useTaskStore.setState({ tasks: [followUp()] });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: ['Write a quote'] } });
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);

    // An operator's action is one of the list.
    expect(field('follow-up-action').value).toBe('Write a quote');
    expect(screen.queryByTestId('follow-up-action-text')).toBeNull();
    expect(field('follow-up-due').value).toBe('2026-10-29');
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(field('follow-up-reminder-day').value).toBe('2026-10-28');
    expect(field('follow-up-reminder-time').value).toBe('10:00');
    expect(field('follow-up-note').value).toBe('Two units');
    expect(screen.getByTestId('follow-up-dialog-remove')).toBeTruthy();
  });

  it('shows an action of the user\'s own as free text', () => {
    useTaskStore.setState({ tasks: [followUp()] });
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    expect(field('follow-up-action').value).toBe('\u0000other');
    expect(field('follow-up-action-text').value).toBe('Write a quote');
  });

  it('keeps the title while the action stays, and writes it anew when it changes', async () => {
    useTaskStore.setState({ tasks: [followUp({ title: 'Write a quote: Offer 4711' })] });
    const first = render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.click(field('follow-up-reminder-on'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][1]).toEqual({ due: '2026-10-29T00:00:00', showWithoutTime: true, alerts: null });
    first.unmount();

    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.change(field('follow-up-action-text'), { target: { value: 'Send the drawing' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(2));
    expect(client.updateCalendarTask.mock.calls[1][1]).toMatchObject({ title: 'Send the drawing: Offer 4711' });
  });

  it('removes task and flag', async () => {
    useEmailStore.setState({ emails: [{ ...mail, keywords: { $seen: true, $flagged: true } }] });
    useTaskStore.setState({ tasks: [followUp()] });
    const onClose = vi.fn();
    render(<FollowUpDialog email={useEmailStore.getState().emails[0]} focus="action" onClose={onClose} />);
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-remove')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.deleteCalendarTask).toHaveBeenCalledWith('task-1');
    expect(flagged()).toBe(false);
  });

  it('"Add reminder" turns the reminder on with a proposal and puts the cursor on its time', async () => {
    render(<FollowUpDialog email={mail} focus="reminder" onClose={vi.fn()} />);
    expect(field('follow-up-reminder-on').checked).toBe(true);
    // Due tomorrow, reminded when tomorrow's work starts.
    expect(field('follow-up-reminder-day').value).toBe('2026-10-27');
    expect(field('follow-up-reminder-time').value).toBe('08:00');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('follow-up-reminder-time')));
  });
});

describe('FollowUpDialog: the reminder', () => {
  it('proposes a time to come when the reminder is turned on', () => {
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    expect(field('follow-up-reminder-day').value).toBe('');
    fireEvent.click(field('follow-up-reminder-on'));
    // Due tomorrow: reminded when tomorrow's work starts, not this morning.
    expect(field('follow-up-reminder-day').value).toBe('2026-10-27');
    expect(field('follow-up-reminder-time').value).toBe('08:00');
  });

  it('refuses a reminder set to a time gone by, saying so at the field', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="reminder" onClose={onClose} />);
    fireEvent.change(field('follow-up-reminder-day'), { target: { value: '2026-10-26' } });
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '08:30' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    expect(screen.getByTestId('follow-up-reminder-past')).toBeTruthy();
    expect(field('follow-up-reminder-time').getAttribute('aria-invalid')).toBe('true');
    expect(client.createCalendarTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '11:00' } });
    expect(screen.queryByTestId('follow-up-reminder-past')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps a reminder that has come already when only the note changes', async () => {
    const past = new Date(2026, 9, 26, 8, 0).toISOString();
    const task = followUp();
    task.alerts = {
      'follow-up': { ...task.alerts!['follow-up'], trigger: { '@type': 'AbsoluteTrigger', when: past }, acknowledged: '2026-10-26T07:01:00Z' },
      phone: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display', acknowledged: null, relatedTo: null },
    };
    useTaskStore.setState({ tasks: [task] });
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="action" onClose={onClose} />);
    // The relative one is not shown, but said.
    expect(screen.getByTestId('follow-up-other-reminders').textContent).toBe('other_reminders{"count":1}');
    fireEvent.change(screen.getByTestId('follow-up-note'), { target: { value: 'Three units' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = client.updateCalendarTask.mock.calls[0][1];
    expect(patch).toMatchObject({ description: 'Three units' });
    expect(patch).not.toHaveProperty('alerts');
  });
});

describe('a follow-up written in another language', () => {
  it('reads a German default action as the default, and keeps its title when saved', async () => {
    useTaskStore.setState({ tasks: [followUp({ title: 'Nachverfolgen: Offer 4711' })] });
    const chip = render(<FollowUpChip email={mail} />);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^due_on/);
    chip.unmount();

    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="action" onClose={onClose} />);
    expect(field('follow-up-action').value).toBe('Follow up');
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.updateCalendarTask.mock.calls[0][1]).not.toHaveProperty('title');
  });

  it('shows a German built-in action in the current language', () => {
    useTaskStore.setState({ tasks: [followUp({ title: 'Anrufen: Offer 4711' })] });
    render(<FollowUpChip email={mail} />);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^Call · due_on/);
  });
});

describe('the follow-up menu', () => {
  it('"Custom…" and "Add reminder…" open the dialog for the mail', () => {
    render(<FollowUpFlagButton email={mail} />);
    fireEvent.contextMenu(screen.getByTestId('follow-up-flag'));
    fireEvent.click(screen.getByTestId('follow-up-custom'));
    expect(useFollowUpDialog.getState()).toMatchObject({ email: mail, focus: 'action' });

    fireEvent.contextMenu(screen.getByTestId('follow-up-flag'));
    fireEvent.click(screen.getByTestId('follow-up-add-reminder'));
    expect(useFollowUpDialog.getState()).toMatchObject({ email: mail, focus: 'reminder' });
  });
});

describe('what the row and the reader show', () => {
  it('the info bar names the action, the due day, the reminder and the note, and opens the dialog', () => {
    useTaskStore.setState({ tasks: [followUp()] });
    render(<FollowUpInfoBar email={mail} />);
    expect(screen.getByTestId('follow-up-bar-action').textContent).toBe('Write a quote');
    expect(screen.getByTestId('follow-up-bar-reminder')).toBeTruthy();
    expect(screen.getByTestId('follow-up-bar-note').textContent).toBe('bar_note{"note":"Two units"}');
    fireEvent.click(screen.getByTestId('follow-up-bar-change'));
    expect(useFollowUpDialog.getState()).toMatchObject({ email: mail, focus: 'action' });
  });

  it('the chip names an action other than the default and the reminder', () => {
    useTaskStore.setState({ tasks: [followUp()] });
    const { unmount } = render(<FollowUpChip email={mail} />);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^Write a quote · due_on/);
    expect(screen.getByTestId('follow-up-chip-reminder')).toBeTruthy();
    unmount();

    useTaskStore.setState({ tasks: [followUp({ title: 'Follow up: Offer 4711', alerts: null })] });
    render(<FollowUpChip email={mail} />);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^due_on/);
    expect(screen.queryByTestId('follow-up-chip-reminder')).toBeNull();
  });
});
