import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpcomingPane } from '../upcoming-pane';
import { FollowUpDialogHost } from '../follow-up-dialog';
import { useFollowUpDialog } from '@/hooks/use-follow-ups';
import { useDueTaskCount } from '@/hooks/use-upcoming';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { buildFollowUpTask, buildReminderTask } from '@/lib/follow-ups';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Email } from '@/lib/jmap/types';

const TEXTS: Record<string, string> = {
  task_title: '{action}: {subject}',
  'actions.follow_up': 'Follow up',
  'actions.call': 'Call',
  bar_action: 'Follow up',
  no_subject: '(no subject)',
  'upcoming.no_mail': 'Reminder without a mail',
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

// Wednesday 28.10.2026, 10:30 on the wall clock.
const NOW = new Date(2026, 9, 28, 10, 30);

const calendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'My tasks', isTasksOnly: true },
] as Calendar[];

const mail = {
  id: 'M1',
  threadId: 'T1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true, $flagged: true },
  size: 1,
  receivedAt: '2026-10-26T07:00:00Z',
  subject: 'Offer 4711',
  from: [{ name: 'Lena Brandt', email: 'lena@example.com' }],
  hasAttachment: false,
} as Email;

const day = (d: number) => new Date(2026, 9, d);

function stored(task: Partial<CalendarTask>, id: string): CalendarTask {
  return { ...task, id, uid: id, updated: '2026-10-26T08:00:00Z' } as CalendarTask;
}

const reminder = (id: string, title: string, due: Date | null, over: Partial<CalendarTask> = {}) =>
  stored({ ...buildReminderTask({ title, calendarId: 'tasks', due, reminderAt: null }), ...over }, id);

const mailFollowUp = (id: string, due: Date | null) => stored(buildFollowUpTask({
  title: 'Call: Offer 4711',
  mailUrl: 'https://host/mail/message/M1?mailAccount=acc',
  subject: 'Offer 4711',
  from: { name: 'Lena Brandt', email: 'lena@example.com' },
  calendarId: 'tasks',
  due,
  reminderAt: null,
}), id);

function makeClient() {
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async (ids: string[]) => ids.filter((id) => id === 'M1').map((id) => ({ id, keywords: { $flagged: true } }))),
    queryEmailFields: vi.fn(async () => []),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: 'task-new', uid: 'u', updated: '' }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async (_id: string, _flagged: boolean, _accountId?: string) => {}),
  };
}

let client: ReturnType<typeof makeClient>;
const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const titles = (group: string) => within(screen.getByTestId(`upcoming-group-${group}`))
  .getAllByTestId('upcoming-open').map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true, showUpcomingPane: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [{ ...mail, keywords: { ...mail.keywords } }], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null, reminder: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UpcomingPane', () => {
  it('groups the open tasks of the own list: overdue, today, tomorrow, this week, the rest counted', () => {
    useTaskStore.setState({
      tasks: [
        reminder('r1', 'Check the dunning run', day(26)),
        mailFollowUp('f1', day(28)),
        reminder('r2', 'Order toner', day(29)),
        reminder('r3', 'Book the hall', day(30)),
        reminder('r4', 'Next month', new Date(2026, 10, 20)),
        reminder('r5', 'Some day', null),
        reminder('r6', 'Done already', day(28), { progress: 'completed' }),
      ],
    });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    expect(titles('overdue')[0]).toContain('Check the dunning run');
    expect(titles('today')[0]).toContain('Call');
    expect(titles('today')[0]).toContain('Lena Brandt · Offer 4711');
    expect(titles('tomorrow')[0]).toContain('Order toner');
    expect(titles('this-week')[0]).toContain('Book the hall');
    expect(screen.getByText('upcoming.more{"count":2}')).toBeTruthy();
    expect(screen.queryByText(/Done already/)).toBeNull();
  });

  it('shows an HTML note as text', () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(28), { description: '<p>HP <b>410A</b></p>', descriptionContentType: 'text/html' })] });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    expect(titles('today')[0]).toContain('HP 410A');
    expect(titles('today')[0]).not.toContain('<');
  });

  it('counts a repeating task only with the later ones', () => {
    useTaskStore.setState({
      tasks: [reminder('r1', 'Weekly report', day(20), {
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as unknown as CalendarTask['recurrenceRules'],
      })],
    });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    expect(screen.queryByTestId('upcoming-group-overdue')).toBeNull();
    expect(screen.queryByTestId('upcoming-done')).toBeNull();
    expect(screen.getByText('upcoming.more{"count":1}')).toBeTruthy();
  });

  it('says when nothing is due', () => {
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    expect(screen.getByTestId('upcoming-empty')).toBeTruthy();
    expect(screen.queryByText(/upcoming\.more/)).toBeNull();
  });

  it('adds a reminder due today on Enter, without a mail, and lists it under Today at once', async () => {
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    fireEvent.change(field('upcoming-quick'), { target: { value: '  Check the dunning run ' } });
    await act(async () => { fireEvent.submit(field('upcoming-quick').closest('form')!); });

    await waitFor(() => expect(client.createCalendarTask).toHaveBeenCalledTimes(1));
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written).toMatchObject({ title: 'Check the dunning run', due: '2026-10-28T00:00:00', calendarIds: { tasks: true }, alerts: null });
    expect(written.links).toBeUndefined();
    expect(field('upcoming-quick').value).toBe('');
    expect(titles('today')[0]).toContain('Check the dunning run');
    expect(titles('today')[0]).toContain('Reminder without a mail');
  });

  it('opens the dialog with what was typed from "…"', () => {
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    fireEvent.change(field('upcoming-quick'), { target: { value: 'Order toner' } });
    fireEvent.click(screen.getByTestId('upcoming-quick-more'));
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: null, title: 'Order toner' });
    expect(useFollowUpDialog.getState().focus).toBe('reminder');
    expect(field('upcoming-quick').value).toBe('');
  });

  it('marks a reminder done without touching any mail', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Check the dunning run', day(28))] });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });

    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledWith('r1', { progress: 'completed' }));
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(client.getEmailFields).not.toHaveBeenCalled();
    expect(screen.getByTestId('upcoming-empty')).toBeTruthy();
  });

  it('marks a mail\'s follow-up done as the mail does: the flag goes too', async () => {
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });

    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledWith('f1', { progress: 'completed' }));
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledTimes(1));
    expect(client.toggleStar.mock.calls[0].slice(0, 2)).toEqual(['M1', false]);
    expect(useEmailStore.getState().emails[0].keywords.$flagged).toBe(false);
  });

  it('clears the flag of a mail not in the list by the server\'s state', async () => {
    useEmailStore.setState({ emails: [] });
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledTimes(1));
    expect(client.toggleStar.mock.calls[0].slice(0, 2)).toEqual(['M1', false]);
  });

  it('opens a follow-up\'s mail, and any other task in the dialog', async () => {
    const onOpenMail = vi.fn();
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28)), reminder('r1', 'Order toner', day(29))] });
    render(<UpcomingPane onOpenMail={onOpenMail} />);

    await act(async () => { fireEvent.click(within(screen.getByTestId('upcoming-group-today')).getByTestId('upcoming-open')); });
    await waitFor(() => expect(onOpenMail).toHaveBeenCalledWith('M1', 'acc'));
    expect(useFollowUpDialog.getState().reminder).toBeNull();

    fireEvent.click(within(screen.getByTestId('upcoming-group-tomorrow')).getByTestId('upcoming-open'));
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: 'r1' });
  });

  it('hides itself, kept in the settings', () => {
    render(<UpcomingPane onOpenMail={vi.fn()} />);
    fireEvent.click(screen.getByTestId('upcoming-hide'));
    expect(useSettingsStore.getState().showUpcomingPane).toBe(false);
  });
});

describe('the dialog for a reminder without a mail', () => {
  it('writes a new one with what, day, time and note, and no mail', async () => {
    useFollowUpDialog.getState().openReminder({ taskId: null, title: 'Order toner' }, 'reminder');
    render(<FollowUpDialogHost />);

    expect(screen.getByText('reminder.dialog_title')).toBeTruthy();
    expect(screen.queryByTestId('follow-up-action')).toBeNull();
    expect(field('reminder-what').value).toBe('Order toner');
    // Due today; the reminder proposed for the next full hour.
    expect(field('follow-up-due').value).toBe('2026-10-28');
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(field('follow-up-reminder-day').value).toBe('2026-10-28');
    expect(field('follow-up-reminder-time').value).toBe('11:00');
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('reminder.kept_in{"list":"My tasks"}');

    fireEvent.change(field('reminder-what'), { target: { value: 'Order toner for the 2nd floor' } });
    fireEvent.click(screen.getByTestId('follow-up-dialog-tomorrow'));
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '09:15' } });
    fireEvent.change(screen.getByTestId('follow-up-note'), { target: { value: 'HP 410A' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });

    await waitFor(() => expect(client.createCalendarTask).toHaveBeenCalledTimes(1));
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written).toMatchObject({
      title: 'Order toner for the 2nd floor',
      description: 'HP 410A',
      due: '2026-10-29T00:00:00',
      calendarIds: { tasks: true },
    });
    expect(written.links).toBeUndefined();
    const trigger = written.alerts!['follow-up'].trigger;
    expect(trigger['@type'] === 'AbsoluteTrigger' && new Date(trigger.when)).toEqual(new Date(2026, 9, 29, 9, 15));
    expect(client.toggleStar).not.toHaveBeenCalled();
    await waitFor(() => expect(useFollowUpDialog.getState().reminder).toBeNull());
  });

  it('wants something to do', () => {
    useFollowUpDialog.getState().openReminder({ taskId: null, title: '' });
    render(<FollowUpDialogHost />);
    expect((screen.getByTestId('follow-up-dialog-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changes an existing one and keeps a due time set in the task list', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(29), { due: '2026-10-29T14:00:00', showWithoutTime: false })] });
    useFollowUpDialog.getState().openReminder({ taskId: 'r1' });
    render(<FollowUpDialogHost />);

    expect(screen.getByText('reminder.dialog_title_edit')).toBeTruthy();
    expect(field('reminder-what').value).toBe('Order toner');
    expect(field('follow-up-due').value).toBe('2026-10-29');
    fireEvent.change(screen.getByTestId('follow-up-note'), { target: { value: 'HP 410A' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });

    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0]).toEqual(['r1', { description: 'HP 410A' }]);
  });

  it('deletes one only once confirmed', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(29))] });
    useFollowUpDialog.getState().openReminder({ taskId: 'r1' });
    render(<FollowUpDialogHost />);
    expect(screen.getByTestId('follow-up-dialog-remove').textContent).toBe('reminder.delete');

    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-remove')); });
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText('reminder.delete_confirm{"title":"Order toner"}')).toBeTruthy();
    await act(async () => { fireEvent.click(within(ask).getByText('cancel')); });
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    expect(screen.getByTestId('follow-up-dialog')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-remove')); });
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByText('reminder.delete')); });
    await waitFor(() => expect(client.deleteCalendarTask).toHaveBeenCalledWith('r1'));
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('leaves a repeating task\'s due day to the task list', async () => {
    useTaskStore.setState({
      tasks: [reminder('r1', 'Weekly report', day(20), {
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as unknown as CalendarTask['recurrenceRules'],
      })],
    });
    useFollowUpDialog.getState().openReminder({ taskId: 'r1' });
    render(<FollowUpDialogHost />);
    expect(field('follow-up-due').disabled).toBe(true);
    expect((screen.getByTestId('follow-up-dialog-tomorrow') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('follow-up-recurring').textContent).toBe('recurring');

    fireEvent.change(screen.getByTestId('follow-up-note'), { target: { value: 'Send to Ben' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0]).toEqual(['r1', { description: 'Send to Ben' }]);
  });

  it('shows an HTML note as text, read only, and keeps it', async () => {
    useTaskStore.setState({
      tasks: [reminder('r1', 'Order toner', day(29), { description: '<p>HP <b>410A</b></p>', descriptionContentType: 'text/html' })],
    });
    useFollowUpDialog.getState().openReminder({ taskId: 'r1' });
    render(<FollowUpDialogHost />);
    const note = screen.getByTestId('follow-up-note') as HTMLTextAreaElement;
    expect(note.value).toBe('HP 410A');
    expect(note.readOnly).toBe(true);
    expect(screen.getByTestId('follow-up-note-html').textContent).toBe('note_html');

    fireEvent.change(field('reminder-what'), { target: { value: 'Order toner now' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0]).toEqual(['r1', { title: 'Order toner now' }]);
  });
});

describe('useDueTaskCount', () => {
  it('counts the own open tasks due today or earlier, and follows the task list', () => {
    useTaskStore.setState({
      tasks: [
        reminder('r1', 'a', day(26)),
        mailFollowUp('f1', day(28)),
        reminder('r2', 'b', day(29)),
        reminder('r3', 'c', day(27), { progress: 'completed' }),
        reminder('r4', 'd', day(27), { calendarIds: { elsewhere: true } }),
      ],
    });
    const { result } = renderHook(() => useDueTaskCount());
    expect(result.current).toBe(2);
    act(() => { useTaskStore.setState({ tasks: [reminder('r1', 'a', day(26))] }); });
    expect(result.current).toBe(1);
  });

  it('is 0 while tasks are off', () => {
    useSettingsStore.setState({ enableCalendarTasks: false });
    useTaskStore.setState({ tasks: [reminder('r1', 'a', day(26))] });
    const { result } = renderHook(() => useDueTaskCount());
    expect(result.current).toBe(0);
  });
});
