/**
 * Keeping a follow-up and its mail's $flagged in step. The task is the
 * original, the flag its mirror (lib/follow-ups.ts); the hook
 * `use-follow-up-sync` reads both sides and carries out what is planned here.
 *
 * Pure.
 */

/**
 * A follow-up last seen open while its mail was flagged, as of the task's
 * `updated` then. It tells which side moved when the two disagree later: a
 * task still as it was whose mail lost the flag had the flag cleared
 * elsewhere; a task that changed since was reopened or edited elsewhere.
 */
export interface FollowUpMirrorEntry {
  emailId: string;
  calendarId: string;
  updated: string | null;
}

/** The entries by task id, for the user's own mail account. */
export type FollowUpMirror = Record<string, FollowUpMirrorEntry>;

/** One follow-up as the check sees it. */
export interface FollowUpSyncTask {
  id: string;
  emailId: string;
  calendarId: string;
  open: boolean;
  updated: string | null;
  /** As the server gave it, not changed in the browser since. Only those are remembered. */
  fresh: boolean;
}

export type FollowUpSyncAction =
  /**
   * Set or clear the mail's $flagged for the follow-up `taskId`. `taskGone`:
   * cleared because the task is no longer in the list.
   */
  | { kind: "flag"; taskId: string; emailId: string; flagged: boolean; taskGone?: true }
  /**
   * The open task is completed: the user took the star off in this app, or
   * (`flagClearedElsewhere`) the flag was cleared in another client. The
   * check never deletes a task.
   */
  | { kind: "complete-task"; taskId: string; emailId: string; flagClearedElsewhere?: true };

/**
 * Whether an action acts on the strength of what the task list lacks or the
 * flag no longer says: it waits for a complete task list loaded just before,
 * so a task another tab or device changed a moment ago is seen as it is now.
 */
export function waitsForFreshTasks(action: FollowUpSyncAction): boolean {
  return action.kind === "complete-task" ? !!action.flagClearedElsewhere : !!action.taskGone;
}

export interface FollowUpSyncInput {
  /** The follow-ups, at most one per mail (`followUpsByEmailId`). */
  tasks: readonly FollowUpSyncTask[];
  /** The id of every task the task list holds now. */
  present: ReadonlySet<string>;
  /** Whether the task list holds every task of a calendar (it was loaded). */
  listed: (calendarId: string) => boolean;
  /** Each checked mail's $flagged; null for a mail that is gone. Mails not checked are left alone. */
  flags: ReadonlyMap<string, boolean | null>;
  mirror: FollowUpMirror;
  /**
   * Mails the user took the star off in this app (this session): their open
   * follow-up is completed, also one never seen in step here.
   */
  unstarredHere?: ReadonlySet<string>;
}

/**
 * What keeps the mails' $flagged and their follow-ups in step. The task is
 * the original, the flag its mirror:
 *
 * - A task completed or deleted clears the flag; one reopened sets it.
 * - A flag cleared elsewhere (another client, a phone) completes the open
 *   task, unless the task changed since it was last seen in step (then the
 *   task wins and the flag is set). Nothing here ever deletes a task, so a
 *   flag cleared in another tab whose own write of the task is late or
 *   failed only completes what that tab meant to complete.
 * - A flag set elsewhere on a mail without an open follow-up stays a plain
 *   flag.
 * - A mail that is gone changes nothing; its task stays.
 *
 * Returns the actions and the mirror to keep afterwards.
 */
export function planFollowUpSync(input: FollowUpSyncInput): { actions: FollowUpSyncAction[]; mirror: FollowUpMirror } {
  const mirror: FollowUpMirror = { ...input.mirror };
  const actions: FollowUpSyncAction[] = [];
  const decided = new Set<string>();

  for (const task of input.tasks) {
    decided.add(task.id);
    const flagged = input.flags.get(task.emailId);
    if (flagged === undefined) continue;
    const seen = input.mirror[task.id];
    if (flagged === null) {
      delete mirror[task.id];
      continue;
    }
    if (task.open && flagged) {
      if (task.fresh) mirror[task.id] = { emailId: task.emailId, calendarId: task.calendarId, updated: task.updated };
    } else if (task.open && input.unstarredHere?.has(task.emailId)) {
      actions.push({ kind: "complete-task", taskId: task.id, emailId: task.emailId });
    } else if (task.open) {
      if (seen && seen.emailId === task.emailId && seen.updated === task.updated) {
        // Kept until the completion is written; the next check forgets it.
        actions.push({ kind: "complete-task", taskId: task.id, emailId: task.emailId, flagClearedElsewhere: true });
      } else {
        // New, reopened, moved to another day, or never seen in step here.
        // Known limit: a browser without the entry (a new one, or storage
        // cleared) cannot tell a flag cleared elsewhere from a task reopened
        // elsewhere, so it sets the flag again rather than complete the task;
        // a flag cleared before its first check comes back once. That errs
        // on the side that loses nothing.
        actions.push({ kind: "flag", taskId: task.id, emailId: task.emailId, flagged: true });
      }
    } else {
      // Completed: a flag it still mirrors goes; a flag set after it stays.
      if (flagged && seen) actions.push({ kind: "flag", taskId: task.id, emailId: task.emailId, flagged: false });
      delete mirror[task.id];
    }
  }

  // Remembered follow-ups the list no longer holds were deleted.
  for (const [taskId, seen] of Object.entries(input.mirror)) {
    if (decided.has(taskId) || input.present.has(taskId)) continue;
    if (!input.listed(seen.calendarId)) continue;
    const flagged = input.flags.get(seen.emailId);
    if (flagged === undefined) continue;
    // Another open follow-up on the same mail keeps the flag.
    const stillFollowedUp = input.tasks.some((t) => t.emailId === seen.emailId && t.open);
    if (flagged && !stillFollowedUp) actions.push({ kind: "flag", taskId, emailId: seen.emailId, flagged: false, taskGone: true });
    delete mirror[taskId];
  }

  // One write per mail: of conflicting wishes, the open follow-up's wins.
  const byMail = new Map<string, FollowUpSyncAction>();
  for (const action of actions) {
    const other = byMail.get(action.emailId);
    if (!other || (other.kind === "flag" && !other.flagged)) byMail.set(action.emailId, action);
  }
  return { actions: [...byMail.values()], mirror };
}

/** The mirror kept in the browser, read back defensively. */
export function parseFollowUpMirror(raw: string | null): FollowUpMirror {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const mirror: FollowUpMirror = {};
    for (const [taskId, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as Partial<FollowUpMirrorEntry> | null;
      if (!e || typeof e.emailId !== "string" || typeof e.calendarId !== "string") continue;
      mirror[taskId] = { emailId: e.emailId, calendarId: e.calendarId, updated: typeof e.updated === "string" ? e.updated : null };
    }
    return mirror;
  } catch {
    return {};
  }
}
