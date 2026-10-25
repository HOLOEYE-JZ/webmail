import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpDialog, ReminderDialog } from '../follow-up-dialog';
import { FollowUpChip, FollowUpFlagButton, FollowUpInfoBar } from '../follow-up';
import { useFollowUpDialog } from '@/stores/follow-up-dialog-store';
import { useGroupTasks } from '@/hooks/use-group-follow-ups';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarRights, CalendarTask, Email, Principal } from '@/lib/jmap/types';

const TEXTS: Record<string, string> = {
  task_title: '{action}: {subject}',
  'actions.follow_up': 'Follow up',
  'actions.write_quote': 'Write a quote',
  no_subject: '(no subject)',
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

const read: CalendarRights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};

const ownCalendars = [
  { id: 'events', name: 'Calendar', isDefault: true, myRights: read },
  { id: 'tasks', name: 'My tasks', isTasksOnly: true, myRights: read },
] as Calendar[];

/** The group's task list, shared with Anna and Ben (and the user). */
function groupList(shareWith: Record<string, CalendarRights> = { anna: read, ben: read, me: read }): Calendar {
  return {
    id: 'grp:b', originalId: 'b', name: 'Tasks', accountId: 'grp', accountName: 'sales@example.com',
    isShared: true, isDefault: true, isTasksOnly: false, myRights: read, shareWith,
  } as Calendar;
}

const principals: Principal[] = [
  { id: 'me', type: 'individual', name: 'me@example.com', email: 'me@example.com', description: 'Jacob' },
  { id: 'anna', type: 'individual', name: 'anna@example.com', email: 'anna@example.com', description: 'Anna' },
  { id: 'ben', type: 'individual', name: 'ben@example.com', email: 'ben@example.com', description: 'Ben' },
  { id: 'grp', type: 'group', name: 'sales@example.com', email: 'sales@example.com' },
];

const groupFolder = { id: 'grp:inbox', originalId: 'inbox', accountId: 'grp', accountName: 'sales@example.com', isShared: true } as never;

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
const groupMail = { ...mail, mailboxIds: { 'grp:inbox': true } } as Email;

function groupTask(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'grp:t1',
    originalId: 't1',
    accountId: 'grp',
    isShared: true,
    calendarIds: { 'grp:b': true },
    '@type': 'Task',
    uid: 'u',
    title: 'Write a quote: Offer 4711',
    description: '',
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
      mail: { '@type': 'Link', href: 'https://host/mail/message/M1?mailAccount=grp', cid: null, contentType: null, size: null, rel: 'describedby', display: null, title: 'Offer 4711' },
    },
    participants: {
      for: {
        '@type': 'Participant', name: 'Anna', calendarAddress: 'mailto:anna@example.com', roles: { owner: true },
        'bulwarkmail.org:setBy': { name: 'Ben', email: 'ben@example.com' },
      } as never,
    },
    organizerCalendarAddress: 'mailto:ben@example.com',
    ...over,
  };
}

function makeClient() {
  return {
    getAccountId: () => 'me',
    getEmailFields: vi.fn(async () => [{ id: 'M1', messageId: ['offer@example.com'] }]),
    createCalendarTask: vi.fn(async (task: Partial<CalendarTask>) => ({
      ...task, id: 'grp:new', accountId: 'grp', isShared: true, uid: 'u', updated: '',
    }) as CalendarTask),
    updateCalendarTask: vi.fn(async (id: string, _updates: Partial<CalendarTask>) => id),
    deleteCalendarTask: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    getPrincipals: vi.fn(async () => principals),
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'me' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;
const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
/** Opens a property button's popover ("Visible", "For"). */
const open = (button: string) => fireEvent.click(screen.getByTestId(button));
const selected = (el: HTMLElement) => el.getAttribute('aria-selected');

function setGroupList(list: Calendar, tasks: CalendarTask[] = []) {
  useGroupTasks.setState({
    lists: [{ accountId: 'grp', name: 'sales@example.com', list }],
    tasks,
    loadedBy: client as unknown as IJMAPClient,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client = makeClient();
  useAuthStore.setState({
    isAuthenticated: true, client: client as unknown as IJMAPClient, activeAccountId: 'login',
    username: 'me@example.com', identities: [{ id: 'i', name: 'Jacob', email: 'me@example.com', mayDelete: false }],
  });
  useSettingsStore.setState({ enableCalendarTasks: true, timeZone: 'auto', calendarWorkingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 });
  useCalendarStore.setState({ supportsCalendar: true, calendars: [...ownCalendars, groupList()], participantIdentities: [] });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [] } });
  useTaskStore.setState({ tasks: [] });
  useEmailStore.setState({ emails: [{ ...groupMail }], selectedEmail: null, mailboxes: [groupFolder], selectedMailbox: 'grp:inbox', viewingAccountId: null });
  useFollowUpDialog.setState({ email: null, group: null });
  setGroupList(groupList());
});

afterEach(() => {
  vi.useRealTimers();
  act(() => useGroupTasks.getState().clear());
});

describe('the follow-up menu', () => {
  it('offers "for a colleague" on a group mailbox\'s mail and opens the dialog for the group\'s list', () => {
    render(<FollowUpFlagButton email={groupMail} />);
    fireEvent.contextMenu(screen.getByTestId('follow-up-flag'));
    const entry = screen.getByTestId('follow-up-colleague');
    expect(entry.textContent).toContain('group.menu_colleague{"group":"sales@example.com"}');
    expect((entry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(entry);
    expect(useFollowUpDialog.getState().group).toEqual({ taskId: null });
    expect(useFollowUpDialog.getState().email?.id).toBe('M1');
  });

  it('greys it on a mail of the user\'s own mailbox: "only in a group mailbox"', () => {
    useEmailStore.setState({ emails: [{ ...mail }], mailboxes: [], selectedMailbox: 'inbox' });
    render(<FollowUpFlagButton email={mail} />);
    fireEvent.contextMenu(screen.getByTestId('follow-up-flag'));
    const entry = screen.getByTestId('follow-up-colleague') as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(entry.textContent).toContain('group.only_in_group');
  });
});

describe('the dialog in the group\'s list', () => {
  it('offers me and the people the list is shared with, picks the first colleague and writes the task for them', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: null }} onClose={onClose} />);
    // The first colleague, once the list's people are known.
    await waitFor(() => expect(screen.getByTestId('follow-up-for').textContent).toBe('group.to{"name":"Anna"}'));
    open('follow-up-for');
    expect(screen.getAllByTestId('follow-up-for-person').map((b) => b.textContent)).toEqual(['Anna', 'Ben']);
    // The user is never listed twice: offered as "me".
    expect(screen.getByTestId('follow-up-for-me').textContent).toBe('group.me');
    expect(selected(screen.getAllByTestId('follow-up-for-person')[0])).toBe('true');
    open('follow-up-for');
    // A colleague: in the group's list.
    expect(screen.getByTestId('follow-up-visible').textContent).toBe('sales@example.com');
    open('follow-up-visible');
    expect(selected(screen.getByTestId('follow-up-visible-group'))).toBe('true');
    open('follow-up-visible');
    // Neither the alarm mail (it would go to the group's inbox) nor settling on an answer.
    expect(screen.queryByTestId('follow-up-reminder-mail')).toBeNull();
    expect(screen.queryByTestId('follow-up-settles-on-reply')).toBeNull();
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('group.kept_colleague{"group":"sales@example.com","name":"Anna"}');

    fireEvent.click(field('follow-up-reminder-on'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ 'grp:b': true });
    expect(written.links?.mail.href).toMatch(/\/mail\/message\/M1\?mailAccount=grp$/);
    expect(written.participants?.for).toMatchObject({
      calendarAddress: 'mailto:anna@example.com',
      roles: { owner: true },
      'bulwarkmail.org:setBy': { email: 'me@example.com' },
    });
    expect(Object.values(written.alerts ?? {}).map((a) => a.action)).toEqual(['display']);
    expect(client.toggleStar).not.toHaveBeenCalled();
    // Kept in the group's store, not in the user's own list.
    expect(useGroupTasks.getState().tasks.map((t) => t.id)).toEqual(['grp:new']);
    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('says when the list is shared with no one, and offers only "me"', async () => {
    setGroupList(groupList({}));
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: null }} onClose={vi.fn()} />);
    await act(async () => {});
    open('follow-up-for');
    expect(screen.queryAllByTestId('follow-up-for-person')).toHaveLength(0);
    // "A colleague…" greyed, the reason as its tooltip.
    const colleague = screen.getByTestId('follow-up-for-hint');
    expect(colleague.getAttribute('aria-disabled')).toBe('true');
    expect(colleague.getAttribute('title')).toBe('group.not_shared{"group":"sales@example.com"}');
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('group.kept_me{"group":"sales@example.com"}');
  });

  it('a new follow-up of the own kind can go into the group\'s list for the user', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" onClose={onClose} />);
    // No "For" while it is only mine.
    expect(screen.queryByTestId('follow-up-for')).toBeNull();
    open('follow-up-visible');
    expect(selected(screen.getByTestId('follow-up-visible-me'))).toBe('true');
    fireEvent.click(screen.getByTestId('follow-up-visible-group'));
    expect(screen.getByTestId('follow-up-for').textContent).toBe('group.to{"name":"group.me"}');
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ 'grp:b': true });
    expect(written.participants?.for?.calendarAddress).toBe('mailto:me@example.com');
  });

  it('changes whom an existing one is for by its participant, its list staying', async () => {
    setGroupList(groupList(), [groupTask()]);
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: 'grp:t1' }} onClose={onClose} />);
    // An existing group task stays in its list.
    expect((screen.getByTestId('follow-up-visible') as HTMLButtonElement).disabled).toBe(true);
    open('follow-up-for');
    await waitFor(() => expect(screen.getAllByTestId('follow-up-for-person')).toHaveLength(2));
    expect(selected(screen.getAllByTestId('follow-up-for-person')[0])).toBe('true');
    fireEvent.click(screen.getAllByTestId('follow-up-for-person')[1]);
    expect(screen.getByTestId('follow-up-for').textContent).toBe('group.to{"name":"Ben"}');
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [id, patch] = client.updateCalendarTask.mock.calls[0];
    expect(id).toBe('grp:t1');
    expect(patch).toMatchObject({ 'participants/for': { calendarAddress: 'mailto:ben@example.com' } });
    expect(useGroupTasks.getState().tasks[0].participants?.for?.calendarAddress).toBe('mailto:ben@example.com');
  });

  it('a reminder without a mail can go into a group\'s list', async () => {
    const onClose = vi.fn();
    render(<ReminderDialog taskId={null} title="Check the dunning run" focus="action" onClose={onClose} />);
    open('follow-up-visible');
    fireEvent.click(screen.getByTestId('follow-up-visible-group'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ 'grp:b': true });
    expect(written.title).toBe('Check the dunning run');
    expect(written.links).toBeUndefined();
    expect(written.participants?.for?.calendarAddress).toBe('mailto:me@example.com');
  });
});

describe('"only me" and tasks naming no one', () => {
  it('"only me" in the colleague dialog keeps it in the user\'s own list, as on any group mailbox\'s mail', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: null }} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('follow-up-for').textContent).toBe('group.to{"name":"Anna"}'));
    open('follow-up-for');
    fireEvent.click(screen.getByTestId('follow-up-for-me'));
    open('follow-up-visible');
    fireEvent.click(screen.getByTestId('follow-up-visible-me'));
    expect(screen.queryByTestId('follow-up-for')).toBeNull();
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('kept_only_me{"list":"My tasks"}');
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ tasks: true });
    expect(written.participants).toBeUndefined();
    expect(useGroupTasks.getState().tasks).toEqual([]);
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('a group task naming no one stays so when saved, unless someone is picked', async () => {
    setGroupList(groupList(), [groupTask({ participants: null, organizerCalendarAddress: null })]);
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: 'grp:t1' }} onClose={onClose} />);
    expect(screen.getByTestId('follow-up-for').textContent).toBe('group.to{"name":"group.nobody"}');
    open('follow-up-for');
    expect(selected(screen.getByTestId('follow-up-for-nobody'))).toBe('true');
    expect(selected(screen.getByTestId('follow-up-for-me'))).toBe('false');
    open('follow-up-for');
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('group.kept_nobody{"group":"sales@example.com"}');
    fireEvent.click(screen.getByTestId('follow-up-note-add'));
    fireEvent.change(field('follow-up-note'), { target: { value: 'Two units' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = client.updateCalendarTask.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.description).toBe('Two units');
    expect(Object.keys(patch).some((k) => k.startsWith('participants'))).toBe(false);
  });

  it('naming someone on such a task writes the owner', async () => {
    setGroupList(groupList(), [groupTask({ participants: null })]);
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="action" group={{ taskId: 'grp:t1' }} onClose={onClose} />);
    open('follow-up-for');
    fireEvent.click(screen.getByTestId('follow-up-for-me'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = client.updateCalendarTask.mock.calls[0][1] as Record<string, unknown>;
    expect((patch.participants as Record<string, { calendarAddress: string }>).for.calendarAddress).toBe('mailto:me@example.com');
  });

  it('the chip of a task naming no one says so', () => {
    setGroupList(groupList(), [groupTask({ participants: null })]);
    render(<FollowUpChip email={groupMail} />);
    expect(screen.getByTestId('group-follow-up-chip').textContent).toMatch(/^group\.nobody · /);
  });

  it('without a recognised group list the reminder dialog offers no "Visible"', () => {
    useGroupTasks.setState({ lists: [], tasks: [] });
    render(<ReminderDialog taskId={null} title="Check" focus="action" onClose={vi.fn()} />);
    expect(screen.queryByTestId('follow-up-visible')).toBeNull();
    expect(screen.queryByTestId('follow-up-for')).toBeNull();
  });
});

describe('at the mail', () => {
  it('every reader sees the chip and the bar: for whom, set by whom, in which list', async () => {
    setGroupList(groupList(), [groupTask()]);
    render(<><FollowUpChip email={groupMail} /><FollowUpInfoBar email={groupMail} /></>);
    expect(screen.getByTestId('group-follow-up-chip').textContent).toMatch(/^Anna · Write a quote · due_on/);
    // The reminder is Anna's: not shown to the user.
    expect(screen.getByTestId('group-follow-up-chip').textContent).not.toContain('reminder');
    expect(screen.getByTestId('group-follow-up-bar-for').textContent)
      .toBe('group.for_person{"name":"Anna"} (group.by_person{"name":"Ben"})');
    expect(screen.getByTestId('group-follow-up-bar').textContent).toContain('group.list_of{"group":"sales@example.com"}');
    // No own follow-up: no "only me" chip.
    expect(screen.queryByTestId('follow-up-chip')).toBeNull();
  });

  it('anyone may complete it: written in the group\'s list, no flag', async () => {
    setGroupList(groupList(), [groupTask()]);
    render(<FollowUpInfoBar email={groupMail} />);
    await act(async () => { fireEvent.click(screen.getByText('done_button')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalled());
    expect(client.updateCalendarTask.mock.calls[0][1]).toMatchObject({ progress: 'completed' });
    expect(useGroupTasks.getState().tasks[0].progress).toBe('completed');
    expect(client.toggleStar).not.toHaveBeenCalled();
  });

  it('the user\'s own task says "me", and its reminder shows', () => {
    setGroupList(groupList(), [groupTask({
      participants: { for: { '@type': 'Participant', name: 'Jacob', calendarAddress: 'mailto:me@example.com', roles: { owner: true } } as never },
    })]);
    render(<FollowUpChip email={groupMail} />);
    const chip = screen.getByTestId('group-follow-up-chip');
    expect(chip.textContent).toMatch(/^group\.chip_me · /);
    expect(chip.getAttribute('data-for-me')).toBe('true');
  });
});
