import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { format } from 'date-fns';
import { ThreadListItem } from '../thread-list-item';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useUIStore } from '@/stores/ui-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarTask, Email } from '@/lib/jmap/types';

// The texts with their values, so a label can be read back.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d) }),
}));

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

// A conversation of three mails; the middle one has a follow-up.
const mail = (id: string, receivedAt: string): Email => ({
  id,
  threadId: 'T',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1,
  receivedAt,
  from: [{ name: 'Claire', email: 'claire@example.com' }],
  subject: 'Offer',
  hasAttachment: false,
});
const mails = [mail('M1', '2026-10-20T08:00:00Z'), mail('M2', '2026-10-21T08:00:00Z'), mail('M3', '2026-10-22T08:00:00Z')];

const followUp = (emailId: string): CalendarTask => ({
  id: `task-${emailId}`,
  calendarIds: { tasks: true },
  '@type': 'Task',
  uid: 'u',
  title: 'Follow up: Offer',
  description: '',
  due: `${format(new Date(), 'yyyy-MM-dd')}T00:00:00`,
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
  updated: '',
  recurrenceRules: null,
  alerts: null,
  relatedTo: null,
  links: {
    mail: { '@type': 'Link', href: `https://host/mail/message/${emailId}?mailAccount=acc`, cid: null, contentType: null, size: null, rel: 'describedby', display: null, title: null },
  },
});

const client = {
  getAccountId: () => 'acc',
  updateCalendarTask: vi.fn(async (id: string) => id),
  toggleStar: vi.fn(async () => {}),
};

function renderThread(expanded = false) {
  const [thread] = groupEmailsByThread(mails);
  return render(
    <ThreadListItem
      thread={thread}
      isExpanded={expanded}
      expandedEmails={mails}
      onToggleExpand={() => {}}
      onEmailSelect={() => {}}
    />,
  );
}

beforeEach(() => {
  client.updateCalendarTask.mockClear();
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
  useAuthStore.setState({ client: client as unknown as IJMAPClient, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true, showPreview: false, interfaceLayout: 'default', hoverActions: [] });
  useCalendarStore.setState({ supportsCalendar: true, calendars: [] });
  useTaskStore.setState({ tasks: [followUp('M2')] });
  useEmailStore.setState({ emails: mails, selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox', mailboxes: [], viewingAccountId: null });
});

describe('a conversation row with a follow-up on one of its mails', () => {
  it('shows that follow-up and acts on its mail, not on the newest', async () => {
    renderThread();
    expect(screen.getByTestId('follow-up-chip')).toHaveAttribute('data-follow-up', 'open');

    const flag = screen.getByTestId('follow-up-flag');
    expect(flag).toHaveAttribute('aria-label', 'flag_aria{"state":"due_today","action":"flag_action_done"}');
    await act(async () => { fireEvent.click(flag); });
    expect(client.updateCalendarTask).toHaveBeenCalledWith('task-M2', { progress: 'completed' });
  });

  it('puts the hover flag on that mail too, so a reply gets no second follow-up', async () => {
    const { container } = renderThread();
    fireEvent.pointerOver(container.querySelector('.group')!);
    const flags = screen.getAllByTestId('follow-up-flag');
    expect(flags.length).toBe(2);
    await act(async () => { fireEvent.click(flags[1]); });
    expect(client.updateCalendarTask).toHaveBeenCalledWith('task-M2', { progress: 'completed' });
  });

  it('gives each unfolded mail its own chip and flag', () => {
    renderThread(true);
    const items = screen.getAllByTestId('thread-email-item');
    expect(items).toHaveLength(3);
    const states = items.map((item) => within(item).getByTestId('follow-up-flag').getAttribute('data-follow-up'));
    expect(states).toEqual(['none', 'open', 'none']);
    expect(within(items[1]).getByTestId('follow-up-chip')).toBeInTheDocument();
  });

  it('falls back to the newest mail when none has a follow-up', () => {
    useTaskStore.setState({ tasks: [] });
    const { container } = renderThread();
    expect(screen.queryByTestId('follow-up-chip')).toBeNull();
    fireEvent.pointerOver(container.querySelector('.group')!);
    expect(screen.getByTestId('follow-up-flag')).toHaveAttribute('aria-label', 'flag_aria{"state":"flag_state_none","action":"flag_action_set"}');
  });
});
