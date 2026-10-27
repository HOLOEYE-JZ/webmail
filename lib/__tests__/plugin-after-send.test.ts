// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emailHooks, clearAllHooks } from '../plugin-hooks';
import { announceSent, cancelAnnouncedSend, dropHeldThen, rekeyHeldThen, releaseAnnouncedSend, resetAnnouncedSends } from '../plugin-after-send';

const message = { to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi' };

beforeEach(() => {
  vi.useFakeTimers();
  clearAllHooks();
  resetAnnouncedSends();
});
afterEach(() => vi.useRealTimers());

describe('announceSent for a send held back for undo', () => {
  const held = () => ({ scheduled: true, emailId: 'e1', emailSubmissionId: 's1', sendAt: new Date(Date.now() + 10_000).toISOString() });

  it('reports when the hold runs out', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    vi.advanceTimersByTime(9_000);
    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveBeenCalledWith({ emailId: 'e1', submissionId: 's1', ...message, scheduledFor: null });
  });

  it('reports at once on "Send now"', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    releaseAnnouncedSend('s1');
    expect(sent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('never reports an undone send', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    cancelAnnouncedSend('s1');
    vi.advanceTimersByTime(20_000);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('announceSent\'s then (the host\'s own work: a follow-up on the sent copy)', () => {
  const held = () => ({ scheduled: true, emailId: 'e1', emailSubmissionId: 's1', sendAt: new Date(Date.now() + 10_000).toISOString() });
  // As the hosts pass an undo hold: with delayedUntil.
  const holdMessage = () => ({ ...message, delayedUntil: new Date(Date.now() + 10_000).toISOString() });

  it('runs at once for a plain send, with no plugin listening', () => {
    const then = vi.fn();
    announceSent({ scheduled: false, emailId: 'e1', emailSubmissionId: 's1' }, message, then);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('waits out an undo hold passed as delayedUntil, while plugins still hear at once as before', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    const then = vi.fn();
    announceSent(held(), holdMessage(), then, { undoHold: true });
    expect(sent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_000);
    expect(then).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('runs at "Send now" and never for a hold undone', () => {
    const now = vi.fn();
    announceSent(held(), holdMessage(), now, { undoHold: true });
    releaseAnnouncedSend('s1');
    expect(now).toHaveBeenCalledTimes(1);

    const undone = vi.fn();
    announceSent(held(), holdMessage(), undone, { undoHold: true });
    cancelAnnouncedSend('s1');
    vi.advanceTimersByTime(20_000);
    expect(undone).not.toHaveBeenCalled();
  });

  it('follows a hold put back under a new id, and is dropped when it went back to Drafts', () => {
    const then = vi.fn();
    announceSent(held(), holdMessage(), then, { undoHold: true });
    rekeyHeldThen('s1', 's2', new Date(Date.now() + 5_000).toISOString());
    cancelAnnouncedSend('s1');
    releaseAnnouncedSend('s2');
    expect(then).toHaveBeenCalledTimes(1);

    const dropped = vi.fn();
    announceSent(held(), holdMessage(), dropped, { undoHold: true });
    dropHeldThen('s1');
    vi.advanceTimersByTime(20_000);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('runs at once for a send the user scheduled for later, and a failure in it stays its own', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    const then = vi.fn(() => { throw new Error('boom'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    announceSent({ ...held(), sendAt: '2026-11-02T08:00:00Z' }, { ...message, delayedUntil: '2026-11-02T08:00:00Z' }, then);
    expect(then).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
