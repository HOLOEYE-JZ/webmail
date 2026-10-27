import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemindersWindowHost } from '../reminders-window';
import { useFollowUpDialog } from '@/stores/follow-up-dialog-store';
import { ownsReminderMails, reminderMailOpener, setReminderMailOpener, useReminderMailOpener, useRemindersWindow, useTaskReminders } from '@/hooks/use-task-reminders';
import { useProTabStore } from '@/stores/pro-tab-store';
import { useCalendarAlerts } from '@/hooks/use-calendar-alerts';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useToastStore } from '@/stores/toast-store';
import { buildFollowUpTask, buildReminderTask } from '@/lib/follow-ups';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Email } from '@/lib/jmap/types';

const TEXTS: Record<string, string> = {
  bar_action: 'Follow up',
  no_subject: '(no subject)',
  done_button: 'Complete',
  open_mail: 'Open mail',
  due_today: 'due today',
  'actions.follow_up': 'Follow up',
  'actions.call': 'Call',
  'upcoming.no_mail': 'Reminder without a mail',
  'reminders.open': 'Open',
  'reminders.dismiss': 'Dismiss',
  'reminders.dismiss_all': 'Dismiss all',
  'reminders.snooze': 'Snooze',
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
const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }));
let proShell = false;
vi.mock('@/components/pro/pro-interface-redirect', () => ({ useProInterfaceActive: () => proShell }));

// Wednesday 28.10.2026, 10:30 on the wall clock.
const NOW = new Date(2026, 9, 28, 10, 30);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const calendars = [{ id: 'tasks', name: 'My tasks', isTasksOnly: true }] as Calendar[];

const mail = {
  id: 'M1', threadId: 'T1', mailboxIds: { inbox: true }, keywords: { $seen: true, $flagged: true }, size: 1,
  receivedAt: '2026-10-26T07:00:00Z', subject: 'Offer 4711', from: [{ name: 'Lena Brandt', email: 'lena@example.com' }], hasAttachment: false,
} as Email;

function stored(task: Partial<CalendarTask>, id: string): CalendarTask {
  return { ...task, id, uid: id, updated: '2026-10-26T08:00:00Z' } as CalendarTask;
}

const reminder = (id: string, title: string, reminderAt: Date | null, over: Partial<CalendarTask> = {}) =>
  stored({ ...buildReminderTask({ title, calendarId: 'tasks', due: new Date(2026, 9, 28), reminderAt }), ...over }, id);

const followUp = (id: string, due: Date, reminderAt: Date) => stored(buildFollowUpTask({
  title: 'Call: Offer 4711',
  mailUrl: 'https://host/mail/message/M1?mailAccount=acc',
  subject: 'Offer 4711',
  from: { name: 'Lena Brandt', email: 'lena@example.com' },
  calendarId: 'tasks',
  due,
  reminderAt,
}), id);

function makeClient() {
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async (ids: string[]) => ids.filter((id) => id === 'M1').map((id) => ({ id, keywords: { $flagged: true } }))),
    queryEmailFields: vi.fn(async () => []),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    toggleStar: vi.fn(async (_id: string, _flagged: boolean) => {}),
    // The login reaches its own account and the group mailbox `grp`.
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;
const rows = () => screen.getAllByTestId('reminder-row');
const patchOf = (taskId: string) => client.updateCalendarTask.mock.calls.find(([id]) => id === taskId)?.[1];

function renderWindow() {
  renderHook(() => useTaskReminders());
  return render(<RemindersWindowHost />);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client = makeClient();
  push.mockClear();
  proShell = false;
  setReminderMailOpener(null);
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({
    enableCalendarTasks: true, enableFollowUps: true, calendarNotificationsEnabled: true, calendarNotificationSound: false,
    timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1,
  });
  useCalendarStore.setState({ supportsCalendar: true, calendars, events: [] });
  useTaskStore.setState({ tasks: [], isLoading: false, fetchedCalendarIds: ['tasks'], loadedBy: null, error: null });
  useEmailStore.setState({ emails: [{ ...mail, keywords: { ...mail.keywords } }], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null, reminder: null });
  useRemindersWindow.setState({ open: false });
  useToastStore.setState({ toasts: [] });
  useCalendarNotificationStore.getState().clearAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the reminders window', () => {
  it('opens with a toast for a reminder that fell due while the app was closed, days ago', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Check the dunning run', ago(3 * 24 * 60))] });
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('reminders-window')).toBeTruthy());
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Check the dunning run')]);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Check the dunning run' })]);
  });

  it('opens again at the next start while the reminder stands, without ringing again that day', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Check the dunning run', ago(3 * 24 * 60))] });
    const first = renderWindow();
    await waitFor(() => expect(screen.getByTestId('reminders-window')).toBeTruthy());
    first.unmount();
    useRemindersWindow.setState({ open: false });
    useToastStore.setState({ toasts: [] });

    // The next start: the app drops what it toasted more than a day ago.
    useCalendarNotificationStore.getState().cleanupStaleAlerts();
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('reminders-window')).toBeTruthy());
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('shows what, the mail\'s sender and subject, and when it is due, overdue in red', async () => {
    useTaskStore.setState({
      tasks: [
        followUp('f1', new Date(2026, 9, 26), ago(60)),
        reminder('r1', 'Order toner', ago(5)),
      ],
    });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [mailRow, plainRow] = rows();
    expect(mailRow.textContent).toContain('Call');
    expect(mailRow.textContent).toContain('Lena Brandt · Offer 4711');
    const overdue = within(mailRow).getByTestId('reminder-due');
    expect(overdue.textContent).toBe('overdue_days{"count":2}');
    expect(overdue.className).toContain('text-destructive');
    expect(plainRow.textContent).toContain('Reminder without a mail');
    expect(within(plainRow).getByTestId('reminder-due').textContent).toBe('due today');
    expect(within(plainRow).getByTestId('reminder-due').className).not.toContain('text-destructive');
    expect(screen.getByText('reminders.title{"count":2}')).toBeTruthy();
    // The selected row names the button.
    expect(screen.getByTestId('reminders-open').textContent).toBe('Open mail');
    fireEvent.click(plainRow);
    expect(screen.getByTestId('reminders-open').textContent).toBe('Open');
  });

  it('Dismiss acknowledges that reminder on the task, so no other device shows it again', async () => {
    const task = reminder('r1', 'Order toner', ago(5));
    useTaskStore.setState({ tasks: [task, reminder('r2', 'Book the hall', ago(2))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-dismiss')); });
    expect(patchOf('r1')).toEqual({ 'alerts/follow-up/acknowledged': utc(NOW) });
    expect(task.alerts).toBeTruthy();
    expect(rows().map((r) => r.dataset.task)).toEqual(['r2']);
  });

  it('Dismiss all acknowledges every reminder and closes the window', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', ago(5)), reminder('r2', 'Book the hall', ago(2))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-dismiss-all')); });
    expect(client.updateCalendarTask.mock.calls.map(([id, patch]) => [id, (patch as Record<string, unknown>)['alerts/follow-up/acknowledged']])).toEqual([
      ['r1', utc(NOW)], ['r2', utc(NOW)],
    ]);
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });

  it('Complete completes a mail\'s follow-up as the mail\'s own Mark complete: its flag goes', async () => {
    useTaskStore.setState({ tasks: [followUp('f1', new Date(2026, 9, 28), ago(5))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-done')); });
    // Its fired reminder is dismissed with it, as Outlook's Mark Complete.
    expect(patchOf('f1')).toEqual({ progress: 'completed', 'alerts/follow-up/acknowledged': utc(NOW) });
    await waitFor(() => expect(client.toggleStar.mock.calls[0]?.slice(0, 2)).toEqual(['M1', false]));
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });

  it.each([
    ['5m', new Date(NOW.getTime() + 5 * 60_000)],
    ['1h', new Date(NOW.getTime() + 60 * 60_000)],
    // Thursday 29.10. at the start of work.
    ['tomorrow', new Date(2026, 9, 29, 8, 0)],
    // Monday 02.11.
    ['next-week', new Date(2026, 10, 2, 8, 0)],
  ])('Snooze %s moves the reminder to its time', async (choice, at) => {
    const task = reminder('r1', 'Order toner', ago(5));
    useTaskStore.setState({ tasks: [task] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByTestId('reminders-snooze-choice'), { target: { value: choice } });
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-snooze')); });
    expect(patchOf('r1')).toEqual({
      'alerts/follow-up/trigger': { '@type': 'AbsoluteTrigger', when: utc(at) },
      'alerts/follow-up/acknowledged': null,
    });
    expect(task.alerts).toBeTruthy();
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });

  it('offers the due day only while its morning is to come', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Today', ago(5)), reminder('r2', 'Friday', ago(4), { due: '2026-10-30T00:00:00' })] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const options = () => [...(screen.getByTestId('reminders-snooze-choice') as HTMLSelectElement).options].map((o) => o.value);
    expect(options()).not.toContain('due-day');
    fireEvent.click(rows()[1]);
    expect(options()).toContain('due-day');
    fireEvent.change(screen.getByTestId('reminders-snooze-choice'), { target: { value: 'due-day' } });
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-snooze')); });
    expect((patchOf('r2') as Record<string, unknown> | undefined)?.['alerts/follow-up/trigger']).toEqual({ '@type': 'AbsoluteTrigger', when: utc(new Date(2026, 9, 30, 8, 0)) });
  });

  it('a double click opens a mail through the mail view, else its permalink; a reminder without one in the dialog', async () => {
    useTaskStore.setState({ tasks: [followUp('f1', new Date(2026, 9, 28), ago(5)), reminder('r1', 'Order toner', ago(2))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.doubleClick(rows()[0]);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/mail/message/M1?owner=acc'));

    const opener = vi.fn();
    setReminderMailOpener(opener);
    fireEvent.click(screen.getByTestId('reminders-open'));
    await waitFor(() => expect(opener).toHaveBeenCalledWith('M1', 'acc'));

    fireEvent.doubleClick(rows()[1]);
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: 'r1' });
    // Opening leaves the reminder standing.
    expect(client.updateCalendarTask).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
  });

  it('in the Pro shell with no mail tab on screen, opens the mail as a mail tab', async () => {
    proShell = true;
    const openEmailTab = vi.spyOn(useProTabStore.getState(), 'openEmailTab').mockReturnValue('tab');
    useTaskStore.setState({ tasks: [followUp('f1', new Date(2026, 9, 28), ago(5))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('reminders-open'));
    await waitFor(() => expect(openEmailTab).toHaveBeenCalledWith(
      { accountId: 'acc', emailId: 'M1', mailboxId: null, title: 'Offer 4711' }, { reuseReader: true },
    ));
    expect(push).not.toHaveBeenCalled();
    openEmailTab.mockRestore();
  });

  it('in the Pro shell, opens a group mailbox\'s mail as a mail tab in its account', async () => {
    proShell = true;
    const openEmailTab = vi.spyOn(useProTabStore.getState(), 'openEmailTab').mockReturnValue('tab');
    const task = followUp('f1', new Date(2026, 9, 28), ago(5));
    task.links = { ...task.links, mail: { ...task.links!.mail, href: 'https://host/mail/message/M1?mailAccount=grp' } };
    useTaskStore.setState({ tasks: [task] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('reminders-open'));
    await waitFor(() => expect(openEmailTab).toHaveBeenCalledWith(
      { accountId: 'grp', clientAccountId: 'login', emailId: 'M1', mailboxId: null, title: 'Offer 4711' }, { reuseReader: true },
    ));
    openEmailTab.mockRestore();
  });

  it('completed and reopened (the dialog, a phone), a task does not remind again of what fired before', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', ago(5))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByTestId('reminders-done')); });
    expect(screen.queryByTestId('reminders-window')).toBeNull();
    const done = useTaskStore.getState().tasks[0];
    expect(done.alerts!['follow-up'].acknowledged).toBe(utc(NOW));
    act(() => { useTaskStore.setState({ tasks: [{ ...done, progress: 'needs-action' }] }); });
    act(() => { useRemindersWindow.getState().show(); });
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });

  it('closing the window leaves the reminders; a new one opens it again', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', ago(5))] });
    renderWindow();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('reminders-window-close'));
    expect(screen.queryByTestId('reminders-window')).toBeNull();
    expect(client.updateCalendarTask).not.toHaveBeenCalled();

    act(() => { useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks, reminder('r2', 'Book the hall', ago(1))] }); });
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('is not shown with calendar notifications off', async () => {
    useSettingsStore.setState({ calendarNotificationsEnabled: false });
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', ago(5))] });
    renderWindow();
    await act(async () => {});
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });

  it('is not shown with follow-ups switched off', async () => {
    useSettingsStore.setState({ enableFollowUps: false });
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', ago(5))] });
    renderWindow();
    await act(async () => {});
    expect(screen.queryByTestId('reminders-window')).toBeNull();
  });
});

describe('the toasts of task alerts', () => {
  it('leave the user\'s own tasks to the window and still toast a shared one', async () => {
    useTaskStore.setState({
      tasks: [
        reminder('own', 'Order toner', ago(1)),
        reminder('shared', 'Group task', ago(1), { isShared: true }),
      ],
    });
    renderHook(() => useCalendarAlerts());
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0].title).toBe('Group task');
  });

  it('toast the user\'s own tasks too while follow-ups are switched off', async () => {
    useSettingsStore.setState({ enableFollowUps: false });
    useTaskStore.setState({
      tasks: [
        reminder('own', 'Order toner', ago(1)),
        reminder('shared', 'Group task', ago(1), { isShared: true }),
      ],
    });
    renderHook(() => useCalendarAlerts());
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(2));
  });
});

describe('which mail view opens a reminder\'s mail', () => {
  it('the standard one outside Pro, in Pro only the tab on screen', () => {
    expect(ownsReminderMails({ embedded: false, focusedProTab: false, proInterface: false })).toBe(true);
    expect(ownsReminderMails({ embedded: false, focusedProTab: false, proInterface: true })).toBe(false);
    expect(ownsReminderMails({ embedded: true, focusedProTab: true, proInterface: true })).toBe(true);
    expect(ownsReminderMails({ embedded: true, focusedProTab: false, proInterface: true })).toBe(false);
  });

  it('a hidden tab gives the opener up, and only its own', () => {
    const shown = vi.fn();
    const view = renderHook(({ owns }) => useReminderMailOpener(owns, shown), { initialProps: { owns: true } });
    reminderMailOpener()?.('M1', null);
    expect(shown).toHaveBeenCalledWith('M1', null);
    view.rerender({ owns: false });
    expect(reminderMailOpener()).toBeNull();

    // Another view on screen keeps its opener when this one goes.
    const other = vi.fn();
    view.rerender({ owns: true });
    const second = renderHook(() => useReminderMailOpener(true, other));
    view.unmount();
    reminderMailOpener()?.('M2', 'acc');
    expect(other).toHaveBeenCalledWith('M2', 'acc');
    second.unmount();
    expect(reminderMailOpener()).toBeNull();
  });
});
