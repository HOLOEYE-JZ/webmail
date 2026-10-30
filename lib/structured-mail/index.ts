/**
 * Structured mail: read the schema.org markup that airlines, hotels, shops
 * and carriers put into their HTML mail, and turn it into cards. Plain
 * TypeScript; the only DOM dependency is the HTML parser, which a caller
 * without DOMParser (the native app) passes in.
 *
 *   const cards = readStructuredMail(html, { mailDate });
 *   const shown = needsAirportZones(cards)
 *     ? resolveCards(cards, await loadAirportZones())
 *     : resolveCards(cards);
 */
import { extractStructuredData } from './extract';
import { mergeCandidates } from './merge';
import { normalizeItems } from './normalize';
import type { StructuredCard } from './types';
import { validateCard } from './validate';

export interface ReadOptions {
  /** When the mail was sent (else received): bookings far from it are doubtful. */
  mailDate: Date;
  parseHtml?: (html: string) => Document;
}

/**
 * Cards from one HTML body: validated and merged to one card per booking,
 * with zones not yet resolved (resolveCards).
 */
export function readStructuredMail(html: string, options: ReadOptions): StructuredCard[] {
  const cards = normalizeItems(extractStructuredData(html, options.parseHtml));
  return mergeCandidates(cards.map((card) => validateCard(card, options.mailDate)));
}

export { extractStructuredData, mayContainStructuredData } from './extract';
export { normalizeItems } from './normalize';
export { validateCard } from './validate';
export { mergeCandidates } from './merge';
export { needsAirportZones, resolveCards } from './resolve';
export { loadAirportZones } from './time-zones';
export * from './types';
