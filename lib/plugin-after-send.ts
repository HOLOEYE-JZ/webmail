// onAfterEmailSend: told once the server accepted a message.
//
// - A plain send is reported straight away, scheduledFor null.
// - A send the user scheduled for later is reported straight away too, with
//   scheduledFor: the server accepted it, even though it goes out later.
// - A send held back for undo ("Sending in 10 s") is reported only when the
//   hold runs out or the user picks "Send now". Undo drops it: that message
//   never leaves.
// A failed send never gets here; the callers only report a resolved send.
//
// The hosts pass the composer's undo hold (the "send delay" setting) as
// `delayedUntil` too, so such a send is reported at once, as one scheduled
// for later; the held branch below serves a hold that comes without it.
//
// The host's own work that belongs to a message that has left (a follow-up on
// its sent copy, the composer's "Follow up") goes apart from that, as `then`
// with `undoHold` saying whether `delayedUntil` is an undo hold: it runs at
// once for a plain send or one the user scheduled, and for an undo hold only
// when the hold runs out or "Send now" goes through, never for a send undone.

import type { SendEmailResult } from './jmap/types';
import { emailHooks } from './plugin-hooks';

export interface SentMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /**
   * Set when the user scheduled the message, and also for an undo-send hold
   * the hosts submit with it (see above).
   */
  delayedUntil?: string;
}

interface AfterSendPayload {
  emailId: string | null;
  submissionId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  scheduledFor: string | null;
}

const held = new Map<string, { timer: ReturnType<typeof setTimeout>; payload: AfterSendPayload }>();

function emit(payload: AfterSendPayload): void {
  if (emailHooks.onAfterEmailSend.size === 0) return;
  void emailHooks.onAfterEmailSend.emit(payload);
}

/** The host's own work after a send, held while the send can still be undone. */
const heldThen = new Map<string, { timer: ReturnType<typeof setTimeout>; then: () => void }>();

function run(then: () => void): void {
  try {
    then();
  } catch (error) {
    console.error('after send:', error);
  }
}

/**
 * Report a send the server accepted (see the rules above). `then`, the host's
 * own work, runs once the message has left for good: at once, or for an undo
 * hold (`options.undoHold`) when it runs out or is sent now, never when undone.
 */
export function announceSent(
  result: SendEmailResult,
  message: SentMessage,
  then?: () => void,
  options: { undoHold?: boolean } = {},
): void {
  if (then) {
    const submissionId = result.emailSubmissionId;
    if (options.undoHold && result.scheduled && submissionId && result.sendAt) {
      const wait = Math.max(0, Date.parse(result.sendAt) - Date.now());
      const timer = setTimeout(() => {
        heldThen.delete(submissionId);
        run(then);
      }, Number.isFinite(wait) ? wait : 0);
      heldThen.set(submissionId, { timer, then });
    } else {
      run(then);
    }
  }
  reportSent(result, message);
}

function reportSent(result: SendEmailResult, message: SentMessage): void {
  const payload: AfterSendPayload = {
    emailId: result.emailId ?? null,
    submissionId: result.emailSubmissionId ?? null,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    subject: message.subject,
    scheduledFor: null,
  };
  if (message.delayedUntil) {
    emit({ ...payload, scheduledFor: result.sendAt ?? message.delayedUntil });
    return;
  }
  const submissionId = result.emailSubmissionId;
  if (result.scheduled && submissionId && result.sendAt) {
    const wait = Math.max(0, Date.parse(result.sendAt) - Date.now());
    const timer = setTimeout(() => {
      held.delete(submissionId);
      emit(payload);
    }, Number.isFinite(wait) ? wait : 0);
    held.set(submissionId, { timer, payload });
    return;
  }
  emit(payload);
}

/** The user undid a held send: it is not reported, and the host's work after it never runs. */
export function cancelAnnouncedSend(submissionId: string): void {
  dropHeldThen(submissionId);
  const entry = held.get(submissionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  held.delete(submissionId);
}

/** The user chose "Send now" for a held send: report it now. */
export function releaseAnnouncedSend(submissionId: string): void {
  const then = heldThen.get(submissionId);
  if (then) {
    clearTimeout(then.timer);
    heldThen.delete(submissionId);
    run(then.then);
  }
  const entry = held.get(submissionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  held.delete(submissionId);
  emit(entry.payload);
}

/**
 * The host's work held for an undo hold that will not leave after all ("Send
 * now" failed and the message went back to Drafts): it never runs. Plugins'
 * reports are left as they are.
 */
export function dropHeldThen(submissionId: string): void {
  const entry = heldThen.get(submissionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  heldThen.delete(submissionId);
}

/**
 * The held send was put back under a new submission id ("Send now" failed,
 * the original restored): the host's held work follows it, so Undo and Send
 * now still find it.
 */
export function rekeyHeldThen(submissionId: string, restoredSubmissionId: string, sendAt?: string): void {
  const entry = heldThen.get(submissionId);
  if (!entry) return;
  heldThen.delete(submissionId);
  let timer = entry.timer;
  if (sendAt) {
    clearTimeout(timer);
    const wait = Math.max(0, Date.parse(sendAt) - Date.now());
    timer = setTimeout(() => {
      heldThen.delete(restoredSubmissionId);
      run(entry.then);
    }, Number.isFinite(wait) ? wait : 0);
  }
  heldThen.set(restoredSubmissionId, { timer, then: entry.then });
}

/** Drop every held send (tests). */
export function resetAnnouncedSends(): void {
  for (const { timer } of held.values()) clearTimeout(timer);
  held.clear();
  for (const { timer } of heldThen.values()) clearTimeout(timer);
  heldThen.clear();
}
