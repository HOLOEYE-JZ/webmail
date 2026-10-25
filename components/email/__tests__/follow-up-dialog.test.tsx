import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpDialog, ReminderDialog } from '../follow-up-dialog';
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
    // The login reaches its own account and the group mailbox `grp`.
    hasAccountCapability: vi.fn((_capability: string, accountId?: string) => accountId === 'acc' || accountId === 'grp'),
  };
}

let client: ReturnType<typeof makeClient>;
const flagged = () => !!useEmailStore.getState().emails[0].keywords.$flagged;
const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

/** Opens a property button's popover and chooses one of its options. */
const choose = (button: string, option: string | RegExp) => {
  fireEvent.click(screen.getByTestId(button));
  fireEvent.click(screen.getByRole('option', { name: option }));
};
/** The note, opened first where it is folded ("＋ Note"). */
const note = () => {
  const add = screen.queryByTestId('follow-up-note-add');
  if (add) fireEvent.click(add);
  return screen.getByTestId('follow-up-note');
};

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
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Follow up');
    expect(field('follow-up-due-choice').value).toBe('tomorrow');
    // The date itself only once "Pick a date…" is chosen.
    expect(screen.queryByTestId('follow-up-due')).toBeNull();
    // The note is folded until there is one.
    expect(screen.queryByTestId('follow-up-note')).toBeNull();
    expect(field('follow-up-reminder-on').checked).toBe(false);
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('kept_in{"list":"My tasks"}');

    choose('follow-up-action', 'Call');
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Call');
    expect(screen.queryByTestId('follow-up-action-list')).toBeNull();
    fireEvent.change(field('follow-up-due-choice'), { target: { value: 'this-week' } });
    // The quick choice sets the reminder too: two working days on, at 08:00.
    expect(field('follow-up-due-choice').value).toBe('this-week');
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(field('follow-up-reminder-day').value).toBe('2026-10-28');
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '10:30' } });
    fireEvent.change(note(), { target: { value: 'Ask for the drawing' } });
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
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Write a quote');
    expect(screen.queryByTestId('follow-up-action-text')).toBeNull();
    // A day none of the quick choices gives: shown as the date.
    expect(field('follow-up-due-choice').value).toBe('pick');
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
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Other…');
    expect(field('follow-up-action-text').value).toBe('Write a quote');
  });

  it('keeps the title while the action stays, and writes it anew when it changes', async () => {
    useTaskStore.setState({ tasks: [followUp({ title: 'Write a quote: Offer 4711' })] });
    const first = render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.click(field('follow-up-reminder-on'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][1]).toEqual({ due: '2026-10-29T00:00:00', showWithoutTime: true, 'alerts/follow-up': null });
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

describe('FollowUpDialog: the controls', () => {
  it('"Pick a date…" shows the date input, and the day picked is written', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="action" onClose={onClose} />);
    fireEvent.change(field('follow-up-due-choice'), { target: { value: 'pick' } });
    expect(field('follow-up-due').value).toBe('2026-10-27');
    fireEvent.change(field('follow-up-due'), { target: { value: '2026-11-12' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.createCalendarTask.mock.calls[0][0]).toMatchObject({ due: '2026-11-12T00:00:00' });
  });

  it('the action\'s popover: Escape closes it and not the dialog, "Other…" asks for the text', () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="action" onClose={onClose} />);
    const button = screen.getByTestId('follow-up-action');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // The chosen one has the focus.
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Follow up' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByTestId('follow-up-action-list')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);

    choose('follow-up-action', 'Other…');
    expect(field('follow-up-action-text').value).toBe('');
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Other…');
  });

  it('explains behind ⓘ, not under the fields', () => {
    render(<FollowUpDialog email={mail} focus="reminder" onClose={vi.fn()} />);
    const tips = screen.getAllByRole('tooltip', { hidden: true });
    expect(tips.map((tip) => tip.textContent)).toEqual(['reminder_mail_hint', 'reply.settles_hint']);
    expect(tips.every((tip) => tip.hidden)).toBe(true);
    const help = screen.getAllByRole('button', { name: 'help' })[0];
    fireEvent.focus(help);
    expect(tips[0].hidden).toBe(false);
    expect(help.getAttribute('aria-describedby')).toBe(tips[0].id);
    fireEvent.blur(help);
    expect(tips[0].hidden).toBe(true);
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

describe('FollowUpDialog: the reminder also as a mail', () => {
  // A second before the reminder (MAIL_ALERT_LEAD_MS).
  const mailAlert = (reminder: Date) => ({
    '@type': 'Alert' as const,
    trigger: { '@type': 'AbsoluteTrigger' as const, when: new Date(reminder.getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    action: 'email' as const,
    acknowledged: null,
    relatedTo: null,
  });

  it('writes an alarm mail beside the reminder, a second ahead of it', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="reminder" onClose={onClose} />);
    expect(field('follow-up-reminder-mail').checked).toBe(false);
    fireEvent.click(field('follow-up-reminder-mail'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.alerts!['follow-up-mail']).toEqual(mailAlert(new Date(2026, 9, 27, 8, 0)));
    expect(written.alerts!['follow-up'].action).toBe('display');
  });

  it('reads it back, moves it with the reminder and takes it off with the box', async () => {
    const task = followUp();
    task.alerts = { ...task.alerts, 'follow-up-mail': mailAlert(new Date(2026, 9, 28, 10, 0)) };
    useTaskStore.setState({ tasks: [task] });
    const first = render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    expect(field('follow-up-reminder-mail').checked).toBe(true);
    // Not counted as another reminder.
    expect(screen.queryByTestId('follow-up-other-reminders')).toBeNull();
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '11:00' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][1]).toMatchObject({
      'alerts/follow-up-mail': mailAlert(new Date(2026, 9, 28, 11, 0)),
    });
    first.unmount();

    useTaskStore.setState({ tasks: [task] });
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.click(field('follow-up-reminder-mail'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(2));
    expect(client.updateCalendarTask.mock.calls[1][1]).toEqual({
      due: '2026-10-29T00:00:00', showWithoutTime: true, 'alerts/follow-up-mail': null,
    });
  });

  it('is greyed out without a reminder, and turning the reminder off takes the mail off too', async () => {
    const task = followUp();
    task.alerts = { ...task.alerts, 'follow-up-mail': mailAlert(new Date(2026, 9, 28, 10, 0)) };
    useTaskStore.setState({ tasks: [task] });
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.click(field('follow-up-reminder-on'));
    expect(field('follow-up-reminder-mail').disabled).toBe(true);
    expect(field('follow-up-reminder-mail').checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][1]).toMatchObject({ 'alerts/follow-up': null, 'alerts/follow-up-mail': null });
  });

  it('is not offered for a task in a shared list (a group mailbox\'s), whose alarm mail stays as it is', async () => {
    useCalendarStore.setState({ calendars: [...calendars, { id: 'group', name: 'vertrieb@', isShared: true } as Calendar] });
    const task = followUp({ id: 'group-task', calendarIds: { group: true }, isShared: true, links: null, title: 'Call back' });
    task.alerts = { ...task.alerts, 'follow-up-mail': mailAlert(new Date(2026, 9, 28, 10, 0)) };
    useTaskStore.setState({ tasks: [task] });
    const onClose = vi.fn();
    render(<ReminderDialog taskId="group-task" title="" focus="action" onClose={onClose} />);
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(screen.queryByTestId('follow-up-reminder-mail')).toBeNull();
    fireEvent.change(field('follow-up-reminder-time'), { target: { value: '11:00' } });
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Moved along with the reminder, never added or taken off from here.
    expect(client.updateCalendarTask.mock.calls[0][1]).toMatchObject({ 'alerts/follow-up-mail': mailAlert(new Date(2026, 9, 28, 11, 0)) });
  });
});

describe('FollowUpDialog: settles itself when an answer comes', () => {
  const PROP = 'bulwarkmail.org:settlesOnReply';
  const KEY = '<offer@example.com>';
  const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const watching = (reminder: Date | null) => followUp({
    alerts: null,
    relatedTo: { [KEY]: { '@type': 'Relation', relation: { parent: true }, [PROP]: { reminder: reminder && utc(reminder) } } as never },
  });

  it('writes the reminder into the watch on the Message-ID, no alert, and offers no alarm mail', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={mail} focus="reminder" onClose={onClose} />);
    expect(field('follow-up-settles-on-reply').checked).toBe(false);
    fireEvent.click(field('follow-up-reminder-mail'));
    fireEvent.click(field('follow-up-settles-on-reply'));
    expect(screen.queryByTestId('follow-up-reminder-mail')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.alerts).toBeNull();
    expect((written.relatedTo as unknown as Record<string, Record<string, unknown>>)[KEY][PROP])
      .toEqual({ reminder: utc(new Date(2026, 9, 27, 8, 0)), acknowledged: null, answeredAt: null });
    // The flag mirrors it as any follow-up.
    expect(flagged()).toBe(true);
  });

  it('turned on for a follow-up with its alert and alarm mail: both taken off, the watch written', async () => {
    const task = followUp();
    task.alerts = {
      ...task.alerts,
      'follow-up-mail': { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-28T08:59:59Z' }, action: 'email', acknowledged: null, relatedTo: null },
    };
    useTaskStore.setState({ tasks: [task] });
    render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    fireEvent.click(field('follow-up-settles-on-reply'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    const patch = client.updateCalendarTask.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).toMatchObject({ 'alerts/follow-up': null, 'alerts/follow-up-mail': null });
    // Written without its relation to the Message-ID, which the mail gives.
    expect((patch.relatedTo as Record<string, Record<string, unknown>>)[KEY][PROP])
      .toEqual({ reminder: utc(new Date(2026, 9, 28, 10, 0)), acknowledged: null, answeredAt: null });
  });

  it('reads the box back; the chip and the info bar say it settles itself when an answer comes', () => {
    useTaskStore.setState({ tasks: [watching(new Date(2026, 9, 28, 10, 0))] });
    const dialog = render(<FollowUpDialog email={mail} focus="action" onClose={vi.fn()} />);
    expect(field('follow-up-settles-on-reply').checked).toBe(true);
    expect(field('follow-up-reminder-on').checked).toBe(true);
    expect(field('follow-up-reminder-time').value).toBe('10:00');
    expect(screen.queryByTestId('follow-up-reminder-mail')).toBeNull();
    dialog.unmount();

    render(<><FollowUpChip email={mail} /><FollowUpInfoBar email={mail} /></>);
    expect(screen.getByTestId('follow-up-chip').getAttribute('title')).toContain('reply.settles_short');
    expect(screen.getByTestId('follow-up-chip-settles')).toBeTruthy();
    expect(screen.getByTestId('follow-up-chip-reminder')).toBeTruthy();
    expect(screen.getByTestId('follow-up-bar-settles').textContent).toBe('reply.settles_short');
    expect(screen.getByTestId('follow-up-bar-reminder')).toBeTruthy();
  });

  it('is not offered for a reminder without a mail', () => {
    render(<ReminderDialog taskId={null} title="Check" focus="action" onClose={vi.fn()} />);
    expect(screen.queryByTestId('follow-up-settles-on-reply')).toBeNull();
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
    expect(screen.getByTestId('follow-up-action').textContent).toBe('Follow up');
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

describe('a group mailbox\'s mail ("only me")', () => {
  const groupFolder = { id: 'grp:inbox', originalId: 'inbox', accountId: 'grp', accountName: 'sales@', isShared: true } as never;
  const groupFollowUp = (over: Partial<CalendarTask> = {}) => followUp({
    links: {
      mail: { '@type': 'Link', href: 'https://host/mail/message/M1?mailAccount=grp', cid: null, contentType: null, size: null, rel: 'describedby', display: null, title: 'Offer 4711' },
    },
    ...over,
  });

  const groupMail = { ...mail, mailboxIds: { 'grp:inbox': true } } as Email;

  beforeEach(() => {
    useEmailStore.setState({ emails: [{ ...groupMail, keywords: { ...mail.keywords } }], mailboxes: [groupFolder], selectedMailbox: 'grp:inbox' });
  });

  it('the dialog says only the user sees it, keeps it in the own list with the alarm mail offered, and sets no flag', async () => {
    const onClose = vi.fn();
    render(<FollowUpDialog email={groupMail} focus="reminder" onClose={onClose} />);
    expect(screen.getByTestId('follow-up-kept').textContent).toBe('kept_only_me{"list":"My tasks"}');
    expect(screen.getByTestId('follow-up-dialog').textContent).toContain('sales@ · Lena Brandt · Offer 4711');
    // The user's own list: its alarm mail reaches the user's inbox.
    fireEvent.click(field('follow-up-reminder-mail'));
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-dialog-save')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = client.createCalendarTask.mock.calls[0][0];
    expect(written.calendarIds).toEqual({ tasks: true });
    expect(written.links?.mail.href).toMatch(/\/mail\/message\/M1\?mailAccount=grp$/);
    expect(written.alerts?.['follow-up-mail']?.action).toBe('email');
    expect(client.toggleStar).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails[0].keywords.$flagged).toBeUndefined();
  });

  it('the chip and the info bar say "only me", from the user\'s own task alone', () => {
    useTaskStore.setState({ tasks: [groupFollowUp()] });
    render(<><FollowUpChip email={groupMail} /><FollowUpInfoBar email={groupMail} /></>);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^only_me · Write a quote · due_on/);
    expect(screen.getByTestId('follow-up-chip').getAttribute('title')).toContain('kept_only_me_tasks');
    expect(screen.getByTestId('follow-up-bar-only-me').textContent).toBe('only_me');
  });

  it('shows no follow-up of the own mail with the same id, nor "only me" on the own mail', () => {
    useTaskStore.setState({ tasks: [followUp()] });
    const group = render(<FollowUpChip email={groupMail} />);
    expect(screen.queryByTestId('follow-up-chip')).toBeNull();
    group.unmount();

    // The own mail of the same id, while the group's folder is open.
    render(<FollowUpChip email={mail} />);
    expect(screen.getByTestId('follow-up-chip').textContent).toMatch(/^Write a quote/);
  });

  it('the menu is headed "only me" and a quick click completes the follow-up without touching the mail', async () => {
    useTaskStore.setState({ tasks: [groupFollowUp()] });
    render(<FollowUpFlagButton email={groupMail} />);
    fireEvent.contextMenu(screen.getByTestId('follow-up-flag'));
    expect(screen.getByText('menu_title_only_me')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('follow-up-flag')); });
    await waitFor(() => expect(client.updateCalendarTask).toHaveBeenCalledTimes(1));
    expect(client.updateCalendarTask.mock.calls[0][1]).toMatchObject({ progress: 'completed' });
    expect(client.toggleStar).not.toHaveBeenCalled();
  });
});
