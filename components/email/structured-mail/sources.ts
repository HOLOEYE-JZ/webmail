import type { Email } from '@/lib/jmap/types';
import type { StructuredCard } from '@/lib/structured-mail';
import type { EmailBlobContext } from '@/stores/email-store';

/**
 * Card sources beyond the HTML markup, read asynchronously once a trusted
 * message is open (Apple Wallet passes among its attachments). Each gets the
 * message and returns cards that are validated but not zone-resolved; the
 * hook merges them with the markup cards and resolves zones for all. A
 * source must read only `email.attachments` (never parts unwrapped from an
 * attached message) and must not throw.
 */
export interface CardSourceContext {
  email: Email;
  mailDate: Date;
  /** Client and JMAP account the message's blobs live in. */
  blob: EmailBlobContext;
  signal: AbortSignal;
}

export type CardSource = (context: CardSourceContext) => Promise<StructuredCard[]>;

/** Registered sources; each one appends itself here. */
export const CARD_SOURCES: CardSource[] = [];
