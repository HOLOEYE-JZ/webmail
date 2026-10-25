import { describe, it, expect } from 'vitest';
import {
  addFollowUpSender,
  buildFollowUpTask,
  followUpMailSummary,
  followUpMessageId,
  followUpMailRef,
  isDestructiveSyncAction,
  parseFollowUpMirror,
  planFollowUpSync,
  relinkFollowUpTask,
  type FollowUpMirror,
  type FollowUpSyncInput,
  type FollowUpSyncTask,
} from '../follow-ups';
import type { CalendarTask } from '@/lib/jmap/types';

// The task is the original, the mail's $flagged its mirror: whichever side
// changed, the other follows (Outlook's flag and its task).

const task = (over: Partial<FollowUpSyncTask> = {}): FollowUpSyncTask => ({
  id: 'T1', emailId: 'M1', calendarId: 'tasks', open: true, updated: '2026-10-26T08:00:00Z', fresh: true, ...over,
});

const seen: FollowUpMirror = { T1: { emailId: 'M1', calendarId: 'tasks', updated: '2026-10-26T08:00:00Z' } };

function plan(input: Partial<FollowUpSyncInput> & { flagged?: boolean | null }) {
  const tasks = input.tasks ?? [task()];
  return planFollowUpSync({
    tasks,
    present: input.present ?? new Set(tasks.map((t) => t.id)),
    listed: input.listed ?? (() => true),
    flags: input.flags ?? new Map([['M1', input.flagged === undefined ? true : input.flagged]]),
    mirror: input.mirror ?? {},
    unstarredHere: input.unstarredHere,
  });
}

describe('planFollowUpSync', () => {
  it('remembers an open follow-up whose mail is flagged, and does nothing', () => {
    const { actions, mirror } = plan({ flagged: true });
    expect(actions).toEqual([]);
    expect(mirror).toEqual(seen);
  });

  it('remembers only what the server gave: a task changed here waits for the next load', () => {
    expect(plan({ tasks: [task({ fresh: false })], flagged: true }).mirror).toEqual({});
  });

  it('clears the flag of a task completed elsewhere', () => {
    const { actions, mirror } = plan({ tasks: [task({ open: false, updated: 'later' })], flagged: true, mirror: seen });
    expect(actions).toEqual([{ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: false }]);
    expect(mirror).toEqual({});
  });

  it('clears the flag of a task deleted elsewhere', () => {
    const { actions, mirror } = plan({ tasks: [], present: new Set(), flagged: true, mirror: seen });
    expect(actions).toEqual([{ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: false, taskGone: true }]);
    expect(actions.every(isDestructiveSyncAction)).toBe(true);
    expect(mirror).toEqual({});
  });

  it('judges no task deleted while the list does not hold its calendar', () => {
    const { actions, mirror } = plan({ tasks: [], present: new Set(), flagged: true, mirror: seen, listed: () => false });
    expect(actions).toEqual([]);
    expect(mirror).toEqual(seen);
  });

  it('sets the flag again when the task is reopened', () => {
    const { actions } = plan({ tasks: [task({ open: true, updated: 'reopened' })], flagged: false });
    expect(actions).toEqual([{ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: true }]);
  });

  it('counts only what takes something away as destructive', () => {
    expect(isDestructiveSyncAction({ kind: 'delete-task', taskId: 'T1', emailId: 'M1' })).toBe(true);
    expect(isDestructiveSyncAction({ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: false })).toBe(false);
    expect(isDestructiveSyncAction({ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: true })).toBe(false);
  });

  it('deletes the open task when the flag was cleared elsewhere (Clear Flag)', () => {
    const { actions, mirror } = plan({ flagged: false, mirror: seen });
    expect(actions).toEqual([{ kind: 'delete-task', taskId: 'T1', emailId: 'M1' }]);
    expect(mirror).toEqual({});
  });

  it('completes instead of deleting the open task of a mail whose star was taken off in the app', () => {
    const { actions, mirror } = plan({ flagged: false, mirror: seen, unstarredHere: new Set(['M1']) });
    expect(actions).toEqual([{ kind: 'complete-task', taskId: 'T1', emailId: 'M1' }]);
    expect(actions.some(isDestructiveSyncAction)).toBe(false);
    expect(mirror).toEqual(seen);
  });

  it('lets the task win when it changed since it was last seen in step', () => {
    const { actions } = plan({ tasks: [task({ updated: 'rescheduled on the phone' })], flagged: false, mirror: seen });
    expect(actions).toEqual([{ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: true }]);
  });

  it('sets the flag of an open task never seen in step here (a new browser): the task is the original', () => {
    expect(plan({ flagged: false }).actions).toEqual([{ kind: 'flag', taskId: 'T1', emailId: 'M1', flagged: true }]);
  });

  it('leaves a flag set elsewhere on a mail whose follow-up is done, or that has none', () => {
    expect(plan({ tasks: [task({ open: false })], flagged: true }).actions).toEqual([]);
    expect(plan({ tasks: [], flags: new Map([['M9', true]]) }).actions).toEqual([]);
  });

  it('keeps flag and task as they are once in step: its own writes start no further change', () => {
    // After the flag was cleared for a completed task, the next check (the push) finds nothing to do.
    const after = plan({ tasks: [task({ open: false })], flagged: false, mirror: {} });
    expect(after.actions).toEqual([]);
    // After a deleted task's flag was cleared.
    expect(plan({ tasks: [], present: new Set(), flagged: false, mirror: {} }).actions).toEqual([]);
  });

  it('changes nothing for a mail that is gone, and forgets it', () => {
    const { actions, mirror } = plan({ flagged: null, mirror: seen });
    expect(actions).toEqual([]);
    expect(mirror).toEqual({});
  });

  it('leaves a mail alone that was not checked', () => {
    const { actions, mirror } = plan({ flags: new Map(), mirror: seen });
    expect(actions).toEqual([]);
    expect(mirror).toEqual(seen);
  });

  it('keeps the flag of a deleted follow-up while another open one stands on the mail', () => {
    const other = task({ id: 'T2' });
    const { actions } = plan({ tasks: [other], present: new Set(['T2']), flagged: true, mirror: seen });
    expect(actions).toEqual([]);
  });
});

describe('parseFollowUpMirror', () => {
  it('reads what it wrote and drops what it does not know', () => {
    expect(parseFollowUpMirror(JSON.stringify(seen))).toEqual(seen);
    expect(parseFollowUpMirror('{"T1": {"emailId": 1}, "T2": null}')).toEqual({});
    expect(parseFollowUpMirror('not json')).toEqual({});
    expect(parseFollowUpMirror(null)).toEqual({});
  });
});

describe('what the task keeps of its mail', () => {
  const written = buildFollowUpTask({
    title: 'Follow up: Offer 4711',
    mailUrl: 'https://mail.example/mail/message/M1?mailAccount=acc',
    subject: 'Offer 4711',
    messageId: ['offer@example.com'],
    from: { name: 'Rita Vogt', email: 'rita@kessler.example' },
    calendarId: 'tasks',
    due: null,
    reminderAt: null,
  }) as CalendarTask;

  it('keeps sender and subject, so a gone mail can still be named', () => {
    expect(written.links?.from).toMatchObject({ href: 'mailto:rita@kessler.example', rel: 'author', title: 'Rita Vogt' });
    expect(followUpMailSummary(written)).toEqual({ subject: 'Offer 4711', sender: 'Rita Vogt' });
    expect(followUpMessageId(written)).toBe('offer@example.com');
  });

  it('names the sender by address without a name, and a task without one by its subject alone', () => {
    const byAddress = buildFollowUpTask({ ...baseInput(), from: { email: 'rita@kessler.example' } }) as CalendarTask;
    expect(followUpMailSummary(byAddress).sender).toBe('rita@kessler.example');
    const older = buildFollowUpTask({ ...baseInput(), from: null }) as CalendarTask;
    expect(older.links?.from).toBeUndefined();
    expect(followUpMailSummary(older)).toEqual({ subject: 'Offer 4711', sender: null });
  });

  it('adds the sender to a follow-up written without it, once', () => {
    const older = buildFollowUpTask({ ...baseInput(), from: null }) as CalendarTask;
    const patch = addFollowUpSender(older, { name: 'Rita Vogt', email: 'rita@kessler.example' });
    expect(patch?.links?.mail).toEqual(older.links?.mail);
    expect(patch?.links?.from).toMatchObject({ rel: 'author', title: 'Rita Vogt' });
    expect(addFollowUpSender(written, { email: 'other@example.com' })).toBeNull();
    expect(addFollowUpSender(older, undefined)).toBeNull();
  });

  it('points the link at a mail found again under another id, keeping its account', () => {
    const patch = relinkFollowUpTask(written, 'M2') as CalendarTask;
    expect(followUpMailRef(patch)).toEqual({ emailId: 'M2', accountId: 'acc' });
    expect(patch.links?.from).toEqual(written.links?.from);
  });
});

function baseInput() {
  return {
    title: 'Follow up: Offer 4711',
    mailUrl: 'https://mail.example/mail/message/M1',
    subject: 'Offer 4711',
    calendarId: 'tasks',
    due: null,
    reminderAt: null,
  };
}
