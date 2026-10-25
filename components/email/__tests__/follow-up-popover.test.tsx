import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpControls } from '@/hooks/use-follow-ups';
import { DEFAULT_WORKING_TIME } from '@/lib/follow-up-schedule';
import type { CalendarTask, Email, Mailbox } from '@/lib/jmap/types';
import { useFollowUpPopover } from '@/stores/follow-up-popover-store';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...options, hour12: false }).format(d),
  }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/email/rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));

let controls: FollowUpControls;
vi.mock('@/hooks/use-follow-ups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-follow-ups')>()),
  useFollowUp: (email: Email | null) => (email ? controls : { ...controls, available: false }),
}));

const { FollowUpPopoverHost } = await import('../follow-up-popover');
const { FollowUpFlagButton, FollowUpMenuEntry, FollowUpToolbarButton } = await import('../follow-up');
const { EmailContextMenu } = await import('../email-context-menu');

// Monday 26.10.2026, 09:00 on the wall clock; working hours 08:00–17:00.
const NOW = new Date(2026, 9, 26, 9, 0);

const mail = { id: 'M1', threadId: 'T1', mailboxIds: { inbox: true }, keywords: { $seen: true }, subject: 'Offer 4711' } as unknown as Email;
const task = { id: 'task-1', progress: 'needs-action', due: '2026-10-29T00:00:00' } as CalendarTask;

function makeControls(over: Partial<FollowUpControls> = {}): FollowUpControls {
  return {
    available: true,
    onlyMe: false,
    mailboxName: null,
    group: null,
    task: null,
    workingTime: DEFAULT_WORKING_TIME,
    openGroupDialog: vi.fn(),
    apply: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    openDialog: vi.fn(),
    markDone: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    quickClick: vi.fn(async () => {}),
    ...over,
  };
}

const item = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const popover = () => screen.queryByTestId('follow-up-popover');
/** Lets the popover's listeners for Escape and a press outside start. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function renderFlag() {
  render(<><FollowUpFlagButton email={mail} /><FollowUpPopoverHost /></>);
  fireEvent.contextMenu(screen.getByTestId('follow-up-flag'), { clientX: 120, clientY: 80 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  controls = makeControls();
  useSettingsStore.setState({ timeZone: 'auto', timeFormat: '24h' } as never);
});

afterEach(() => {
  act(() => useFollowUpPopover.getState().close());
  vi.useRealTimers();
});

describe('the popover "Follow up"', () => {
  it('opens at the flag\'s right click, as a menu with Outlook\'s entries and no "Add reminder…"', () => {
    renderFlag();
    expect(useFollowUpPopover.getState().position).toEqual({ x: 120, y: 80 });
    expect(screen.getByRole('menu').contains(popover())).toBe(true);
    expect(screen.getAllByRole('menuitem').map((e) => e.getAttribute('data-testid'))).toEqual([
      'follow-up-today',
      'follow-up-tomorrow',
      'follow-up-this-week',
      'follow-up-next-week',
      'follow-up-no-date',
      'follow-up-custom',
      'follow-up-colleague',
      'follow-up-done',
      'follow-up-remove',
    ]);
    expect(screen.getByText('menu_title')).toBeTruthy();
  });

  it('shows each quick choice\'s due day and reminder from the working hours', () => {
    renderFlag();
    expect(item('follow-up-today').textContent).toBe('choices.todayMon 26/10 · 16:00');
    expect(item('follow-up-tomorrow').textContent).toBe('choices.tomorrowTue 27/10 · 08:00');
    expect(item('follow-up-this-week').textContent).toBe('choices.this-weekFri 30/10 · Wed 08:00');
    expect(item('follow-up-next-week').textContent).toBe('choices.next-weekFri 06/11 · Mon 08:00');
    expect(item('follow-up-no-date').textContent).toBe('choices.no-date');
  });

  it('sets a quick choice and closes', () => {
    renderFlag();
    fireEvent.click(item('follow-up-this-week'));
    expect(controls.apply).toHaveBeenCalledWith('this-week');
    expect(popover()).toBeNull();
  });

  it('opens the dialog from "Custom…"', () => {
    renderFlag();
    fireEvent.click(item('follow-up-custom'));
    expect(controls.openDialog).toHaveBeenCalledWith('action');
    expect(popover()).toBeNull();
  });

  it('greys done and remove without a follow-up, and acts on one that is set', () => {
    renderFlag();
    expect(item('follow-up-done').disabled).toBe(true);
    expect(item('follow-up-remove').disabled).toBe(true);
    act(() => useFollowUpPopover.getState().close());

    controls = makeControls({ task });
    act(() => useFollowUpPopover.getState().openAt(mail, { x: 0, y: 0 }));
    fireEvent.click(item('follow-up-done'));
    expect(controls.markDone).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();

    act(() => useFollowUpPopover.getState().openAt(mail, { x: 0, y: 0 }));
    fireEvent.click(item('follow-up-remove'));
    expect(controls.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps remove, not done, for a completed follow-up', () => {
    controls = makeControls({ task: { ...task, progress: 'completed' } });
    renderFlag();
    expect(item('follow-up-done').disabled).toBe(true);
    expect(item('follow-up-remove').disabled).toBe(false);
  });

  it('offers "For a colleague…" only in a group mailbox, else greyed with "Group mailbox"', () => {
    renderFlag();
    expect(item('follow-up-colleague').disabled).toBe(true);
    expect(item('follow-up-colleague').textContent).toBe('group.menu_colleague_shortgroup.group_mailbox');
    expect(item('follow-up-colleague').title).toBe('group.only_in_group');
    act(() => useFollowUpPopover.getState().close());

    controls = makeControls({ onlyMe: true, group: { accountId: 'grp', name: 'sales@' } as FollowUpControls['group'] });
    act(() => useFollowUpPopover.getState().openAt(mail, { x: 0, y: 0 }));
    expect(screen.getByText('menu_title_only_me')).toBeTruthy();
    fireEvent.click(item('follow-up-colleague'));
    expect(controls.openGroupDialog).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on a press outside', async () => {
    renderFlag();
    await settle();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(popover()).toBeNull();

    act(() => useFollowUpPopover.getState().openAt(mail, { x: 0, y: 0 }));
    await settle();
    fireEvent.mouseDown(document.body);
    expect(popover()).toBeNull();
  });

  it('moves between its entries with the arrow keys', () => {
    renderFlag();
    item('follow-up-today').focus();
    fireEvent.keyDown(popover()!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('follow-up-tomorrow'));
    // The greyed ones after "Custom…" are skipped.
    fireEvent.keyDown(popover()!, { key: 'End' });
    expect(document.activeElement).toBe(item('follow-up-custom'));
  });

  it('keeps the flag\'s quick click', () => {
    render(<><FollowUpFlagButton email={mail} /><FollowUpPopoverHost /></>);
    fireEvent.click(screen.getByTestId('follow-up-flag'));
    expect(controls.quickClick).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
  });

  it('opens under the toolbar\'s button', () => {
    render(<><FollowUpToolbarButton email={mail} showLabel /><FollowUpPopoverHost /></>);
    const button = screen.getByTestId('follow-up-toolbar-button');
    expect(button.textContent).toBe('reader_button');
    fireEvent.click(button);
    expect(popover()).not.toBeNull();
    expect(useFollowUpPopover.getState().trigger).toBe(button);
  });

  it('colours the toolbar\'s button by the follow-up, plain without one', () => {
    const { rerender } = render(<FollowUpToolbarButton email={mail} showLabel={false} />);
    const button = screen.getByTestId('follow-up-toolbar-button');
    expect(button.dataset.followUp).toBeUndefined();
    expect(button.className).not.toMatch(/text-(orange|destructive|emerald)/);
    expect(button.textContent).toBe('');

    controls = makeControls({ task });
    rerender(<FollowUpToolbarButton email={mail} showLabel={false} />);
    expect(button.dataset.followUp).toBe('open');
    expect(button.className).toMatch(/text-orange-600/);

    controls = makeControls({ task: { ...task, due: '2026-10-20T00:00:00' } });
    rerender(<FollowUpToolbarButton email={mail} showLabel={false} />);
    expect(button.dataset.followUp).toBe('overdue');
    expect(button.className).toMatch(/text-destructive/);
  });

  it('has no toolbar button or menu entry where follow-ups are not available', () => {
    controls = makeControls({ available: false });
    render(<><FollowUpToolbarButton email={mail} showLabel /><FollowUpMenuEntry email={mail} anchor={() => null} onOpen={vi.fn()} /></>);
    expect(screen.queryByTestId('follow-up-toolbar-button')).toBeNull();
    expect(screen.queryByTestId('follow-up-menu-entry')).toBeNull();
  });

  it('opens from a menu entry under the anchor, after the menu closed', () => {
    const onOpen = vi.fn();
    render(
      <>
        <button type="button" data-testid="more">more</button>
        <FollowUpMenuEntry email={mail} anchor={() => screen.getByTestId('more')} onOpen={onOpen} />
        <FollowUpPopoverHost />
      </>,
    );
    fireEvent.click(screen.getByTestId('follow-up-menu-entry'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(popover()).not.toBeNull();
    expect(useFollowUpPopover.getState().trigger).toBe(screen.getByTestId('more'));
  });
});

describe('the mail\'s context menu', () => {
  const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', myRights: { mayAddItems: true } }] as unknown as Mailbox[];

  it('has one entry "Follow up…", which opens the popover where the menu was', () => {
    const onClose = vi.fn();
    render(
      <>
        <EmailContextMenu email={mail} position={{ x: 40, y: 60 }} isOpen onClose={onClose} menuRef={{ current: null }} mailboxes={mailboxes} selectedMailbox="inbox" />
        <FollowUpPopoverHost />
      </>,
    );
    const entry = screen.getByTestId('ctx-follow-up');
    expect(entry.getAttribute('aria-haspopup')).toBeNull();
    expect(entry.textContent).toBe('menu_entry');
    expect(screen.queryByTestId('follow-up-today')).toBeNull();
    fireEvent.click(entry);
    expect(onClose).toHaveBeenCalled();
    expect(useFollowUpPopover.getState()).toMatchObject({ email: mail, position: { x: 40, y: 60 } });
    expect(screen.getByTestId('follow-up-today')).toBeTruthy();
  });
});
