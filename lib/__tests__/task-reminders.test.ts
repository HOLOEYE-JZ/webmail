import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNOOZE,
  completedTaskPatch,
  dismissTaskReminder,
  dueTaskReminders,
  isAlertAcknowledged,
  isReminderWindowTask,
  snoozeTaskReminder,
  snoozeTimes,
} from '../task-reminders';
import { getPendingAlerts, getPendingTaskAlerts } from '../calendar-alerts';
import { applyPatchObject, patchPath } from '../jmap/patch-object';
import { buildFollowUpTask, buildReminderTask, followUpReminder, type WorkingTime } from '../follow-ups';
import type { CalendarEvent, CalendarEventAlert, CalendarTask } from '../jmap/types';

const NOW = new Date('2026-10-28T09:30:00Z');
const applied = (task: CalendarTask, patch: object) => applyPatchObject(task, patch);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function stored(task: Partial<CalendarTask>, id: string): CalendarTask {
  return { ...task, id, uid: id, updated: '2026-10-26T08:00:00Z' } as CalendarTask;
}

const reminderTask = (id: string, reminderAt: Date | null, over: Partial<CalendarTask> = {}) =>
  stored({ ...buildReminderTask({ title: id, calendarId: 'tasks', due: new Date(2026, 9, 28), reminderAt }), ...over }, id);

const absolute = (when: Date, over: Partial<CalendarEventAlert> = {}): CalendarEventAlert => ({
  '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: utc(when) }, action: 'display', acknowledged: null, relatedTo: null, ...over,
});

const relative = (offset: string, over: Partial<CalendarEventAlert> = {}): CalendarEventAlert => ({
  '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' }, action: 'display', acknowledged: null, relatedTo: null, ...over,
});

describe('isAlertAcknowledged', () => {
  it('counts an acknowledgement at or after the time it fires (RFC 8984)', () => {
    const fires = minutes(-10).getTime();
    expect(isAlertAcknowledged({ acknowledged: null }, fires)).toBe(false);
    expect(isAlertAcknowledged({ acknowledged: utc(minutes(-10)) }, fires)).toBe(true);
    expect(isAlertAcknowledged({ acknowledged: utc(minutes(-5)) }, fires)).toBe(true);
    // Acknowledged before it was moved to a later time: it fires again.
    expect(isAlertAcknowledged({ acknowledged: utc(minutes(-60)) }, fires)).toBe(false);
    expect(isAlertAcknowledged({ acknowledged: 'garbage' }, fires)).toBe(true);
  });
});

describe('dueTaskReminders', () => {
  it('keeps a reminder that fell due long ago, until it is acknowledged', () => {
    const late = reminderTask('late', minutes(-3 * 24 * 60));
    expect(dueTaskReminders([late], NOW.getTime()).map((r) => r.task.id)).toEqual(['late']);
    const dismissed = applied(late, dismissTaskReminder(late, ['follow-up'], NOW));
    expect(dueTaskReminders([dismissed], NOW.getTime())).toEqual([]);
  });

  it('leaves out reminders to come, completed and cancelled tasks, email alerts, shared and repeating tasks', () => {
    const tasks = [
      reminderTask('soon', minutes(5)),
      reminderTask('done', minutes(-5), { progress: 'completed' }),
      reminderTask('cancelled', minutes(-5), { progress: 'cancelled' }),
      reminderTask('mail-alarm', null, { alerts: { a: absolute(minutes(-5), { action: 'email' }) } }),
      reminderTask('shared', minutes(-5), { isShared: true }),
      reminderTask('series', minutes(-5), { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as unknown as CalendarTask['recurrenceRules'] }),
      reminderTask('due', minutes(-5)),
    ];
    expect(dueTaskReminders(tasks, NOW.getTime()).map((r) => r.task.id)).toEqual(['due']);
  });

  it('gives one row per task, its fired alerts together, the earliest reminder first', () => {
    const two = reminderTask('two', null, { alerts: { b: absolute(minutes(-2)), a: absolute(minutes(-20)), later: absolute(minutes(30)) } });
    const one = reminderTask('one', minutes(-10));
    const rows = dueTaskReminders([two, one], NOW.getTime());
    expect(rows.map((r) => [r.task.id, r.alertIds])).toEqual([['one', ['follow-up']], ['two', ['a', 'b']]]);
    expect(rows[1].fireTimeMs).toBe(minutes(-2).getTime());
    expect(rows[1].key).toBe(`two:a+b:${minutes(-2).getTime()}`);
  });

  it('counts a relative alert from the due day, as the toasts do', () => {
    const task = reminderTask('rel', null, { due: '2026-10-28T10:00:00', showWithoutTime: false, alerts: { r: relative('-PT1H') } });
    // Due 10:00 local; the alert fired an hour before.
    const fires = new Date(2026, 9, 28, 9, 0).getTime();
    expect(dueTaskReminders([task], fires - 1)).toEqual([]);
    expect(dueTaskReminders([task], fires).map((r) => r.alertIds)).toEqual([['r']]);
  });
});

describe('the window leaves events and the old toasts alone', () => {
  it('drops an event alert more than ten minutes late, as before', () => {
    const event = {
      id: 'e1', start: '2026-10-28T12:00:00', utcStart: '2026-10-28T12:00:00Z', duration: 'PT1H', calendarIds: { c: true },
      useDefaultAlerts: false, status: 'confirmed',
      alerts: { a: absolute(minutes(-11)), b: absolute(minutes(-3)) },
    } as unknown as CalendarEvent;
    expect(getPendingAlerts([event], [], new Set(), NOW.getTime()).map((p) => p.alertId)).toEqual(['b']);
  });

  it('toasts a shared or repeating task as before, and none the window shows', () => {
    const tasks = [
      reminderTask('own', minutes(-3)),
      reminderTask('shared', minutes(-3), { isShared: true }),
      reminderTask('series', minutes(-3), { recurrenceRules: [{ frequency: 'daily' }] as unknown as CalendarTask['recurrenceRules'] }),
      reminderTask('stale-shared', minutes(-30), { isShared: true }),
    ];
    expect(getPendingTaskAlerts(tasks, [], new Set(), NOW.getTime()).map((p) => p.taskId)).toEqual(['own', 'shared', 'series']);
    expect(getPendingTaskAlerts(tasks, [], new Set(), NOW.getTime(), isReminderWindowTask).map((p) => p.taskId)).toEqual(['shared', 'series']);
  });
});

describe('dismissTaskReminder', () => {
  it('acknowledges the fired alerts by path, nothing else written', () => {
    const task = reminderTask('t', null, { alerts: { a: absolute(minutes(-5)), other: relative('-PT1H'), mail: absolute(minutes(-5), { action: 'email' }) } });
    const patch = dismissTaskReminder(task, ['a'], NOW);
    expect(patch).toEqual({ 'alerts/a/acknowledged': '2026-10-28T09:30:00Z' });
    expect(applied(task, patch).alerts).toEqual({ ...task.alerts, a: { ...task.alerts!.a, acknowledged: '2026-10-28T09:30:00Z' } });
  });

  it('keeps a change another device made meanwhile to another alert', () => {
    const seen = reminderTask('t', null, { alerts: { a: absolute(minutes(-5)), phone: relative('-PT1H') } });
    const patch = dismissTaskReminder(seen, ['a'], NOW);
    // The server's copy, where a phone moved its own alert since.
    const server = { ...seen, alerts: { ...seen.alerts, phone: relative('-PT2H') } };
    expect(applied(server, patch).alerts!.phone).toEqual(relative('-PT2H'));
  });
});

describe('completedTaskPatch', () => {
  it('completes the task and acknowledges the alerts that fired, not those to come', () => {
    const task = reminderTask('t', null, {
      alerts: { fired: absolute(minutes(-5)), seen: absolute(minutes(-30), { acknowledged: utc(minutes(-20)) }), later: absolute(minutes(60)) },
    });
    expect(completedTaskPatch(task, NOW)).toEqual({ progress: 'completed', 'alerts/fired/acknowledged': '2026-10-28T09:30:00Z' });
    expect(completedTaskPatch(reminderTask('n', null), NOW)).toEqual({ progress: 'completed' });
  });

  it('reopened, the task does not remind of what fired before it was completed', () => {
    const task = reminderTask('t', minutes(-5));
    const done = applied(task, completedTaskPatch(task, NOW));
    expect(dueTaskReminders([done], NOW.getTime())).toEqual([]);
    const reopened = { ...done, progress: 'needs-action' } as CalendarTask;
    expect(dueTaskReminders([reopened], NOW.getTime())).toEqual([]);
    // Moved to a later time, it reminds again.
    const moved = { ...reopened, alerts: { 'follow-up': { ...reopened.alerts!['follow-up'], trigger: { '@type': 'AbsoluteTrigger' as const, when: utc(minutes(10)) } } } };
    expect(dueTaskReminders([moved], minutes(10).getTime())).toHaveLength(1);
  });
});

describe('snoozeTaskReminder', () => {
  it('moves a reminder at a fixed time and opens it again, so any client fires it then', () => {
    const task = reminderTask('t', minutes(-5));
    const at = minutes(15);
    const patch = snoozeTaskReminder(task, ['follow-up'], at, NOW);
    expect(patch).toEqual({
      'alerts/follow-up/trigger': { '@type': 'AbsoluteTrigger', when: utc(at) },
      'alerts/follow-up/acknowledged': null,
    });
    const after = applied(task, patch);
    // The reminder the list and the dialog show moves along.
    expect(followUpReminder(after)).toEqual(at);
    // It is not due now, and comes again at that time under a new key.
    expect(dueTaskReminders([after], NOW.getTime())).toEqual([]);
    const again = dueTaskReminders([after], at.getTime());
    expect(again).toHaveLength(1);
    expect(again[0].key).not.toBe(dueTaskReminders([task], NOW.getTime())[0].key);
  });

  it('keeps a relative alert, acknowledged, and adds a snooze alert related to it', () => {
    const task = reminderTask('t', null, { due: '2026-10-28T10:00:00', showWithoutTime: false, alerts: { r: relative('-PT1H') } });
    const at = minutes(60);
    const patch = snoozeTaskReminder(task, ['r'], at, NOW);
    const snooze = {
      '@type': 'Alert',
      trigger: { '@type': 'AbsoluteTrigger', when: utc(at) },
      action: 'display',
      acknowledged: null,
      relatedTo: { r: { '@type': 'Relation', relation: { parent: true } } },
    };
    expect(patch).toEqual({ 'alerts/r/acknowledged': '2026-10-28T09:30:00Z', 'alerts/snooze': snooze });
    // Snoozed again from the snooze alert: that alert moves, no second one.
    const snoozed = applied(task, patch);
    const fired = dueTaskReminders([snoozed], at.getTime() + 1000);
    expect(fired[0].alertIds).toEqual(['snooze']);
    const later = minutes(300);
    const again = applied(snoozed, snoozeTaskReminder(snoozed, fired[0].alertIds, later, new Date(at.getTime() + 1000)));
    expect(Object.keys(again.alerts!).sort()).toEqual(['r', 'snooze']);
    expect(again.alerts!.snooze.trigger).toEqual({ '@type': 'AbsoluteTrigger', when: utc(later) });
    expect(again.alerts!.snooze.relatedTo).toEqual(snooze.relatedTo);
  });

  it('does not overwrite an alert that happens to be called "snooze", and escapes an id with a slash', () => {
    const task = reminderTask('t', null, { due: '2026-10-28T10:00:00', showWithoutTime: false, alerts: { 'r/1': relative('-PT1H'), snooze: relative('-PT2H', { acknowledged: utc(minutes(-1)) }) } });
    const patch = snoozeTaskReminder(task, ['r/1'], minutes(5), NOW);
    expect(Object.keys(patch).sort()).toEqual(['alerts/r~11/acknowledged', 'alerts/snooze-2']);
    const after = applied(task, patch);
    expect(after.alerts!.snooze).toEqual(task.alerts!.snooze);
    expect(after.alerts!['snooze-2'].relatedTo).toEqual({ 'r/1': { '@type': 'Relation', relation: { parent: true } } });
    expect(after.alerts!['r/1'].acknowledged).toBe('2026-10-28T09:30:00Z');
  });

  it('moves the follow-up\'s own reminder when several fired, and acknowledges the others', () => {
    const task = stored(buildFollowUpTask({
      title: 'Call: Offer', mailUrl: 'https://h/mail/message/M1', subject: 'Offer', calendarId: 'tasks', due: new Date(2026, 9, 28), reminderAt: minutes(-30),
    }), 'f');
    task.alerts = { phone: absolute(minutes(-40)), ...task.alerts };
    expect(snoozeTaskReminder(task, ['follow-up', 'phone'], minutes(15), NOW)).toEqual({
      'alerts/phone/acknowledged': '2026-10-28T09:30:00Z',
      'alerts/follow-up/trigger': { '@type': 'AbsoluteTrigger', when: utc(minutes(15)) },
      'alerts/follow-up/acknowledged': null,
    });
  });
});

describe('applyPatchObject', () => {
  it('sets, replaces and removes members by path, leaving the rest and the original alone', () => {
    const before = { title: 'x', alerts: { a: { acknowledged: null, n: 1 }, b: { n: 2 } } as Record<string, Record<string, unknown>> | null };
    const after = applyPatchObject(before, { title: 'y', 'alerts/a/acknowledged': 'now', 'alerts/b': null, 'alerts/c~1d': { n: 3 } });
    expect(after).toEqual({ title: 'y', alerts: { a: { acknowledged: 'now', n: 1 }, 'c/d': { n: 3 } } });
    expect(before.alerts!.a.acknowledged).toBeNull();
    expect(patchPath('a/b', 'c~d')).toBe('a~1b/c~0d');
    expect(applyPatchObject({ alerts: null }, { 'alerts/x': { n: 1 } })).toEqual({ alerts: { x: { n: 1 } } });
  });
});

describe('snoozeTimes', () => {
  const work: WorkingTime = { startHour: 8, endHour: 17, workingDays: [1, 2, 3, 4, 5], firstDayOfWeek: 1 };
  // Friday 30.10.2026, 15:00 on the wall clock (display dates as real ones here).
  const friday = new Date(2026, 9, 30, 15, 0);
  const due = (d: Date | null) => ({ due: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00` : null });

  it('offers minutes from now, the next working morning, next week\'s first morning and the due day\'s', () => {
    const times = snoozeTimes(due(new Date(2026, 10, 4)), friday, friday, work);
    expect(times.map((x) => [x.choice, x.at])).toEqual([
      ['5m', new Date(2026, 9, 30, 15, 5)],
      ['15m', new Date(2026, 9, 30, 15, 15)],
      ['1h', new Date(2026, 9, 30, 16, 0)],
      ['4h', new Date(2026, 9, 30, 19, 0)],
      // Tomorrow is a Saturday: the next working day, as the follow-up's "Tomorrow".
      ['tomorrow', new Date(2026, 10, 2, 8, 0)],
      ['next-week', new Date(2026, 10, 2, 8, 0)],
      ['due-day', new Date(2026, 10, 4, 8, 0)],
    ]);
    expect(times.some((x) => x.choice === DEFAULT_SNOOZE)).toBe(true);
  });

  it('leaves out the due day without one, or once its morning has passed', () => {
    const choices = (task: { due: string | null }) => snoozeTimes(task, friday, friday, work).map((x) => x.choice);
    expect(choices(due(null))).not.toContain('due-day');
    expect(choices(due(new Date(2026, 9, 30)))).not.toContain('due-day');
    expect(choices(due(new Date(2026, 9, 20)))).not.toContain('due-day');
    // Due today, but before work starts: still to come.
    const early = new Date(2026, 9, 30, 6, 0);
    expect(snoozeTimes(due(new Date(2026, 9, 30)), early, early, work).find((x) => x.choice === 'due-day')?.at)
      .toEqual(new Date(2026, 9, 30, 8, 0));
  });

  it('turns the wall-clock mornings into real instants, the minutes counted from the real now', () => {
    const shift = (d: Date) => new Date(d.getTime() - 60 * 60_000);
    const real = new Date('2026-10-30T14:00:00Z');
    const times = snoozeTimes(due(null), real, friday, work, shift);
    expect(times.find((x) => x.choice === '5m')?.at).toEqual(new Date('2026-10-30T14:05:00Z'));
    expect(times.find((x) => x.choice === 'tomorrow')?.at).toEqual(shift(new Date(2026, 10, 2, 8, 0)));
  });
});
