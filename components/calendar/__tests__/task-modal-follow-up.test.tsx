import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskModal } from '../task-modal';
import { useAuthStore } from '@/stores/auth-store';
import { buildFollowUpTask } from '@/lib/follow-ups';
import type { CalendarTask, Calendar } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A follow-up's task names its mail: openable while the mail is there (also
// after a move), "no longer available" with sender and subject once deleted.

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
  getEmailFields = vi.fn(async () => [{ id: 'M1' }]);
  useAuthStore.setState({
    client: {
      getAccountId: () => 'acc',
      getEmailFields,
      queryEmailFields: vi.fn(async () => []),
    } as unknown as IJMAPClient,
  });
});

describe('TaskModal follow-up mail', () => {
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
});
