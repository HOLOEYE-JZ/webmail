import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { FollowUpControls } from '@/hooks/use-follow-ups';
import { DEFAULT_WORKING_TIME } from '@/lib/follow-up-schedule';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The reader's follow-up: a button in the toolbar where Archive stands (beside
// it while Archive is offered), an entry in the More menu once it overflows,
// and nothing beside the subject.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

const controls: FollowUpControls = {
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
};
vi.mock('@/hooks/use-follow-ups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-follow-ups')>()),
  useFollowUp: () => controls,
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useFollowUpPopover } = await import('@/stores/follow-up-popover-store');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const mail = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'Hello',
  hasAttachment: false,
  size: 100,
  textBody: [],
  htmlBody: [],
  attachments: [],
  bodyValues: {},
} as unknown as Email;

function setArchiveGate(on: boolean) {
  usePolicyStore.setState((state) => ({
    policy: { ...state.policy, features: { ...state.policy.features, archiveActionEnabled: on } },
  }));
}

const initialLayout = useSettingsStore.getState().interfaceLayout;

afterEach(() => {
  setArchiveGate(true);
  useSettingsStore.setState({ interfaceLayout: initialLayout });
  act(() => useFollowUpPopover.getState().close());
});

function viewer() {
  render(
    <EmailViewer
      email={mail}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onArchive={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  return screen.getByTestId('follow-up-toolbar-button');
}

const toolbar = () => document.querySelector<HTMLElement>('[data-viewer-top-toolbar]')!;

describe('the reader\'s follow-up button', () => {
  it('stands in the toolbar right after Archive, nothing beside the subject', () => {
    const button = viewer();
    expect(toolbar().contains(button)).toBe(true);
    expect(screen.getByTitle('tooltips.archive').nextElementSibling).toBe(button);
    expect(screen.getAllByTestId('follow-up-toolbar-button')).toHaveLength(1);
    expect(screen.queryByTestId('follow-up-reader-button')).toBeNull();
  });

  it('takes Archive\'s place with the Archive action off', () => {
    setArchiveGate(false);
    const button = viewer();
    expect(screen.queryByTitle('tooltips.archive')).toBeNull();
    expect(button.parentElement?.firstElementChild).toBe(button);
  });

  it('overflows as the other actions do, its priority after Archive\'s', () => {
    const button = viewer();
    expect(button.hasAttribute('data-overflow-item')).toBe(true);
    const archive = Number(screen.getByTitle('tooltips.archive').dataset.overflowPriority);
    const priorities = Array.from(toolbar().querySelectorAll<HTMLElement>('[data-overflow-item]'))
      .map((item) => Number(item.dataset.overflowPriority));
    // Right after Archive's: it goes into the menu just before Archive does.
    const own = Number(button.dataset.overflowPriority);
    expect(own).toBeGreaterThan(archive);
    expect(priorities.filter((p) => p > archive && p < own)).toEqual([]);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('opens the popover under itself', () => {
    const button = viewer();
    fireEvent.click(button);
    expect(useFollowUpPopover.getState().email).toBe(mail);
    expect(useFollowUpPopover.getState().trigger).toBe(button);
  });

  it('is in the More menu too, opening the popover under the More button', () => {
    viewer();
    const more = screen.getByLabelText('more_actions');
    fireEvent.click(more);
    const entry = within(screen.getByRole('menu')).getByTestId('follow-up-menu-entry');
    fireEvent.click(entry);
    expect(screen.queryByTestId('follow-up-menu-entry')).toBeNull();
    expect(useFollowUpPopover.getState().email).toBe(mail);
    expect(useFollowUpPopover.getState().trigger).toBe(more);
  });

  it('stands where Archive stands in Mountain View', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
    const button = viewer();
    expect(toolbar().contains(button)).toBe(true);
    expect(button.className).toMatch(/\border-1\b/);
  });
});
