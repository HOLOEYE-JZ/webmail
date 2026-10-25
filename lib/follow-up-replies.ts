import type { CalendarTask } from "@/lib/jmap/types";
import { stripMessageIdBrackets } from "@/lib/email-threading";
import { parseDate } from "@/lib/task-dates";
import { completedTaskPatch, type TaskPatch } from "@/lib/task-reminders";
import {
  isHtmlNote,
  isOpenFollowUp,
  isRecurringTask,
  replyWatch,
  replyWatchPath,
  type ReplyWatch,
} from "@/lib/follow-ups";

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
 * Pure: the hook `use-follow-up-replies` asks the server.
 */

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
  if (task.isShared || !isOpenFollowUp(task) || isRecurringTask(task)) return null;
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

/**
 * The patch that completes a task an answer settled: completed as Mark
 * Complete does (`completedTaskPatch`), the answer's time kept in the watch,
 * and `note` ("Answer received on …", in the user's language) added as a line
 * of its own below the task's note, which stays as it was. An HTML note is
 * left alone (it belongs to the client that wrote it).
 */
export function answeredTaskPatch(task: CalendarTask, watch: ReplyWatch, answeredAt: string, note: string, now: Date): TaskPatch {
  const patch: TaskPatch = {
    ...completedTaskPatch(task, now),
    [replyWatchPath(watch.key, "answeredAt") as `relatedTo/${string}`]: answeredAt,
  };
  if (!isHtmlNote(task) && note.trim()) {
    const before = (task.description ?? "").trimEnd();
    patch.description = before ? `${before}\n${note.trim()}` : note.trim();
  }
  return patch;
}
