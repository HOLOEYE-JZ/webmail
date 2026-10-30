"use client";

import { useEffect, useMemo, useState } from 'react';
import type { Email } from '@/lib/jmap/types';
import {
  loadAirportZones,
  mergeCandidates,
  needsAirportZones,
  readStructuredMail,
  resolveCards,
  type StructuredCard,
} from '@/lib/structured-mail';
import { getStructuredMailTrust, structuredHtmlPart } from '@/lib/structured-mail/trust';
import { useStructuredMailEnabled } from '@/lib/structured-mail-gate';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailBlobContext, type EmailBlobContext } from '@/stores/email-store';
import { CARD_SOURCES } from './sources';

function mailDateOf(email: Pick<Email, 'sentAt' | 'receivedAt'>): Date {
  return new Date(email.sentAt ?? email.receivedAt);
}

async function resolveAll(cards: StructuredCard[]): Promise<StructuredCard[]> {
  if (!needsAirportZones(cards)) return resolveCards(cards);
  try {
    return resolveCards(cards, await loadAirportZones());
  } catch {
    // Without the table no flight card can be checked, so none is shown.
    return resolveCards(cards);
  }
}

/**
 * The booking, parcel and order cards of an open message: empty unless the
 * admin gate is on and the message passes getStructuredMailTrust. Cards that
 * need nothing asynchronous show at once; flights wait for the airport time
 * zone table, and cards from attachment sources (CARD_SOURCES) are merged in
 * once read, so a card never shows with unchecked times.
 */
export function useStructuredMail(email: Email | null | undefined, blobSource?: EmailBlobContext): StructuredCard[] {
  const enabled = useStructuredMailEnabled();
  const client = useAuthStore((state) => state.client);
  const trusted = useMemo(() => !!email && enabled && getStructuredMailTrust(email).trusted, [email, enabled]);
  const html = email ? structuredHtmlPart(email)?.value : undefined;

  const markup = useMemo(() => {
    if (!trusted || !email || !html) return [];
    return readStructuredMail(html, { mailDate: mailDateOf(email) });
    // email.id and the HTML identify the input; the rest of the object may change identity freely.
  }, [trusted, email?.id, html]); // eslint-disable-line react-hooks/exhaustive-deps

  const immediate = useMemo(() => resolveCards(markup.filter((card) => card.kind !== 'flight')), [markup]);
  const [settled, setSettled] = useState<{ key: string; cards: StructuredCard[] } | null>(null);
  const settleKey = `${email?.id ?? ''}|${trusted}|${markup.length}`;

  useEffect(() => {
    if (!trusted || !email) return;
    const needsWork = needsAirportZones(markup) || CARD_SOURCES.length > 0;
    if (!needsWork) return;
    const controller = new AbortController();
    const blob = blobSource ?? resolveEmailBlobContext(email, client);
    (async () => {
      const fromSources = (await Promise.all(CARD_SOURCES.map((source) =>
        source({ email, mailDate: mailDateOf(email), blob, signal: controller.signal }).catch(() => [] as StructuredCard[]),
      ))).flat();
      const combined = fromSources.length > 0
        ? mergeCandidates([...markup, ...fromSources].map((card) => ({ card, problems: [] })))
        : markup;
      const cards = await resolveAll(combined);
      if (!controller.signal.aborted) setSettled({ key: settleKey, cards });
    })();
    return () => controller.abort();
    // markup and settleKey change together with the message.
  }, [trusted, markup, settleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!trusted) return [];
  return settled?.key === settleKey ? settled.cards : immediate;
}
