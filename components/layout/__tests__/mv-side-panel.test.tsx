import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MvSidePanel } from '../mv-side-panel';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { buildFollowUpTask, buildReminderTask } from '@/lib/follow-ups';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// Links as anchors, so the ways out of the mail view can be told.
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('MvSidePanel', () => {
  beforeEach(() => {
    useCalendarStore.setState({ supportsCalendar: true, calendars: [], events: [] } as never);
    useSettingsStore.setState({ enableCalendarTasks: false } as never);
  });

  it('offers only the apps that are there, and opens and closes their panel', () => {
    const { container } = render(<MvSidePanel onOpenMail={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mv_tasks' })).toBeNull();
    expect(container.querySelector('[data-mv-side-panel]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-mv-side-panel="calendar"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-mv-side-panel]')).toBeNull();
  });

  it('adds Tasks when tasks are turned on', () => {
    useSettingsStore.setState({ enableCalendarTasks: true } as never);
    render(<MvSidePanel onOpenMail={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'mv_tasks' })).toBeInTheDocument();
  });

  it('draws nothing without any app to show', () => {
    useCalendarStore.setState({ supportsCalendar: false } as never);
    const { container } = render(<MvSidePanel onOpenMail={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('MvSidePanel Tasks', () => {
  // Wednesday 28.10.2026, 10:30 on the wall clock.
  const NOW = new Date(2026, 9, 28, 10, 30);
  const day = (d: number) => new Date(2026, 9, d);
  const calendars = [
    { id: 'events', name: 'Calendar', isDefault: true },
    { id: 'tasks', name: 'My tasks', isTasksOnly: true },
  ] as Calendar[];
  const stored = (task: Partial<CalendarTask>, id: string) =>
    ({ ...task, id, uid: id, updated: '2026-10-26T08:00:00Z' }) as CalendarTask;
  const reminder = (id: string, title: string, due: Date | null) =>
    stored(buildReminderTask({ title, calendarId: 'tasks', due, reminderAt: null }), id);
  const mailFollowUp = (id: string, due: Date) => stored(buildFollowUpTask({
    title: 'Call: Offer 4711',
    mailUrl: 'https://host/mail/message/M1?mailAccount=acc',
    subject: 'Offer 4711',
    from: { name: 'Lena Brandt', email: 'lena@example.com' },
    calendarId: 'tasks',
    due,
    reminderAt: null,
  }), id);

  const onOpenMail = vi.fn();
  let client: {
    getAccountId: () => string;
    getEmailFields: ReturnType<typeof vi.fn>;
    queryEmailFields: ReturnType<typeof vi.fn>;
    createCalendarTask: ReturnType<typeof vi.fn>;
    updateCalendarTask: ReturnType<typeof vi.fn>;
    toggleStar: ReturnType<typeof vi.fn>;
    hasAccountCapability: ReturnType<typeof vi.fn>;
    supportsContacts: () => boolean;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    onOpenMail.mockReset();
    client = {
      getAccountId: () => 'acc',
      getEmailFields: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, keywords: { $flagged: true } }))),
      queryEmailFields: vi.fn(async () => []),
      createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({ ...task, id: 'task-new', uid: 'u', updated: '' }) as CalendarTask),
      updateCalendarTask: vi.fn(async (id: string) => id),
      toggleStar: vi.fn(async () => {}),
      hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc'),
      supportsContacts: () => false,
    };
    useAuthStore.setState({ isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login' });
    useCalendarStore.setState({ supportsCalendar: true, calendars, events: [] } as never);
    useSettingsStore.setState({ enableCalendarTasks: true, timeZone: 'auto', firstDayOfWeek: 1 } as never);
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
    useTaskStore.setState({ tasks: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openTasks = () => {
    const view = render(<MvSidePanel onOpenMail={onOpenMail} />);
    fireEvent.click(screen.getByRole('button', { name: 'mv_tasks' }));
    return view.container.querySelector('[data-mv-side-panel="tasks"]') as HTMLElement;
  };
  const titles = (group: string) => within(screen.getByTestId(`upcoming-group-${group}`))
    .getAllByTestId('upcoming-open').map((b) => b.textContent);

  it('opens the shared tasks panel: plain tasks and follow-ups by due day, the far ones folded', () => {
    useTaskStore.setState({
      tasks: [
        reminder('r1', 'Check the dunning run', day(26)),
        mailFollowUp('f1', day(28)),
        reminder('r2', 'Some day', null),
      ],
    });
    const panel = openTasks();
    expect(within(panel).getByText('mv_tasks')).toBeTruthy();
    expect(titles('overdue')[0]).toContain('Check the dunning run');
    expect(titles('today')[0]).toContain('Lena Brandt · Offer 4711');
    expect(within(panel).getAllByTestId('upcoming-item')).toHaveLength(2);
    expect(within(screen.getByTestId('upcoming-group-no-date')).getByTestId('upcoming-group-head').getAttribute('aria-expanded')).toBe('false');
    // Its one way into the task list is the panel's foot, not the header.
    expect(within(panel).getAllByRole('link').map((a) => a.getAttribute('data-testid'))).toEqual(['upcoming-open-list']);
  });

  it('adds a task due today from its line, into the task list', async () => {
    openTasks();
    const line = screen.getByTestId('upcoming-quick') as HTMLInputElement;
    fireEvent.change(line, { target: { value: 'Order toner' } });
    await act(async () => { fireEvent.submit(line.closest('form')!); });
    await waitFor(() => expect(client.createCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.createCalendarTask.mock.calls[0][0]).toMatchObject({
      title: 'Order toner',
      due: '2026-10-28T00:00:00',
      calendarIds: { tasks: true },
    });
    expect(titles('today')[0]).toContain('Order toner');
  });

  it('opens a follow-up\'s mail beside the panel, and ticks a task off', async () => {
    useTaskStore.setState({ tasks: [mailFollowUp('f1', day(28)), reminder('r1', 'Order toner', day(29))] });
    openTasks();
    await act(async () => { fireEvent.click(within(screen.getByTestId('upcoming-group-today')).getByTestId('upcoming-open')); });
    await waitFor(() => expect(onOpenMail).toHaveBeenCalledWith('M1', 'acc'));

    await act(async () => { fireEvent.click(within(screen.getByTestId('upcoming-group-tomorrow')).getByTestId('upcoming-done')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledWith('r1', { progress: 'completed' }));
  });
});
