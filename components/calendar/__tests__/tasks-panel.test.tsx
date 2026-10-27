import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksPanel, TasksSidebar, useTasksPanelOpen } from '../tasks-panel';
import { FollowUpDialogHost } from '@/components/email/follow-up-dialog';
import { FollowUpPopoverHost } from '@/components/email/follow-up-popover';
import { useFollowUpPopover } from '@/stores/follow-up-popover-store';
import { useToastStore } from '@/stores/toast-store';
import { useFollowUpDialog } from '@/stores/follow-up-dialog-store';
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
// Links as anchors, so the ways out of the mail view can be told.
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

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
    getEmail: vi.fn(async (id: string, _accountId?: string) => (id === 'M1' ? { ...mail } : null)),
    queryEmailFields: vi.fn(async () => []),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: 'task-new', uid: 'u', updated: '' }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async (_id: string, _flagged: boolean, _accountId?: string) => {}),
    // The login reaches its own account and the group mailbox `grp`.
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;
const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const note = () => field('follow-up-note');
const titles = (group: string) => within(screen.getByTestId(`upcoming-group-${group}`))
  .getAllByTestId('upcoming-open').map((b) => b.textContent);
const head = (group: string) => within(screen.getByTestId(`upcoming-group-${group}`)).getByTestId('upcoming-group-head');
const items = (group: string) => within(screen.getByTestId(`upcoming-group-${group}`)).queryAllByTestId('upcoming-item');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client = makeClient();
  useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true, enableFollowUps: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [{ ...mail, keywords: { ...mail.keywords } }], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null, reminder: null });
  useFollowUpPopover.setState({ email: null, groupTaskId: null, taskId: null, trigger: null });
  useToastStore.setState({ toasts: [] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TasksPanel', () => {
  it('groups the open tasks of the own list in all seven groups, the far three folded with their count', () => {
    useTaskStore.setState({
      tasks: [
        reminder('r1', 'Check the dunning run', day(26)),
        mailFollowUp('f1', day(28)),
        reminder('r2', 'Order toner', day(29)),
        reminder('r3', 'Book the hall', day(30)),
        reminder('r7', 'Renew the certificate', new Date(2026, 10, 4)),
        reminder('r4', 'Next month', new Date(2026, 10, 20)),
        reminder('r5', 'Some day', null),
        reminder('r8', 'Another day', null),
        reminder('r6', 'Done already', day(28), { progress: 'completed' }),
      ],
    });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(screen.getAllByTestId('upcoming-group-head').map((h) => h.textContent)).toEqual([
      'upcoming.groups.overdue1',
      'upcoming.groups.today1',
      'upcoming.groups.tomorrow1',
      'upcoming.groups.this_week1',
      'upcoming.groups.next_week1',
      'upcoming.groups.later1',
      'upcoming.groups.no_date2',
    ]);
    expect(titles('overdue')[0]).toContain('Check the dunning run');
    expect(titles('today')[0]).toContain('Call');
    expect(titles('today')[0]).toContain('Lena Brandt · Offer 4711');
    expect(titles('tomorrow')[0]).toContain('Order toner');
    expect(titles('this-week')[0]).toContain('Book the hall');
    for (const group of ['next-week', 'later', 'no-date']) {
      expect(head(group).getAttribute('aria-expanded')).toBe('false');
      expect(items(group)).toHaveLength(0);
    }
    expect(head('today').getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText(/Done already/)).toBeNull();
  });

  it('folds and opens a group in place, and keeps it so in this browser', () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(28)), reminder('r2', 'Some day', null)] });
    const first = render(<TasksPanel onOpenMail={vi.fn()} />);
    fireEvent.click(head('no-date'));
    expect(titles('no-date')[0]).toContain('Some day');
    fireEvent.click(head('today'));
    expect(items('today')).toHaveLength(0);
    first.unmount();

    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(items('today')).toHaveLength(0);
    expect(titles('no-date')[0]).toContain('Some day');
    fireEvent.click(head('today'));
    expect(titles('today')[0]).toContain('Order toner');
  });

  it('lists the 20 newest without a date, and names the task list for all of them', () => {
    useTaskStore.setState({
      tasks: Array.from({ length: 25 }, (_, i) => reminder(`n${i}`, `Some day ${i}`, null, {
        created: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      })),
    });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(head('no-date').textContent).toBe('upcoming.groups.no_date25');
    fireEvent.click(head('no-date'));
    expect(items('no-date')).toHaveLength(20);
    expect(titles('no-date')[0]).toContain('Some day 24');
    const all = screen.getByTestId('upcoming-no-date-all');
    expect(all.textContent).toBe('upcoming.no_date_all{"count":25}');
    expect(all.getAttribute('href')).toContain('/calendar/tasks');
  });

  it('leads out of the mail only from its foot, which names the task list', () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(28)), mailFollowUp('f1', day(29)), reminder('r2', 'Some day', null)] });
    const { container } = render(<TasksPanel onOpenMail={vi.fn()} />);
    fireEvent.click(head('no-date'));
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-testid')).toBe('upcoming-open-list');
    expect(links[0].textContent).toBe('upcoming.open_list');
    expect(links[0].getAttribute('href')).toContain('/calendar/tasks');
  });

  it('shows an HTML note as text', () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(28), { description: '<p>HP <b>410A</b></p>', descriptionContentType: 'text/html' })] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(titles('today')[0]).toContain('HP 410A');
    expect(titles('today')[0]).not.toContain('<');
  });

  it('lists a repeating task under later, without a date or a check box', () => {
    useTaskStore.setState({
      tasks: [reminder('r1', 'Weekly report', day(20), {
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as unknown as CalendarTask['recurrenceRules'],
      })],
    });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(screen.queryByTestId('upcoming-group-overdue')).toBeNull();
    fireEvent.click(head('later'));
    expect(titles('later')[0]).toBe('Weekly reportReminder without a mail');
    expect(screen.queryByTestId('upcoming-done')).toBeNull();
  });

  it('says when nothing is due', () => {
    render(<TasksPanel onOpenMail={vi.fn()} />);
    expect(screen.getByTestId('upcoming-empty')).toBeTruthy();
  });

  it('adds a reminder due today on Enter, without a mail, and lists it under Today at once', async () => {
    render(<TasksPanel onOpenMail={vi.fn()} />);
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
    render(<TasksPanel onOpenMail={vi.fn()} />);
    fireEvent.change(field('upcoming-quick'), { target: { value: 'Order toner' } });
    fireEvent.click(screen.getByTestId('upcoming-quick-more'));
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: null, title: 'Order toner' });
    expect(useFollowUpDialog.getState().focus).toBe('reminder');
    expect(field('upcoming-quick').value).toBe('');
  });

  it('marks a reminder done without touching any mail', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Check the dunning run', day(28))] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });

    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledWith('r1', { progress: 'completed' }));
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(client.getEmailFields).not.toHaveBeenCalled();
    expect(screen.getByTestId('upcoming-empty')).toBeTruthy();
  });

  it('takes a completion back from its toast', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Check the dunning run', day(28))] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const [shown] = useToastStore.getState().toasts;
    expect(shown.title).toBe('upcoming.done_toast{"title":"Check the dunning run"}');
    expect(shown.action?.label).toBe('undo');

    await act(async () => { shown.action?.onClick(); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenLastCalledWith('r1', { progress: 'needs-action' }));
    expect(titles('today')[0]).toContain('Check the dunning run');
  });

  it('flags the mail again when a follow-up\'s completion is taken back', async () => {
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    await act(async () => { useToastStore.getState().toasts[0].action?.onClick(); });
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledTimes(2));
    expect(client.toggleStar.mock.calls[1].slice(0, 2)).toEqual(['M1', true]);
    expect(client.updateCalendarTask).toHaveBeenLastCalledWith('f1', { progress: 'needs-action' });
  });

  it('marks a mail\'s follow-up done as the mail does: the flag goes too', async () => {
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });

    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledWith('f1', { progress: 'completed' }));
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledTimes(1));
    expect(client.toggleStar.mock.calls[0].slice(0, 2)).toEqual(['M1', false]);
    expect(useEmailStore.getState().emails[0].keywords.$flagged).toBe(false);
  });

  it('clears the flag of a mail not in the list by the server\'s state', async () => {
    useEmailStore.setState({ emails: [] });
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<TasksPanel onOpenMail={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledTimes(1));
    expect(client.toggleStar.mock.calls[0].slice(0, 2)).toEqual(['M1', false]);
  });

  it('opens a follow-up\'s mail, and any other task in the dialog', async () => {
    const onOpenMail = vi.fn();
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28)), reminder('r1', 'Order toner', day(29))] });
    render(<TasksPanel onOpenMail={onOpenMail} />);

    await act(async () => { fireEvent.click(within(screen.getByTestId('upcoming-group-today')).getByTestId('upcoming-open')); });
    await waitFor(() => expect(onOpenMail).toHaveBeenCalledWith('M1', 'acc'));
    expect(useFollowUpDialog.getState().reminder).toBeNull();

    fireEvent.click(within(screen.getByTestId('upcoming-group-tomorrow')).getByTestId('upcoming-open'));
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: 'r1' });
  });

  it('opens a group mailbox\'s mail in its account, and completes its follow-up without a flag', async () => {
    const onOpenMail = vi.fn();
    const groupFollowUp = { ...mailFollowUp('g1', day(28)) };
    groupFollowUp.links = { ...groupFollowUp.links, mail: { ...groupFollowUp.links!.mail, href: 'https://host/mail/message/M1?mailAccount=grp' } };
    useTaskStore.setState({ tasks: [groupFollowUp] });
    render(<TasksPanel onOpenMail={onOpenMail} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-open')); });
    // Looked for in the group's account, then opened there.
    await waitFor(() => expect(onOpenMail).toHaveBeenCalledWith('M1', 'grp'));
    expect(client.getEmailFields).toHaveBeenCalledWith(['M1'], ['id'], 'grp');

    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-done')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('opens no mail of an account the login does not reach, never the own one of the same id', async () => {
    const onOpenMail = vi.fn();
    const elsewhere = { ...mailFollowUp('e1', day(28)) };
    elsewhere.links = { ...elsewhere.links, mail: { ...elsewhere.links!.mail, href: 'https://host/mail/message/M1?mailAccount=elsewhere' } };
    useTaskStore.setState({ tasks: [elsewhere] });
    render(<TasksPanel onOpenMail={onOpenMail} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-open')); });
    await waitFor(() => expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: 'e1' }));
    expect(onOpenMail).not.toHaveBeenCalled();
    expect(client.getEmailFields).not.toHaveBeenCalled();
  });

  it('opens the popover on the mail from a follow-up\'s flag, without opening the mail', async () => {
    const onOpenMail = vi.fn();
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28))] });
    render(<TasksPanel onOpenMail={onOpenMail} />);
    await act(async () => { fireEvent.click(screen.getByTestId('upcoming-flag')); });
    await waitFor(() => expect(useFollowUpPopover.getState().email?.id).toBe('M1'));
    const state = useFollowUpPopover.getState();
    expect(state.email?.sourceAccountId).toBe('acc');
    expect(state.groupTaskId).toBeNull();
    expect(state.taskId).toBeNull();
    expect(client.getEmail).toHaveBeenCalledWith('M1', 'acc');
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  it('opens the popover on a reminder by its right click: moved, changed, done or deleted there', async () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Cancel the maintenance contract', day(28))] });
    render(<><TasksPanel onOpenMail={vi.fn()} /><FollowUpPopoverHost /></>);
    await act(async () => { fireEvent.contextMenu(screen.getByTestId('upcoming-item'), { clientX: 40, clientY: 60 }); });
    await waitFor(() => expect(screen.getByTestId('follow-up-popover')).toBeTruthy());
    expect(useFollowUpPopover.getState().taskId).toBe('r1');
    expect(useFollowUpPopover.getState().position).toEqual({ x: 40, y: 60 });
    expect(client.getEmail).not.toHaveBeenCalled();
    const popover = screen.getByTestId('follow-up-popover');
    expect(within(popover).getByText('Cancel the maintenance contract')).toBeTruthy();
    expect(within(popover).getAllByRole('menuitem').map((e) => e.getAttribute('data-testid'))).toEqual([
      'follow-up-today',
      'follow-up-tomorrow',
      'follow-up-this-week',
      'follow-up-next-week',
      'follow-up-no-date',
      'follow-up-custom',
      'follow-up-done',
      'follow-up-remove',
    ]);
    expect(within(popover).getByTestId('follow-up-custom').textContent).toBe('change_button');
    expect(within(popover).getByTestId('follow-up-remove').textContent).toBe('reminder.delete');

    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-tomorrow')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][0]).toBe('r1');
    expect(client.updateCalendarTask.mock.calls[0][1].due).toBe('2026-10-29T00:00:00');
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(screen.queryByTestId('follow-up-popover')).toBeNull();

    await act(async () => { fireEvent.contextMenu(screen.getByTestId('upcoming-item'), { clientX: 40, clientY: 60 }); });
    await waitFor(() => expect(screen.getByTestId('follow-up-popover')).toBeTruthy());
    fireEvent.click(screen.getByTestId('follow-up-custom'));
    expect(useFollowUpDialog.getState().reminder).toEqual({ taskId: 'r1' });

    await act(async () => { fireEvent.contextMenu(screen.getByTestId('upcoming-item'), { clientX: 40, clientY: 60 }); });
    await waitFor(() => expect(screen.getByTestId('follow-up-popover')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-remove')); });
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText('reminder.delete_confirm{"title":"Cancel the maintenance contract"}')).toBeTruthy();
    await act(async () => { fireEvent.click(within(ask).getByText('reminder.delete')); });
    await waitFor(() => expect(client.deleteCalendarTask).toHaveBeenCalledWith('r1'));
  });
});

describe('TasksSidebar', () => {
  it('frames the panel in the default layout, and closes from its ✕', () => {
    const onClose = vi.fn();
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(28))] });
    render(<TasksSidebar onClose={onClose} onOpenMail={vi.fn()} />);
    expect(screen.getByRole('complementary', { name: 'upcoming.title' })).toBeTruthy();
    expect(titles('today')[0]).toContain('Order toner');
    expect(screen.queryByRole('link', { name: 'upcoming.all_tasks' })).toBeNull();
    fireEvent.click(screen.getByTestId('upcoming-hide'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('useTasksPanelOpen', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts open, and keeps a choice in this browser, not in the settings', () => {
    const settings = useSettingsStore.getState();
    const first = renderHook(() => useTasksPanelOpen());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    expect(localStorage.getItem('tasksPanelOpen')).toBe('0');
    expect(useSettingsStore.getState()).toEqual(settings);

    const again = renderHook(() => useTasksPanelOpen());
    expect(again.result.current[0]).toBe(false);
    act(() => again.result.current[1](true));
    expect(renderHook(() => useTasksPanelOpen()).result.current[0]).toBe(true);
  });

  it('opens, and still toggles, when the browser keeps no storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useTasksPanelOpen());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
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
    // No mail line, no "For" without a group mailbox's list.
    expect(screen.queryByTestId('follow-up-mail')).toBeNull();
    expect(screen.queryByTestId('follow-up-for')).toBeNull();

    fireEvent.change(field('reminder-what'), { target: { value: 'Order toner for the 2nd floor' } });
    fireEvent.change(field('follow-up-due'), { target: { value: '2026-10-29' } });
    fireEvent.change(field('follow-up-reminder-day'), { target: { value: '2026-10-29' } });
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '09:15' } });
    fireEvent.change(note(), { target: { value: 'HP 410A' } });
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
    fireEvent.change(note(), { target: { value: 'HP 410A' } });
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
    expect(screen.getByTestId('follow-up-recurring').textContent).toBe('recurring');

    fireEvent.change(note(), { target: { value: 'Send to Ben' } });
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

  it('is 0 while follow-ups are switched off', () => {
    useSettingsStore.setState({ enableFollowUps: false });
    useTaskStore.setState({ tasks: [reminder('r1', 'a', day(26))] });
    const { result } = renderHook(() => useDueTaskCount());
    expect(result.current).toBe(0);
  });
});
