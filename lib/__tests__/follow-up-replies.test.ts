import { describe, expect, it } from 'vitest';
import {
  PUSH_RECHECK_MS,
  RECHECK_MS,
  findReply,
  replyChecksDue,
  watchesForReply,
  type ThreadMail,
} from '../follow-up-replies';
import { answeredTaskPatch } from '@/lib/task-reminders';
import { applyPatchObject } from '../jmap/patch-object';
import { buildFollowUpTask } from '../follow-ups';
import { REPLY_WATCH_PROPERTY, replyWatch } from '@/lib/follow-up-replies';
import type { CalendarTask } from '../jmap/types';

const FLAGGED = { id: 'M1', receivedAt: '2026-10-26T08:00:00Z' };
const SENT = new Set(['sent', 'drafts']);

function mail(id: string, over: Partial<ThreadMail> = {}): ThreadMail {
  return {
    id,
    messageId: [`${id}@kessler.example`],
    inReplyTo: ['M1@example.com'],
    references: ['M1@example.com'],
    receivedAt: '2026-10-27T10:00:00Z',
    mailboxIds: { inbox: true },
    keywords: {},
    ...over,
  };
}

const find = (mails: ThreadMail[], after: string | null = null) =>
  findReply({ messageId: 'M1@example.com', flagged: FLAGGED, mails, ownFolderIds: SENT, after });

describe('findReply', () => {
  it('finds a received mail naming the flagged one in In-Reply-To or References', () => {
    expect(find([mail('A')])?.id).toBe('A');
    expect(find([mail('B', { inReplyTo: ['other@x'], references: ['root@x', '<M1@example.com>'] })])?.id).toBe('B');
    expect(find([mail('C', { inReplyTo: null, references: null })])).toBeNull();
  });

  it('takes the first answer that came', () => {
    const later = mail('later', { receivedAt: '2026-10-28T10:00:00Z' });
    const first = mail('first', { receivedAt: '2026-10-27T09:00:00Z' });
    expect(find([later, first])?.id).toBe('first');
  });

  it('leaves out the flagged mail, a copy of it, and mails received before it', () => {
    expect(find([{ ...mail('M1'), receivedAt: '2026-10-27T10:00:00Z' }])).toBeNull();
    expect(find([mail('copy', { messageId: ['<M1@example.com>'] })])).toBeNull();
    expect(find([mail('early', { receivedAt: '2026-10-25T10:00:00Z' })])).toBeNull();
    expect(find([mail('same', { receivedAt: FLAGGED.receivedAt })])).toBeNull();
  });

  it('counts no mail the user sent or drafted: a nudge names the mail too', () => {
    expect(find([mail('mine', { mailboxIds: { sent: true } })])).toBeNull();
    expect(find([mail('draft', { mailboxIds: { drafts: true } })])).toBeNull();
    expect(find([mail('draft2', { keywords: { $draft: true } })])).toBeNull();
    expect(find([mail('nowhere', { mailboxIds: {} })])).toBeNull();
    // Moved by a filter into another folder too, or deleted: it came.
    expect(find([mail('filed', { mailboxIds: { sent: true, projects: true } })])?.id).toBe('filed');
    expect(find([mail('trash', { mailboxIds: { trash: true } })])?.id).toBe('trash');
  });

  it('counts no mail from the account\'s own addresses, wherever it lies', () => {
    const own = new Set(['me@example.com', 'sales@example.com']);
    const findOwn = (m: ThreadMail) => findReply({ messageId: 'M1@example.com', flagged: FLAGGED, mails: [m], ownFolderIds: SENT, ownAddresses: own });
    // A nudge sent, then filed into an archive folder.
    expect(findOwn(mail('nudge', { mailboxIds: { archive: true }, from: [{ email: 'ME@example.com' }] }))).toBeNull();
    // The user's own copy by Cc, in the inbox.
    expect(findOwn(mail('cc', { mailboxIds: { inbox: true }, from: [{ email: 'me@example.com' }] }))).toBeNull();
    // A group mailbox's answer sent from the group's address.
    expect(findOwn(mail('group', { from: [{ email: 'sales@example.com' }] }))).toBeNull();
    expect(findOwn(mail('rita', { from: [{ email: 'rita@kessler.example' }] }))?.id).toBe('rita');
  });

  it('counts only answers after the one that settled it before (a task reopened)', () => {
    const old = mail('old', { receivedAt: '2026-10-27T10:00:00Z' });
    expect(find([old], '2026-10-27T10:00:00Z')).toBeNull();
    const fresh = mail('fresh', { receivedAt: '2026-10-29T10:00:00Z' });
    expect(find([old, fresh], '2026-10-27T10:00:00Z')?.id).toBe('fresh');
  });

  it('finds nothing without a Message-ID', () => {
    expect(findReply({ messageId: '', flagged: FLAGGED, mails: [mail('A')], ownFolderIds: SENT })).toBeNull();
  });
});

function watched(id: string, over: Partial<CalendarTask> = {}, reminderAt: Date | null = new Date('2026-10-28T08:00:00Z')): CalendarTask {
  return {
    ...buildFollowUpTask({
      title: 'Follow up: Offer',
      mailUrl: `https://mail.example/mail/message/${id}-mail`,
      subject: 'Offer',
      messageId: [`${id}@example.com`],
      calendarId: 'tasks',
      due: new Date(2026, 9, 30),
      reminderAt,
      settlesOnReply: true,
    }),
    id,
    uid: id,
    updated: '2026-10-26T08:00:00Z',
    ...over,
  } as CalendarTask;
}

describe('watchesForReply', () => {
  it('names the open, own, single follow-ups that settle on an answer', () => {
    expect(watchesForReply(watched('T1'))?.messageId).toBe('T1@example.com');
    expect(watchesForReply(watched('T2', { progress: 'completed' }))).toBeNull();
    expect(watchesForReply(watched('T3', { isShared: true }))).toBeNull();
    expect(watchesForReply(watched('T4', { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }] } as Partial<CalendarTask>))).toBeNull();
    const plain = { ...watched('T5'), relatedTo: { '<T5@example.com>': { '@type': 'Relation' as const, relation: { parent: true } } } };
    expect(watchesForReply(plain)).toBeNull();
  });
});

describe('replyChecksDue', () => {
  const NOW = new Date('2026-10-28T09:00:00Z').getTime();
  const due = (checked: Record<string, number>, fires: number | null, push: number | null = null) =>
    replyChecksDue([watched('T1')], NOW, (id) => checked[id], () => fires, push).map((t) => t.id);

  it('looks at a task once when the tasks load', () => {
    expect(due({}, null)).toEqual(['T1']);
    expect(due({ T1: NOW - 1000 }, null)).toEqual([]);
  });

  it('looks again once its reminder fell due after the last look, before it shows', () => {
    expect(due({ T1: NOW - 60_000 }, NOW - 1000)).toEqual(['T1']);
    expect(due({ T1: NOW - 500 }, NOW - 1000)).toEqual([]);
    // Still to come: not yet.
    expect(due({ T1: NOW - 60_000 }, NOW + 1000)).toEqual([]);
  });

  it('looks again after a push, at most once a minute, and every quarter of an hour', () => {
    expect(due({ T1: NOW - 10_000 }, null, NOW - 5000)).toEqual([]);
    expect(due({ T1: NOW - PUSH_RECHECK_MS }, null, NOW - 5000)).toEqual(['T1']);
    expect(due({ T1: NOW - PUSH_RECHECK_MS }, null, NOW - PUSH_RECHECK_MS - 1)).toEqual([]);
    expect(due({ T1: NOW - RECHECK_MS }, null)).toEqual(['T1']);
  });

  it('leaves out tasks that do not settle on an answer', () => {
    const plain = { ...watched('T2'), relatedTo: null };
    expect(replyChecksDue([plain], NOW, () => undefined, () => null, null)).toEqual([]);
  });
});

describe('answeredTaskPatch', () => {
  const now = new Date('2026-10-28T09:00:00Z');

  it('completes the task, dismisses its reminder that fired, keeps the answer\'s time and adds the note below', () => {
    const task = { ...watched('T1'), description: 'Ask about the price' };
    const watch = replyWatch(task)!;
    const after = applyPatchObject(task, answeredTaskPatch(task, watch, '2026-10-27T10:00:00Z', 'Answer received on 27/10/2026', now));
    expect(after.progress).toBe('completed');
    expect(after.description).toBe('Ask about the price\nAnswer received on 27/10/2026');
    const value = (after.relatedTo?.['<T1@example.com>'] as unknown as Record<string, Record<string, unknown>>)[REPLY_WATCH_PROPERTY];
    expect(value.answeredAt).toBe('2026-10-27T10:00:00Z');
    expect(value.acknowledged).toBe('2026-10-28T09:00:00Z');
    expect(after.alerts ?? null).toBeNull();
  });

  it('writes the note alone into an empty description and leaves an HTML one as it is', () => {
    const task = watched('T1', {}, null);
    const watch = replyWatch(task)!;
    expect(answeredTaskPatch(task, watch, '2026-10-27T10:00:00Z', 'Antwort am 27.10.2026 erhalten', now).description)
      .toBe('Antwort am 27.10.2026 erhalten');
    const html = { ...task, description: '<p>x</p>', descriptionContentType: 'text/html' };
    expect('description' in answeredTaskPatch(html, watch, '2026-10-27T10:00:00Z', 'n', now)).toBe(false);
  });
});
