import { describe, expect, it } from 'vitest';
import { applyPatchObject } from '../jmap/patch-object';
import {
  FOLLOW_UP_ALERT_ID,
  FOLLOW_UP_MAIL_ALERT_ID,
  REPLY_WATCH_ALERT_ID,
  REPLY_WATCH_PROPERTY,
  buildFollowUpTask,
  editFollowUpTask,
  followUpReminder,
  hasFollowUpMailAlert,
  otherFollowUpAlerts,
  replyWatch,
  rescheduleFollowUpTask,
  settlesOnReply,
  type FollowUpTaskInput,
} from '../follow-ups';
import {
  completedTaskPatch,
  dismissTaskReminder,
  dueTaskReminders,
  snoozeTaskReminder,
  withCompletion,
} from '../task-reminders';
import type { CalendarEventAlert, CalendarTask } from '../jmap/types';

// A follow-up that settles itself when an answer comes keeps its reminder in
// a vendor property on its relation to the mail's Message-ID, never as an
// alert: the phone and the mail server know nothing of answers.

const NOW = new Date('2026-10-28T09:30:00Z');
const KEY = '<M1@holoeye.example>';
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const input = (over: Partial<FollowUpTaskInput> = {}): FollowUpTaskInput => ({
  title: 'Follow up: Offer',
  mailUrl: 'https://mail.example/mail/message/M1',
  subject: 'Offer',
  messageId: ['M1@holoeye.example'],
  calendarId: 'tasks',
  due: new Date(2026, 9, 30),
  reminderAt: minutes(60),
  ...over,
});

function stored(task: Partial<CalendarTask>, id = 'T1'): CalendarTask {
  return { ...task, id, uid: id, updated: '2026-10-26T08:00:00Z' } as CalendarTask;
}

const watchValue = (task: Partial<CalendarTask>) =>
  (task.relatedTo?.[KEY] as unknown as Record<string, Record<string, unknown> | null> | undefined)?.[REPLY_WATCH_PROPERTY];

const absolute = (when: Date): CalendarEventAlert => ({
  '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: utc(when) }, action: 'display', acknowledged: null, relatedTo: null,
});

describe('a new follow-up that settles on an answer', () => {
  it('gets no alert, and keeps its reminder in the watch on the Message-ID', () => {
    const task = stored(buildFollowUpTask(input({ settlesOnReply: true, mailReminder: true })));
    expect(task.alerts).toBeNull();
    expect(task.relatedTo?.[KEY]?.relation).toEqual({ parent: true });
    expect(watchValue(task)).toEqual({ reminder: utc(minutes(60)), acknowledged: null, answeredAt: null });
    expect(settlesOnReply(task)).toBe(true);
    expect(followUpReminder(task)).toEqual(minutes(60));
    expect(hasFollowUpMailAlert(task)).toBe(false);
  });

  it('keeps no reminder when none is set, and still settles on an answer', () => {
    const task = stored(buildFollowUpTask(input({ settlesOnReply: true, reminderAt: null })));
    expect(settlesOnReply(task)).toBe(true);
    expect(followUpReminder(task)).toBeNull();
  });

  it('is a plain follow-up with its alert when the mail has no Message-ID', () => {
    const task = buildFollowUpTask(input({ settlesOnReply: true, messageId: null }));
    expect(settlesOnReply(task)).toBe(false);
    expect(task.alerts?.[FOLLOW_UP_ALERT_ID]).toBeTruthy();
  });
});

describe('replyWatch', () => {
  it('reads only an object: a watch taken off is kept as null by Stalwart', () => {
    const task = stored(buildFollowUpTask(input({ settlesOnReply: true })));
    expect(replyWatch(task)).toMatchObject({ key: KEY, messageId: 'M1@holoeye.example', reminder: minutes(60) });
    const off = { ...task, relatedTo: { [KEY]: { '@type': 'Relation', relation: { parent: true }, [REPLY_WATCH_PROPERTY]: null } } } as unknown as CalendarTask;
    expect(replyWatch(off)).toBeNull();
    expect(replyWatch({ relatedTo: null })).toBeNull();
  });
});

describe('editing a follow-up', () => {
  const plain = () => stored(buildFollowUpTask(input({ mailReminder: true })));
  const watching = () => stored(buildFollowUpTask(input({ settlesOnReply: true })));

  it('turned on: the watch takes the reminder, its own alert and alarm mail go, an alert set elsewhere stays', () => {
    const before = { ...plain(), alerts: { ...plain().alerts, phone: absolute(minutes(30)) } };
    const patch = editFollowUpTask(before, { title: null, due: new Date(2026, 9, 30), reminderAt: minutes(60), note: '', settlesOnReply: true });
    expect(patch[`relatedTo/${KEY}/${REPLY_WATCH_PROPERTY}` as keyof typeof patch]).toEqual({ reminder: utc(minutes(60)), acknowledged: null, answeredAt: null });
    const after = applyPatchObject(before, patch);
    expect(Object.keys(after.alerts ?? {})).toEqual(['phone']);
    expect(followUpReminder(after)).toEqual(minutes(60));
    expect(otherFollowUpAlerts(after)).toBe(1);
  });

  it('turned on for a task written without the relation, which it gets', () => {
    const before = { ...plain(), relatedTo: null };
    const patch = editFollowUpTask(before, {
      title: null, due: null, reminderAt: null, note: '', settlesOnReply: true, messageId: ['M1@holoeye.example'],
    });
    const after = applyPatchObject(before as CalendarTask, patch);
    expect(settlesOnReply(after)).toBe(true);
    expect(after.relatedTo?.[KEY]?.relation).toEqual({ parent: true });
  });

  it('moves the watch\'s reminder and opens it again; an unchanged one stays dismissed', () => {
    const task = watching();
    const dismissed = applyPatchObject(task, { [`relatedTo/${KEY}/${REPLY_WATCH_PROPERTY}/acknowledged`]: utc(NOW) });
    const same = editFollowUpTask(dismissed, { title: null, due: new Date(2026, 9, 30), reminderAt: minutes(60), note: '' });
    expect(Object.keys(same).some((k) => k.startsWith('relatedTo'))).toBe(false);
    const moved = applyPatchObject(dismissed, editFollowUpTask(dismissed, { title: null, due: null, reminderAt: minutes(120), note: '' }));
    expect(watchValue(moved)?.reminder).toBe(utc(minutes(120)));
    expect(replyWatch(moved)?.acknowledged).toBeNull();
    expect(moved.alerts ?? null).toBeNull();
  });

  it('a quick choice moves the watch\'s reminder, writing no alert', () => {
    const after = applyPatchObject(watching(), rescheduleFollowUpTask(watching(), new Date(2026, 10, 2), minutes(24 * 60)));
    expect(watchValue(after)?.reminder).toBe(utc(minutes(24 * 60)));
    expect(after.alerts ?? null).toBeNull();
  });

  it('turned off: the watch goes and the reminder is an alert again, the alarm mail offered again', () => {
    const task = watching();
    const after = applyPatchObject(task, editFollowUpTask(task, {
      title: null, due: null, reminderAt: minutes(60), note: '', settlesOnReply: false, mailReminder: true,
    }));
    expect(settlesOnReply(after)).toBe(false);
    expect(after.alerts?.[FOLLOW_UP_ALERT_ID]?.action).toBe('display');
    expect(after.alerts?.[FOLLOW_UP_MAIL_ALERT_ID]?.action).toBe('email');
    expect(followUpReminder(after)).toEqual(minutes(60));
  });
});

describe('switching the box keeps what was dismissed and answered', () => {
  const edit = (task: CalendarTask, settlesOnReply: boolean, reminderAt: Date | null = minutes(-10)) =>
    applyPatchObject(task, editFollowUpTask(task, { title: null, due: new Date(2026, 9, 30), reminderAt, note: '', settlesOnReply }));

  it('a dismissed reminder stays dismissed when the box is turned off and on again', () => {
    const watching = stored(buildFollowUpTask(input({ settlesOnReply: true, reminderAt: minutes(-10) })));
    const dismissed = applyPatchObject(watching, dismissTaskReminder(watching, [REPLY_WATCH_ALERT_ID], NOW));
    const off = edit(dismissed, false);
    expect(off.alerts?.[FOLLOW_UP_ALERT_ID]?.acknowledged).toBe(utc(NOW));
    expect(dueTaskReminders([off], NOW.getTime())).toEqual([]);
    const on = edit(off, true);
    expect(replyWatch(on)?.acknowledged).toBe(utc(NOW));
    expect(dueTaskReminders([on], NOW.getTime())).toEqual([]);
    // A new time reminds again.
    expect(dueTaskReminders([edit(on, true, minutes(-5))], NOW.getTime())).toHaveLength(1);
  });

  it('an answer that settled it does not settle it again after off and on', () => {
    const watching = stored(buildFollowUpTask(input({ settlesOnReply: true, reminderAt: null })));
    const answered = applyPatchObject(watching, { [`relatedTo/${KEY}/${REPLY_WATCH_PROPERTY}/answeredAt`]: '2026-10-27T10:00:00Z' });
    const off = edit(answered, false, null);
    expect(settlesOnReply(off)).toBe(false);
    expect(watchValue(off)).toEqual({ off: true, answeredAt: '2026-10-27T10:00:00Z' });
    expect(replyWatch(edit(off, true, null))?.answeredAt).toBe('2026-10-27T10:00:00Z');
    // Without an answer, turning it off leaves nothing behind.
    expect(watchValue(edit(watching, false, null))).toBeUndefined();
  });
});

describe('the reminders window and a watch', () => {
  const due = () => stored(buildFollowUpTask(input({ settlesOnReply: true, reminderAt: minutes(-10) })));

  it('shows the watch\'s reminder once it fell due, as if it were an alert', () => {
    const [reminder] = dueTaskReminders([due()], NOW.getTime());
    expect(reminder.alertIds).toEqual([REPLY_WATCH_ALERT_ID]);
    expect(reminder.fireTimeMs).toBe(minutes(-10).getTime());
    expect(dueTaskReminders([stored(buildFollowUpTask(input({ settlesOnReply: true })))], NOW.getTime())).toEqual([]);
  });

  it('holds it back until the thread was looked at after it fell due', () => {
    const task = due();
    expect(dueTaskReminders([task], NOW.getTime(), () => undefined)).toEqual([]);
    expect(dueTaskReminders([task], NOW.getTime(), () => minutes(-20).getTime())).toEqual([]);
    expect(dueTaskReminders([task], NOW.getTime(), () => minutes(-1).getTime())).toHaveLength(1);
    // A task that does not settle on an answer is never held.
    const plain = stored(buildFollowUpTask(input({ reminderAt: minutes(-10) })));
    expect(dueTaskReminders([plain], NOW.getTime(), () => undefined)).toHaveLength(1);
  });

  it('dismisses it in the watch', () => {
    const task = due();
    const after = applyPatchObject(task, dismissTaskReminder(task, [REPLY_WATCH_ALERT_ID], NOW));
    expect(watchValue(after)?.acknowledged).toBe(utc(NOW));
    expect(dueTaskReminders([after], NOW.getTime())).toEqual([]);
    expect(after.alerts ?? null).toBeNull();
  });

  it('snoozes it in the watch, writing no alert', () => {
    const task = due();
    const after = applyPatchObject(task, snoozeTaskReminder(task, [REPLY_WATCH_ALERT_ID], minutes(15), NOW));
    expect(watchValue(after)?.reminder).toBe(utc(minutes(15)));
    expect(replyWatch(after)?.acknowledged).toBeNull();
    expect(after.alerts ?? null).toBeNull();
    expect(dueTaskReminders([after], minutes(16).getTime())).toHaveLength(1);
  });

  it('completing dismisses it, also from a form that writes the alerts whole', () => {
    const task = due();
    expect(watchValue(applyPatchObject(task, completedTaskPatch(task, NOW)))?.acknowledged).toBe(utc(NOW));
    const whole = withCompletion(task, { progress: 'completed', alerts: null }, NOW);
    expect(whole[`relatedTo/${KEY}/${REPLY_WATCH_PROPERTY}/acknowledged` as keyof typeof whole]).toBe(utc(NOW));
  });
});
