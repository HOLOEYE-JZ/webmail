import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import type { TransportBooking } from '@/lib/structured-mail';
import { MAIL_DATE, boardingPass, zipPass } from '@/lib/structured-mail/__tests__/pkpass-fixtures';
import { usePolicyStore } from '@/stores/policy-store';
import { useStructuredMail } from '../use-structured-mail';

const PASS = 'mx.example.org; dkim=pass header.d=swiss.example; spf=pass smtp.mailfrom=bounce@swiss.example; dmarc=pass header.from=swiss.example';

function mail(id: string, ar: string | null): Email {
  return {
    id, threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: MAIL_DATE.toISOString(), subject: 'Your boarding pass',
    from: [{ email: 'boarding@swiss.example' }],
    ...(ar ? { authenticationResults: parseAuthenticationResults([ar]), authenticationResultsOnReceipt: true } : {}),
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart],
    bodyValues: { '1': { value: '<html><body><p>Your boarding pass is attached.</p></body></html>', isTruncated: false, isEncodingProblem: false } },
    attachments: [{ partId: '2', blobId: 'blob-pass', size: 3000, name: 'BoardingPass.pkpass', type: 'application/vnd.apple.pkpass' }],
  } as unknown as Email;
}

const initial = usePolicyStore.getState();

afterEach(() => {
  usePolicyStore.setState(initial, true);
});

describe('useStructuredMail with a Wallet pass attached', () => {
  it('shows the resolved flight card of a trusted mail, and downloads nothing for an untrusted one', async () => {
    usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, structuredMailEnabled: true } } }));
    const bytes = await zipPass(boardingPass());
    const fetchBlobArrayBuffer = vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const client = { fetchBlobArrayBuffer } as unknown as IJMAPClient;

    const untrusted = renderHook(() => useStructuredMail(mail('u', null), { client, accountId: 'acc-1' }));
    const { result } = renderHook(() => useStructuredMail(mail('t', PASS), { client, accountId: 'acc-1' }));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const [card] = result.current as TransportBooking[];
    expect(card).toMatchObject({ kind: 'flight', reference: 'PK7Q2Z', source: 'pkpass' });
    expect(card.legs[0].departure.at).toMatchObject({ time: '07:40:00', zone: 'Europe/Zurich' });
    expect(card.legs[0].arrival?.at).toMatchObject({ time: '09:05:00', zone: 'Europe/Berlin' });
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-pass', 'BoardingPass.pkpass', 'application/vnd.apple.pkpass', 'acc-1', 5 * 1024 * 1024 + 1);
    expect(untrusted.result.current).toEqual([]);
  });
});
