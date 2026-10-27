import type { TaskPerson } from "@/lib/group-follow-ups";
import { perStoreEpoch } from "@/lib/store-epoch";
import { dayOfIso, isoDay, parseDate } from "@/lib/task-dates";
import {
  type FollowUpDetails,
} from "@/lib/follow-ups";
import { NO_ANSWER_CHOICES, scheduleNoAnswer, type NoAnswerChoice, type WorkingTime } from "@/lib/follow-up-schedule";

/**
 * "⚑ Follow up" in the composer: what the user chose
 * for the mail being written, kept with the composer's draft until it is
 * sent, and turned into a follow-up on its sent copy once it has left.
 *
 * - A no-answer choice ("Remind me if no answer by Thu"): a follow-up in the
 *   user's own task list, due three working days or a week after the day the
 *   mail goes out, reminded when that day's work starts, settling itself
 *   when an answer comes. From a group mailbox too: then only the user's
 *   ("only me"), nothing set on the group's mail.
 * - "Custom …": the follow-up dialog's choices, made before sending (the
 *   mail does not exist yet), written as the dialog would on the sent copy;
 *   from a group mailbox the dialog may put it into the group's task list.
 *
 * Everything here is plain data, so it survives a composer remount, a Pro
 * tab's stored draft and a JSON round trip: days as "yyyy-MM-dd", instants
 * as ISO strings.
 */
export type SendFollowUp =
  | { choice: NoAnswerChoice }
  | { choice: "custom"; details: SendFollowUpDetails };

/** The dialog's `FollowUpDetails`, as plain data. */
export interface SendFollowUpDetails {
  action: string;
  /** The due day, "yyyy-MM-dd", or null for none. */
  due: string | null;
  /** The reminder, an ISO instant, or null for none. */
  reminderAt: string | null;
  note: string;
  mailReminder?: boolean;
  settlesOnReply?: boolean;
  /** The group account whose task list takes it; null: the user's own. */
  groupAccountId?: string | null;
  /** Whom it is for in a group's list; null: the user. */
  person?: TaskPerson | null;
}

/** The dialog's choices as plain data. */
export function storedDetails(details: FollowUpDetails): SendFollowUpDetails {
  return {
    action: details.action,
    due: details.due ? isoDay(details.due) : null,
    reminderAt: details.reminderAt ? details.reminderAt.toISOString() : null,
    note: details.note,
    ...(details.mailReminder !== undefined ? { mailReminder: details.mailReminder } : {}),
    ...(details.settlesOnReply !== undefined ? { settlesOnReply: details.settlesOnReply } : {}),
    groupAccountId: details.groupAccountId ?? null,
    ...(details.person !== undefined ? { person: details.person } : {}),
  };
}

/** Plain data back as the dialog's choices. */
export function detailsOf(stored: SendFollowUpDetails): FollowUpDetails {
  return {
    action: stored.action,
    due: dayOfIso(stored.due),
    reminderAt: parseDate(stored.reminderAt),
    note: stored.note,
    ...(stored.mailReminder !== undefined ? { mailReminder: stored.mailReminder } : {}),
    ...(stored.settlesOnReply !== undefined ? { settlesOnReply: stored.settlesOnReply } : {}),
    groupAccountId: stored.groupAccountId ?? null,
    ...(stored.person !== undefined ? { person: stored.person } : {}),
  };
}

/**
 * What the follow-up of a sent mail is to say. A no-answer choice is counted
 * from `sent`, the display date the mail goes out (now, or a later time it
 * was scheduled for), so its reminder never lies before the mail left; it
 * is the user's own and settles itself when an answer comes. `toInstant`
 * turns a display date into the real instant (lib/timezone.ts).
 */
export function sendFollowUpDetails(
  followUp: SendFollowUp,
  sent: Date,
  work: WorkingTime,
  action: string,
  toInstant: (displayDate: Date) => Date,
): FollowUpDetails {
  if (followUp.choice === "custom") return detailsOf(followUp.details);
  const { due, reminder } = scheduleNoAnswer(followUp.choice, sent, work);
  return {
    action,
    due,
    reminderAt: reminder ? toInstant(reminder) : null,
    note: "",
    settlesOnReply: true,
    groupAccountId: null,
  };
}

/** A value read back from a stored draft, when it is one this module wrote; else null. */
export function readSendFollowUp(value: unknown): SendFollowUp | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if ((NO_ANSWER_CHOICES as readonly unknown[]).includes(v.choice)) return { choice: v.choice as NoAnswerChoice };
  if (v.choice !== "custom" || !v.details || typeof v.details !== "object") return null;
  const d = v.details as Record<string, unknown>;
  if (typeof d.action !== "string" || typeof d.note !== "string") return null;
  if (d.due !== null && dayOfIso(d.due) === null) return null;
  if (d.reminderAt !== null && parseDate(d.reminderAt) === null) return null;
  const person = d.person;
  const validPerson = person === undefined || person === null
    || (typeof person === "object" && typeof (person as TaskPerson).email === "string" && typeof (person as TaskPerson).name === "string");
  if (!validPerson) return null;
  return {
    choice: "custom",
    details: {
      action: d.action,
      due: d.due as string | null,
      reminderAt: d.reminderAt as string | null,
      note: d.note,
      ...(typeof d.mailReminder === "boolean" ? { mailReminder: d.mailReminder } : {}),
      ...(typeof d.settlesOnReply === "boolean" ? { settlesOnReply: d.settlesOnReply } : {}),
      groupAccountId: typeof d.groupAccountId === "string" ? d.groupAccountId : null,
      ...(person !== undefined ? { person: person as TaskPerson | null } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Kept with a draft for the session
// ---------------------------------------------------------------------------

/**
 * The choice of each draft saved on the server, by its Email id, for this
 * session: reopening the draft (or a send undone, which puts the mail back
 * as a draft under the same id) gives the composer its choice back. The
 * server's draft carries nothing of it, so a draft reopened after a reload,
 * or in another client, starts without one. Forgotten when another account
 * comes on screen.
 */
const byDraft = perStoreEpoch(() => new Map<string, SendFollowUp | null>());
const MAX_KEPT = 200;

export function rememberDraftFollowUp(draftId: string | null | undefined, followUp: SendFollowUp | null): void {
  if (!draftId) return;
  const drafts = byDraft();
  drafts.delete(draftId);
  if (!followUp) return;
  drafts.set(draftId, followUp);
  while (drafts.size > MAX_KEPT) drafts.delete(drafts.keys().next().value as string);
}

export function draftFollowUp(draftId: string | null | undefined): SendFollowUp | null {
  return (draftId && byDraft().get(draftId)) || null;
}

/** Forget every draft's choice (tests). */
export function resetDraftFollowUps(): void {
  byDraft().clear();
}
