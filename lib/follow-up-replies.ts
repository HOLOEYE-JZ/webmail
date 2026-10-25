import type { CalendarRelation, CalendarTask } from "@/lib/jmap/types";
import { stripMessageIdBrackets } from "@/lib/email-threading";
import { patchPath } from "@/lib/jmap/patch-object";
import { parseDate, utcDateTime } from "@/lib/task-dates";
import { isOpenTask, isRecurringTask } from "@/lib/calendar-tasks";

/**
 * Follow-ups that settle themselves when an answer comes (plan 037 decision
 * 9, Gmail's nudge the other way round): before Bulwark shows such a
 * reminder, and when it loads the tasks, it looks in the mail's thread for an
 * answer; one found completes the task, and no reminder comes.
 *
 * An answer is a mail of the thread that names the flagged mail's Message-ID
 * in its In-Reply-To or References, and that came in: received after the
 * flagged mail (and after an answer that settled the task before, so one
 * reopened is not settled again by the same answer), not a draft, not only
 * in the Sent or Drafts folder, and not from one of the account's own
 * addresses (the user's identities; in a group mailbox the group's address
 * too). A mail the user sent (a nudge "any news?", filed into another
 * folder or come back as a Cc copy) names the mail too, and is no answer.
 *
 * Why the thread: Stalwart's `header` search finds nothing where `headers`
 * is not among its indexed fields (plan 037 M3), and matches tokens where it
 * is; the thread holds the answers, and each one's headers are read and
 * compared here. An answer whose subject changed so much that the server put
 * it in a thread of its own is not found: the reminder comes.
 *
 * Whether a task settles itself is a mark on it, its reply watch
 * (`REPLY_WATCH_PROPERTY`), written and read below.
 *
 * Pure: the hook `use-follow-up-replies` asks the server.
 */

// ---------------------------------------------------------------------------
// The mark on the task
// ---------------------------------------------------------------------------

/**
 * "Settles itself when an answer comes" (plan 037 decision 9), kept on the
 * task's relation to the mail's Message-ID (`relatedTo`) as an RFC 8984 §3.3
 * vendor-specific property: the Message-ID is what an answer names, so the
 * mark belongs to it. Its value is a `ReplyWatchValue`.
 *
 * Why there: such a task gets no alert at all (an alert reaches the phone,
 * which knows nothing of answers, and Stalwart sends an alarm mail even for a
 * task answered meanwhile), so the reminder's time, and whether it was
 * dismissed, live in the mark too. A vendor property on the task itself is
 * refused by Stalwart (plan 037 M2); on the relation it is kept, written and
 * patched by path, and goes to iCalendar as `JSPROP`
 * (draft-ietf-calext-jscalendar-icalendar), which a CalDAV client that keeps
 * unknown properties writes back. A keyword would become a category a phone
 * shows; a link a URL some phones open. Where a client drops it, the task is
 * a plain follow-up without a reminder.
 */
export const REPLY_WATCH_PROPERTY = "bulwarkmail.org:settlesOnReply";

/**
 * The id the reminders window gives a reply watch's reminder, which is no
 * alert of the task (`replyWatch`). An alert's key is an RFC 8984 Id, which
 * never holds a NUL.
 */
export const REPLY_WATCH_ALERT_ID = "\u0000settles-on-reply";

/** What `REPLY_WATCH_PROPERTY` holds; every member optional, times as UTCDateTime. */
export interface ReplyWatchValue {
  /** When Bulwark reminds, unless an answer came; null for no reminder. */
  reminder?: string | null;
  /** When that reminder was dismissed (as an alert's `acknowledged`). */
  acknowledged?: string | null;
  /** When the answer that settled it came: one that came by then never settles it again. */
  answeredAt?: string | null;
  /**
   * Turned off in the dialog after an answer had settled it: kept only for
   * `answeredAt`, so turned on again the same answer does not settle it
   * again. Such a value is no watch (`replyWatch`).
   */
  off?: boolean;
}

/** A follow-up that settles itself when an answer comes, as read from the task. */
export interface ReplyWatch {
  /** The `relatedTo` key it is kept on: the mail's Message-ID in angle brackets. */
  key: string;
  /** The mail's Message-ID, without angle brackets. */
  messageId: string;
  reminder: Date | null;
  acknowledged: string | null;
  answeredAt: string | null;
}

/** A Message-ID without its angle brackets, as JMAP's `messageId` gives it. */
export function bareMessageId(messageId: string | readonly string[] | null | undefined): string | null {
  const first = Array.isArray(messageId) ? messageId[0] : messageId;
  if (typeof first !== "string") return null;
  return stripMessageIdBrackets(first) || null;
}

/** The relation to the mail's Message-ID, with a reply watch when one is given. */
export function mailRelation(watch: ReplyWatchValue | null): CalendarRelation {
  return {
    "@type": "Relation",
    relation: { parent: true },
    ...(watch ? { [REPLY_WATCH_PROPERTY]: watch } : {}),
  } as CalendarRelation;
}

/** A new reply watch reminding at `reminderAt` (null: never). */
export function watchValue(
  reminderAt: Date | null,
  answeredAt: string | null = null,
  acknowledged: string | null = null,
): ReplyWatchValue {
  return { reminder: reminderAt ? utcDateTime(reminderAt) : null, acknowledged, answeredAt };
}

/** The raw value of `REPLY_WATCH_PROPERTY` on the relation `key`, a watch turned off too; null for none. */
export function storedWatchValue(task: Partial<Pick<CalendarTask, "relatedTo">>, key: string): Record<string, unknown> | null {
  const value = (task.relatedTo?.[key] as unknown as Record<string, unknown> | undefined)?.[REPLY_WATCH_PROPERTY];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The task's reply watch (`REPLY_WATCH_PROPERTY`), or null when it does not
 * settle itself on an answer. Only an object counts: Stalwart keeps a member
 * set to null as null.
 */
export function replyWatch(task: Partial<Pick<CalendarTask, "relatedTo">>): ReplyWatch | null {
  for (const [key, relation] of Object.entries(task.relatedTo ?? {})) {
    if (relation?.relation && !relation.relation.parent) continue;
    const value = (relation as unknown as Record<string, unknown> | null)?.[REPLY_WATCH_PROPERTY];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if ((value as ReplyWatchValue).off === true) continue;
    const messageId = bareMessageId(key);
    if (!messageId) continue;
    const v = value as Record<string, unknown>;
    return {
      key,
      messageId,
      reminder: parseDate(v.reminder),
      acknowledged: typeof v.acknowledged === "string" ? v.acknowledged : null,
      answeredAt: typeof v.answeredAt === "string" ? v.answeredAt : null,
    };
  }
  return null;
}

/** The patch path of the reply watch kept on `key`, or of one of its members. */
export function replyWatchPath(key: string, member?: keyof ReplyWatchValue): string {
  return patchPath("relatedTo", key, REPLY_WATCH_PROPERTY, ...(member ? [member] : []));
}

/** Whether a follow-up settles itself when an answer comes (`replyWatch`). */
export function settlesOnReply(task: Partial<Pick<CalendarTask, "relatedTo">>): boolean {
  return replyWatch(task) !== null;
}

// ---------------------------------------------------------------------------
// Looking for the answer
// ---------------------------------------------------------------------------

/** A mail of the flagged mail's thread, with the properties the check reads. */
export interface ThreadMail {
  id: string;
  messageId?: readonly string[] | null;
  inReplyTo?: readonly string[] | null;
  references?: readonly string[] | null;
  receivedAt?: string | null;
  mailboxIds?: Readonly<Record<string, boolean>> | null;
  keywords?: Readonly<Record<string, boolean>> | null;
  from?: readonly { email?: string | null }[] | null;
}

/** The properties `findReply` reads, for an `Email/get`. */
export const THREAD_MAIL_PROPERTIES = ["messageId", "inReplyTo", "references", "receivedAt", "mailboxIds", "keywords", "from"] as const;

const bare = (id: unknown) => (typeof id === "string" ? stripMessageIdBrackets(id) : "");

const time = (value: string | null | undefined): number | null => parseDate(value)?.getTime() ?? null;

export interface FindReplyInput {
  /** The flagged mail's Message-ID, without angle brackets. */
  messageId: string;
  /** The flagged mail: its Email id and when it was received. */
  flagged: { id: string; receivedAt?: string | null };
  /** The mails of its thread (the flagged one among them is skipped). */
  mails: readonly ThreadMail[];
  /** The ids of the account's Sent and Drafts folders: a mail only there was not received. */
  ownFolderIds: ReadonlySet<string>;
  /** An answer that settled the task before: only one received after it counts. */
  after?: string | null;
  /** The account's own addresses, in lower case: a mail from one of them was sent, not received. */
  ownAddresses?: ReadonlySet<string>;
}

/** The first answer to the flagged mail among `mails`, or null. */
export function findReply(input: FindReplyInput): ThreadMail | null {
  const wanted = bare(input.messageId);
  if (!wanted) return null;
  const since = Math.max(time(input.flagged.receivedAt) ?? -Infinity, time(input.after) ?? -Infinity);
  let found: ThreadMail | null = null;
  for (const mail of input.mails) {
    if (mail.id === input.flagged.id) continue;
    // Another copy of the flagged mail itself (a second folder, a re-import).
    if (mail.messageId?.some((id) => bare(id) === wanted)) continue;
    const names = [...(mail.inReplyTo ?? []), ...(mail.references ?? [])].some((id) => bare(id) === wanted);
    if (!names) continue;
    const received = time(mail.receivedAt);
    if (received === null || received <= since) continue;
    if (mail.keywords?.$draft) continue;
    if (mail.from?.some((a) => !!a.email && !!input.ownAddresses?.has(a.email.trim().toLowerCase()))) continue;
    const folders = Object.keys(mail.mailboxIds ?? {}).filter((id) => mail.mailboxIds?.[id]);
    if (folders.length === 0 || folders.every((id) => input.ownFolderIds.has(id))) continue;
    if (!found || received < (time(found.receivedAt) ?? Infinity)) found = mail;
  }
  return found;
}

/** Whether a task is one whose thread the check looks at: open, the user's own, a mail's, settling on an answer. */
export function watchesForReply(task: CalendarTask): ReplyWatch | null {
  if (task.isShared || !isOpenTask(task) || isRecurringTask(task)) return null;
  return replyWatch(task);
}

/** How long a task's thread is not looked at again after a push. */
export const PUSH_RECHECK_MS = 60_000;
/** How long a task's thread is not looked at again at all, push or not. */
export const RECHECK_MS = 15 * 60_000;

/**
 * The tasks whose thread is to be looked at now:
 *
 * - one not looked at yet since the app loaded the tasks;
 * - one whose reminder fell due after it was last looked at (it is held
 *   back until then);
 * - one not looked at since a push came (a mail may have come), at most once
 *   a minute;
 * - any other every quarter of an hour.
 *
 * `fireTime` gives the time the task's reminder fell due (null: none due).
 */
export function replyChecksDue(
  tasks: readonly CalendarTask[],
  nowMs: number,
  checkedAt: (taskId: string) => number | undefined,
  fireTime: (task: CalendarTask) => number | null,
  lastPushMs: number | null,
): CalendarTask[] {
  return tasks.filter((task) => {
    if (!watchesForReply(task)) return false;
    const last = checkedAt(task.id);
    if (last === undefined) return true;
    const fires = fireTime(task);
    if (fires !== null && fires <= nowMs && last < fires) return true;
    if (lastPushMs !== null && lastPushMs > last && nowMs - last >= PUSH_RECHECK_MS) return true;
    return nowMs - last >= RECHECK_MS;
  });
}
