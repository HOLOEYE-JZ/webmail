import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskModal } from '../task-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { buildFollowUpTask } from '@/lib/follow-ups';
import type { CalendarTask, Calendar } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A follow-up's task names its mail: openable while the mail is there (also
// after a move), "no longer available" with sender and subject once deleted.

const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

const calendars = [{ id: 'tasks', name: 'Tasks', isShared: false }] as unknown as Calendar[];

const task = {
  ...buildFollowUpTask({
    title: 'Follow up: Samples returned',
    mailUrl: 'https://mail.example/mail/message/M1?mailAccount=acc',
    subject: 'Samples returned',
    messageId: ['samples@kessler.example'],
    from: { name: 'Rita Vogt', email: 'rita@kessler.example' },
    calendarId: 'tasks',
    due: null,
    reminderAt: null,
  }),
  id: 'T1',
  uid: 'T1',
  priority: 0,
} as CalendarTask;

let getEmailFields: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockReset();
  useSettingsStore.setState({ enableCalendarTasks: true, enableFollowUps: true });
  useCalendarStore.setState({ supportsCalendar: true });
  getEmailFields = vi.fn(async () => [{ id: 'M1' }]);
  useAuthStore.setState({
    client: {
      getAccountId: () => 'acc',
      getEmailFields,
      queryEmailFields: vi.fn(async () => []),
      hasAccountCapability: (_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp',
    } as unknown as IJMAPClient,
  });
});

describe('TaskModal follow-up mail', () => {
  it('names no mail while follow-ups are off', async () => {
    useSettingsStore.setState({ enableFollowUps: false });
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('Follow up: Samples returned')).toBeTruthy();
    // Long enough for the lookup the dialog makes with follow-ups on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('task-mail')).toBeNull();
    expect(getEmailFields).not.toHaveBeenCalled();
  });

  it('offers to open the mail while it is there', async () => {
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('task-open-mail')).toBeTruthy());
    expect(screen.getByTestId('task-mail').textContent).toContain('Rita Vogt · Samples returned');
    expect(screen.queryByText('mail_gone')).toBeNull();
  });

  it('names a deleted mail as gone, with sender and subject, and offers no way to open it', async () => {
    getEmailFields.mockResolvedValue([]);
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('task-mail').getAttribute('data-mail')).toBe('gone'));
    expect(screen.getByText('mail_gone')).toBeTruthy();
    expect(screen.getByTestId('task-mail').textContent).toContain('Rita Vogt · Samples returned');
    expect(screen.queryByTestId('task-open-mail')).toBeNull();
  });

  it('opens a group mailbox\'s mail in its account', async () => {
    const groupTask = { ...task, links: { ...task.links, mail: { ...task.links!.mail, href: 'https://mail.example/mail/message/M1?mailAccount=grp' } } } as CalendarTask;
    const onClose = vi.fn();
    render(<TaskModal task={groupTask} calendars={calendars} onSave={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('task-open-mail')).toBeTruthy());
    expect(getEmailFields).toHaveBeenCalledWith(['M1'], ['id'], 'grp');
    fireEvent.click(screen.getByTestId('task-open-mail'));
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/mail/message/M1?mailAccount=grp');
  });

  it('opens the own mail by its plain link', async () => {
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('task-open-mail')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-open-mail'));
    expect(push).toHaveBeenCalledWith('/mail/message/M1');
  });

  it('offers no mail of an account the login does not reach', () => {
    const elsewhere = { ...task, links: { ...task.links, mail: { ...task.links!.mail, href: 'https://mail.example/mail/message/M1?mailAccount=other' } } } as CalendarTask;
    render(<TaskModal task={elsewhere} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('task-mail')).toBeNull();
  });
});
