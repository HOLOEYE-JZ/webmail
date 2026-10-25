import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';

// A Pro tab's mail fetched in a named account carries that account, so what
// reads its account later (the follow-up and its flag) never takes it for the
// login's own mail of the same id.

const shown: { email: Email | null } = { email: null };
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ email }: { email: Email | null }) => {
    shown.email = email;
    return null;
  },
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));

const { ProEmailView } = await import('../pro-email-tab-body');

const mail = { id: 'M1', threadId: 'T1', mailboxIds: { 'grp:inbox': true }, keywords: {}, size: 1, receivedAt: '2026-10-26T07:00:00Z', subject: 'Offer' } as unknown as Email;

let client: { getAccountId: () => string; getUsername: () => string; getEmail: ReturnType<typeof vi.fn> };

beforeEach(() => {
  shown.email = null;
  client = { getAccountId: () => 'acc', getUsername: () => 'me@example.com', getEmail: vi.fn(async () => ({ ...mail })) } as typeof client;
  useAuthStore.setState({ client: client as unknown as IJMAPClient, activeAccountId: 'login' });
});

describe('ProEmailView', () => {
  it('stamps a mail fetched in a named account with that account and the login', async () => {
    render(<ProEmailView emailId="M1" accountId="grp" onClose={vi.fn()} />);
    await waitFor(() => expect(shown.email).not.toBeNull());
    expect(client.getEmail).toHaveBeenCalledWith('M1', 'grp');
    expect(shown.email).toMatchObject({ id: 'M1', sourceAccountId: 'grp', sourceClientAccountId: 'login' });
  });
});
