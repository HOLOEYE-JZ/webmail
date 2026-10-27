import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useCalendarStore } from '@/stores/calendar-store';
import type { SendFollowUp } from '@/lib/send-follow-up';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';

// ─── Heavy component mocks (mirrors composer-from-override-envelope.test.tsx) ─

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: 'login' as string | null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [
      { id: 'id-me', email: 'me@example.com', name: 'Me' },
      { id: 'id-sales', email: 'sales@example.com', name: 'Sales' },
    ] as Array<Record<string, unknown>>,
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    mailboxes: [],
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    // The default position: replies/forwards get the signature appended at
    // send time rather than embedded above the quote.
    signaturePosition: 'below_quote',
    signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false,
    // With follow-ups on, the composer offers "Follow up".
    enableCalendarTasks: true, enableFollowUps: true,
    calendarWorkingDays: [1, 2, 3, 4, 5],
    firstDayOfWeek: 1,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  // The calendar store, which the follow-up row brings along, registers with it.
  return { useSettingsStore: hook, registerCalendarSubscriptionSyncBridge: () => {} };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock('@/stores/toast-store', () => ({
  toast: { info: (...args: unknown[]) => toastInfo(...args), error: () => {}, success: () => {} },
}));
// What onComposeSend answers: 'handled' when a plugin (S/MIME, PGP) sends the mail itself.
const pluginOutcome = vi.hoisted(() => ({ current: 'default' }));

vi.mock('@/lib/plugin-hooks', () => ({
  identityHooks: {
    onSignatureRender: { size: 0, transform: async (value: unknown) => value },
    onIdentitySelect: { size: 0, emit: async () => {} },
  },
  templateHooks: {
    onTemplateRender: { size: 0, transform: async (value: unknown) => value },
    onTemplateApply: { size: 0, emit: async () => {} },
  },
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true, interceptOutcome: async () => 'allowed' },
    onComposeSend: { takeOver: async () => pluginOutcome.current },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

// "Follow up" under the message; the choice goes to the
// host with the send, which sets it on the sent copy once the mail has left.

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Quotation',
  body: '<p>Hi</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

type Sent = { followUp?: SendFollowUp | null; undoHold?: boolean; delayedUntil?: string };

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getAllByTestId('composer-send')[0]);
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as Sent;
}

describe('composer "Follow up"', () => {
  beforeEach(() => {
    useCalendarStore.setState({ supportsCalendar: true, calendars: [] });
  });
  afterEach(() => {
    vi.clearAllMocks();
    pluginOutcome.current = 'default';
    useSettingsStore.setState({ sendDelaySeconds: 0 });
    useAuthStore.setState({ client: null });
  });

  it('marks the "send delay" setting\'s hold as one, so the follow-up waits for it', async () => {
    useSettingsStore.setState({ sendDelaySeconds: 10 });
    useAuthStore.setState({ client: { hasDelayedSend: () => true, getAccountId: () => 'acc' } as never });
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    fireEvent.change(await screen.findByTestId('composer-follow-up-choice'), { target: { value: 'week' } });
    const sent = await send(onSend);
    expect(sent.delayedUntil).toBeTruthy();
    expect(sent.undoHold).toBe(true);
  });

  it('says so when a plugin sends the mail itself, its follow-up then not set', async () => {
    pluginOutcome.current = 'handled';
    render(<EmailComposer initialData={DRAFT} onSend={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('composer-follow-up-choice'), { target: { value: 'week' } });
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('send.plugin_sent'));
  });

  it('sends the choice made with the mail', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    fireEvent.change(await screen.findByTestId('composer-follow-up-choice'), { target: { value: 'three-workdays' } });
    const sent = await send(onSend);
    expect(sent.followUp).toEqual({ choice: 'three-workdays' });
    expect(sent.undoHold).toBe(false);
  });

  it('sends none without one', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    await screen.findByTestId('composer-follow-up-choice');
    expect((await send(onSend)).followUp).toBeNull();
  });

  it('keeps the choice of a draft reopened and hands it on with its state', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, followUp: { choice: 'week' } }} onSend={onSend} />);
    expect(((await screen.findByTestId('composer-follow-up-choice')) as HTMLSelectElement).value).toBe('week');
    expect((await send(onSend)).followUp).toEqual({ choice: 'week' });
  });

  it('offers nothing while follow-ups are off', async () => {
    useCalendarStore.setState({ supportsCalendar: false });
    render(<EmailComposer initialData={DRAFT} />);
    await waitFor(() => expect(screen.getAllByTestId('composer-send').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('composer-follow-up')).not.toBeInTheDocument();
  });
});
