import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskListView } from '../task-list-view';
import { TaskToolbar } from '../task-toolbar';
import { useTaskList } from '@/hooks/use-task-list';
import { useFollowUpDialog } from '@/stores/follow-up-dialog-store';
import { useGroupTasks } from '@/hooks/use-group-follow-ups';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { clearAllHooks, taskHooks } from '@/lib/plugin-hooks';
import { buildFollowUpTask, buildReminderTask } from '@/lib/follow-ups';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask, Principal } from '@/lib/jmap/types';

const TEXTS: Record<string, string> = {
  'actions.call': 'Call',
  'actions.follow_up': 'Follow up',
  bar_action: 'Follow up',
  no_subject: '(no subject)',
  'group.chip_me': 'me',
  'group.nobody': 'nobody',
  'tasks.groups.overdue': 'Overdue',
  'tasks.groups.today': 'Today',
  'tasks.groups.tomorrow': 'Tomorrow',
  'tasks.groups.this_week': 'This week',
  'tasks.groups.later': 'Later',
  'tasks.groups.no_date': 'No date',
  'tasks.groups.done': 'Done',
};
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const text = TEXTS[key];
    if (text) return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
    return values ? `${key}${JSON.stringify(values)}` : key;
  },
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => `T${new Date(d).getHours()}:${String(new Date(d).getMinutes()).padStart(2, '0')}` }),
}));
const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/pro/pro-interface-redirect', () => ({ useProInterfaceActive: () => false }));

// Wednesday 28.10.2026, 10:30 on the wall clock.
const NOW = new Date(2026, 9, 28, 10, 30);
const day = (d: number) => new Date(2026, 9, d);

const ownCalendars = [
  { id: 'events', name: 'Calendar', isDefault: true },
  { id: 'tasks', name: 'My tasks', isTasksOnly: true },
] as Calendar[];
const groupCalendar = {
  id: 'grp:b', originalId: 'b', name: 'Tasks', accountId: 'grp', accountName: 'sales@example.com',
  isShared: true, isDefault: true, isTasksOnly: false,
} as Calendar;

const principals: Principal[] = [
  { id: 'me', type: 'individual', name: 'me@example.com', email: 'me@example.com', description: 'Jacob' },
  { id: 'anna', type: 'individual', name: 'anna@example.com', email: 'anna@example.com', description: 'Anna' },
  { id: 'grp', type: 'group', name: 'sales@example.com', email: 'sales@example.com' },
] as Principal[];

function stored(task: Partial<CalendarTask>, id: string, over: Partial<CalendarTask> = {}): CalendarTask {
  return { uid: id, updated: '2026-10-26T08:00:00Z', priority: 0, ...task, id, ...over } as CalendarTask;
}

const reminder = (id: string, title: string, due: Date | null, reminderAt: Date | null = null, over: Partial<CalendarTask> = {}) =>
  stored(buildReminderTask({ title, calendarId: 'tasks', due, reminderAt }), id, over);

const mailFollowUp = stored(buildFollowUpTask({
  title: 'Call: Offer 4711',
  mailUrl: 'https://host/mail/message/M1',
  subject: 'Offer 4711',
  from: { name: 'Lena Brandt', email: 'lena@example.com' },
  calendarId: 'tasks',
  due: day(28),
  reminderAt: new Date(2026, 9, 28, 14, 0),
}), 'f1');

const owner = (email: string, name: string) => ({
  for: { '@type': 'Participant', name, calendarAddress: `mailto:${email}`, roles: { owner: true } } as never,
});
const groupTask = (id: string, title: string, due: Date | null, email: string, name: string) =>
  reminder(id, title, due, null, {
    calendarIds: { 'grp:b': true }, isShared: true, accountId: 'grp', originalId: id.replace('grp:', ''), participants: owner(email, name),
  });

function makeClient() {
  return {
    getAccountId: () => 'acc',
    getEmailFields: vi.fn(async (ids: string[]) => ids.filter((id) => id === 'M1').map((id) => ({ id, keywords: { $flagged: true } }))),
    queryEmailFields: vi.fn(async () => []),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    getPrincipals: vi.fn(async () => principals),
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;
const onSelectTask = vi.fn();

/** The calendar's task view as calendar-app wires it. */
function Harness() {
  const list = useTaskList(['tasks']);
  const filter = useTaskStore((s) => s.filter);
  const showCompleted = useTaskStore((s) => s.showCompleted);
  return (
    <>
      <TaskToolbar
        filter={filter}
        showCompleted={showCompleted}
        onFilterChange={useTaskStore.getState().setFilter}
        onShowCompletedChange={useTaskStore.getState().setShowCompleted}
        onCreateTask={vi.fn()}
        scope={list.scope}
        onScopeChange={useTaskStore.getState().setListScope}
        groupLists={list.groupLists.map((l) => ({ accountId: l.accountId, name: l.name }))}
      />
      <TaskListView sections={list.sections} calendars={[...ownCalendars, groupCalendar]} onSelectTask={onSelectTask} />
    </>
  );
}

const groupsShown = () => screen.queryAllByRole('region').map((r) => r.getAttribute('data-testid'));
const item = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  push.mockClear();
  onSelectTask.mockClear();
  client = makeClient();
  useAuthStore.setState({
    isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login',
    username: 'me@example.com', identities: [{ id: 'i', name: 'Jacob', email: 'me@example.com', mayDelete: false }],
  });
  useSettingsStore.setState({ enableCalendarTasks: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1, timeFormat: '24h' });
  useCalendarStore.setState({ supportsCalendar: true, calendars: [...ownCalendars, groupCalendar], participantIdentities: [] });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useEmailStore.setState({ emails: [], selectedEmail: null, mailboxes: [], selectedMailbox: 'inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null, reminder: null });
  useTaskStore.setState({ tasks: [], filter: 'all', showCompleted: false, listScope: 'mine' });
  useGroupTasks.setState({ lists: [], tasks: [], loadedBy: null });
});

afterEach(() => {
  vi.useRealTimers();
  clearAllHooks();
});

function setGroup(tasks: CalendarTask[]) {
  useGroupTasks.setState({
    lists: [{ accountId: 'grp', name: 'sales@example.com', list: groupCalendar }],
    tasks,
    loadedBy: client as unknown as IJMAPClient,
  });
}

describe('the task list in the calendar', () => {
  it('groups the user\'s tasks by due day, the done ones last', () => {
    useTaskStore.setState({
      showCompleted: true,
      tasks: [
        reminder('r1', 'Check the dunning run', day(26)),
        mailFollowUp,
        reminder('r2', 'Order toner', day(29)),
        reminder('r3', 'Book the hall', day(30)),
        reminder('r4', 'Next month', new Date(2026, 10, 20)),
        reminder('r5', 'Some day', null),
        reminder('r6', 'Old one', day(20), null, { progress: 'completed' }),
      ],
    });
    render(<Harness />);
    expect(groupsShown()).toEqual([
      'task-group-overdue', 'task-group-today', 'task-group-tomorrow', 'task-group-this-week',
      'task-group-later', 'task-group-no-date', 'task-group-done',
    ]);
    expect(within(screen.getByTestId('task-group-overdue')).getByTestId('task-due')).toHaveTextContent('overdue_days');
  });

  it("shows a mail's follow-up with its sender and subject and the reminder's time, and opens the mail", async () => {
    useTaskStore.setState({ tasks: [mailFollowUp] });
    render(<Harness />);
    const row = item('f1');
    expect(within(row).getByTestId('task-title')).toHaveTextContent('Call');
    expect(within(row).getByTestId('task-sub')).toHaveTextContent('Lena Brandt · Offer 4711');
    expect(within(row).getByTestId('task-reminder')).toHaveTextContent('T14:00');

    fireEvent.click(row);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/mail/message/M1'));
    expect(onSelectTask).not.toHaveBeenCalled();
  });

  it('opens any other task of the own list in the task editor, as before', () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(29))] });
    render(<Harness />);
    fireEvent.click(item('r1'));
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it("filters: follow-ups on mails, reminders without one, a group's list whole", () => {
    const forMe = groupTask('grp:g1', 'Price list', day(29), 'me@example.com', 'Jacob');
    const forAnna = groupTask('grp:g2', 'Call back Haverkamp', day(30), 'anna@example.com', 'Anna');
    useTaskStore.setState({ tasks: [mailFollowUp, reminder('r1', 'Order toner', day(29))] });
    setGroup([forMe, forAnna]);
    render(<Harness />);
    expect(screen.queryByTestId('task-scope-all')).not.toBeNull();
    // For me: the own list and the group's task for me, not Anna's.
    expect(item('grp:g1')).not.toBeNull();
    expect(item('grp:g2')).toBeNull();

    fireEvent.click(screen.getByTestId('task-scope-follow-ups'));
    expect(screen.getAllByTestId('task-item').map((r) => r.dataset.task)).toEqual(['f1']);

    fireEvent.click(screen.getByTestId('task-scope-reminders'));
    expect(screen.getAllByTestId('task-item').map((r) => r.dataset.task)).toEqual(['r1', 'grp:g1']);

    fireEvent.click(screen.getByTestId('task-scope-group:grp'));
    expect(screen.getByTestId('task-scope-group:grp')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('task-item').map((r) => r.dataset.task)).toEqual(['grp:g1', 'grp:g2']);
    expect(within(item('grp:g2')).getByTestId('task-group-person')).toHaveTextContent('Anna');
    expect(within(item('grp:g1')).getByTestId('task-group-person')).toHaveTextContent('me');
  });

  it("opens a group's reminder in the follow-up dialog, which writes its list", () => {
    setGroup([groupTask('grp:g2', 'Call back Haverkamp', day(30), 'anna@example.com', 'Anna')]);
    useTaskStore.setState({ listScope: 'group:grp' });
    render(<Harness />);
    fireEvent.click(item('grp:g2'));
    expect(useFollowUpDialog.getState().reminder).toMatchObject({ taskId: 'grp:g2' });
    expect(onSelectTask).not.toHaveBeenCalled();
  });

  it("shows all when a group's list is gone", () => {
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(29))], listScope: 'group:gone' });
    render(<Harness />);
    expect(screen.getByTestId('task-scope-all')).toHaveAttribute('aria-pressed', 'true');
    expect(item('r1')).not.toBeNull();
  });

  it("completes with the list's toggle, which plugins see: a group's task also in its list, a follow-up with its flag", async () => {
    const toggled = vi.fn();
    const updated = vi.fn();
    taskHooks.onTaskToggleComplete.register('p', toggled);
    taskHooks.onTaskUpdate.register('p', updated);
    setGroup([groupTask('grp:g1', 'Price list', day(29), 'me@example.com', 'Jacob')]);
    useTaskStore.setState({ tasks: [reminder('r1', 'Order toner', day(29)), mailFollowUp] });
    render(<Harness />);

    await act(async () => { fireEvent.click(within(item('grp:g1')).getByTestId('task-toggle')); });
    expect(client.updateCalendarTask).toHaveBeenCalledWith('grp:g1', expect.objectContaining({ progress: 'completed' }));
    expect(useGroupTasks.getState().tasks[0].progress).toBe('completed');

    await act(async () => { fireEvent.click(within(item('r1')).getByTestId('task-toggle')); });
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'r1')?.progress).toBe('completed');

    await act(async () => { fireEvent.click(within(item('f1')).getByTestId('task-toggle')); });
    await waitFor(() => expect(client.toggleStar).toHaveBeenCalledWith('M1', false, 'acc'));
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'f1')?.progress).toBe('completed');

    // One write each, reported as a toggle only.
    expect(client.updateCalendarTask).toHaveBeenCalledTimes(3);
    expect(toggled.mock.calls.map(([e]) => e)).toEqual([
      { taskId: 'grp:g1', complete: true }, { taskId: 'r1', complete: true }, { taskId: 'f1', complete: true },
    ]);
    expect(updated).not.toHaveBeenCalled();
  });

  it('reopens a group task in its list, and completes a cancelled task as before', async () => {
    useTaskStore.setState({ showCompleted: true, tasks: [reminder('c1', 'Cancelled', day(29), null, { progress: 'cancelled' })] });
    setGroup([groupTask('grp:g1', 'Price list', day(29), 'me@example.com', 'Jacob')]);
    useGroupTasks.setState({ tasks: [{ ...useGroupTasks.getState().tasks[0], progress: 'completed' }] });
    render(<Harness />);
    await act(async () => { fireEvent.click(within(item('grp:g1')).getByTestId('task-toggle')); });
    expect(useGroupTasks.getState().tasks[0].progress).toBe('needs-action');
    await act(async () => { fireEvent.click(within(item('c1')).getByTestId('task-toggle')); });
    expect(client.updateCalendarTask).toHaveBeenLastCalledWith('c1', expect.objectContaining({ progress: 'completed' }));
  });

  it('shows the time of a task due at one, beside its day', () => {
    useTaskStore.setState({
      tasks: [
        reminder('t1', 'Call today', null, null, { due: '2026-10-28T14:30:00', showWithoutTime: false }),
        reminder('t2', 'Late call', null, null, { due: '2026-10-26T09:15:00', showWithoutTime: false }),
        reminder('t3', 'Later call', null, null, { due: '2026-11-10T08:00:00', showWithoutTime: false }),
      ],
    });
    render(<Harness />);
    expect(within(item('t1')).getByTestId('task-due')).toHaveTextContent(/^14:30$/);
    expect(within(item('t2')).getByTestId('task-due')).toHaveTextContent(/overdue_days.*, 09:15$/);
    expect(within(item('t3')).getByTestId('task-due')).toHaveTextContent(/, 08:00$/);
  });

  it('puts a repeating task at its next occurrence', () => {
    useTaskStore.setState({
      tasks: [reminder('w', 'Weekly report', day(1), null, { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' } as never] })],
    });
    render(<Harness />);
    expect(groupsShown()).toEqual(['task-group-tomorrow']);
  });
});
