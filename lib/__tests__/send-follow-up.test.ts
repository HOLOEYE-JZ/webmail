// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_TIME, scheduleNoAnswer } from '../follow-ups';
import {
  detailsOf,
  draftFollowUp,
  readSendFollowUp,
  rememberDraftFollowUp,
  resetDraftFollowUps,
  sendFollowUpDetails,
  storedDetails,
  type SendFollowUp,
} from '../send-follow-up';

// The composer's "Follow up" (plan 037 decision 10): a sent mail comes back
// when no answer came by a day, counted from the day it goes out.

const at = (day: number, hour = 9, minute = 0) => new Date(2026, 9, day, hour, minute);
const identity = (d: Date) => d;

describe('scheduleNoAnswer', () => {
  it('three working days on, reminded when that day starts', () => {
    // Monday 26.10. -> Thursday 29.10. 08:00
    expect(scheduleNoAnswer('three-workdays', at(26))).toEqual({ due: new Date(2026, 9, 29), reminder: at(29, 8) });
    // Friday 30.10. -> Wednesday 04.11., the weekend skipped
    expect(scheduleNoAnswer('three-workdays', at(30)).due).toEqual(new Date(2026, 10, 4));
    // Sent on a Saturday: Monday is the first of the three.
    expect(scheduleNoAnswer('three-workdays', at(31)).due).toEqual(new Date(2026, 10, 4));
  });

  it('a week on, the next working day when that is none', () => {
    expect(scheduleNoAnswer('week', at(26))).toEqual({ due: new Date(2026, 10, 2), reminder: new Date(2026, 10, 2, 8) });
    // Saturday 31.10. -> Saturday 07.11. -> Monday 09.11.
    expect(scheduleNoAnswer('week', at(31)).due).toEqual(new Date(2026, 10, 9));
  });

  it('follows the working days and the start of work', () => {
    const work = { ...DEFAULT_WORKING_TIME, startHour: 7, workingDays: [1, 2, 3, 4] };
    // Thursday 29.10.: Friday is no working day -> Mon, Tue, Wed.
    expect(scheduleNoAnswer('three-workdays', at(29), work)).toEqual({ due: new Date(2026, 10, 4), reminder: new Date(2026, 10, 4, 7) });
  });
});

describe('sendFollowUpDetails', () => {
  it('a no-answer choice is the user\'s own and settles itself on an answer', () => {
    expect(sendFollowUpDetails({ choice: 'three-workdays' }, at(26), DEFAULT_WORKING_TIME, 'Follow up', identity)).toEqual({
      action: 'Follow up',
      due: new Date(2026, 9, 29),
      reminderAt: at(29, 8),
      note: '',
      settlesOnReply: true,
      groupAccountId: null,
    });
  });

  it('counts from the time a mail scheduled for later goes out', () => {
    const later = sendFollowUpDetails({ choice: 'week' }, at(30, 14), DEFAULT_WORKING_TIME, 'Follow up', identity);
    expect(later.due).toEqual(new Date(2026, 10, 6));
  });

  it('a custom choice is the dialog\'s, as it was chosen', () => {
    const details = {
      action: 'Call',
      due: new Date(2026, 10, 3),
      reminderAt: new Date('2026-11-03T09:30:00Z'),
      note: 'ask for the order',
      mailReminder: true,
      settlesOnReply: false,
      groupAccountId: 'grp',
      person: { id: 'p2', name: 'Anna', email: 'anna@example.com' },
    };
    const followUp: SendFollowUp = { choice: 'custom', details: storedDetails(details) };
    expect(sendFollowUpDetails(followUp, at(26), DEFAULT_WORKING_TIME, 'Follow up', identity)).toEqual(details);
  });
});

describe('storedDetails / readSendFollowUp', () => {
  it('survive a JSON round trip (a Pro tab\'s stored draft)', () => {
    const details = { action: 'Reply', due: null, reminderAt: null, note: '', groupAccountId: null, person: null };
    const value: SendFollowUp = { choice: 'custom', details: storedDetails(details) };
    const back = readSendFollowUp(JSON.parse(JSON.stringify(value)));
    expect(back).toEqual(value);
    expect(detailsOf((back as Extract<SendFollowUp, { choice: 'custom' }>).details)).toEqual(details);
    expect(readSendFollowUp({ choice: 'week' })).toEqual({ choice: 'week' });
  });

  it('reads nothing it did not write', () => {
    expect(readSendFollowUp(undefined)).toBeNull();
    expect(readSendFollowUp({ choice: 'tomorrow' })).toBeNull();
    expect(readSendFollowUp({ choice: 'custom' })).toBeNull();
    expect(readSendFollowUp({ choice: 'custom', details: { action: 'x', note: '', due: '29.10.', reminderAt: null } })).toBeNull();
    expect(readSendFollowUp({ choice: 'custom', details: { action: 'x', note: '', due: null, reminderAt: 'soon' } })).toBeNull();
  });
});

describe('a draft\'s choice for the session', () => {
  beforeEach(() => resetDraftFollowUps());

  it('is kept by the draft id and forgotten with none', () => {
    rememberDraftFollowUp('d1', { choice: 'week' });
    expect(draftFollowUp('d1')).toEqual({ choice: 'week' });
    rememberDraftFollowUp('d1', null);
    expect(draftFollowUp('d1')).toBeNull();
    rememberDraftFollowUp(null, { choice: 'week' });
    expect(draftFollowUp(null)).toBeNull();
  });
});
