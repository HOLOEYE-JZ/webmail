"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { onStarToggled, useEmailStore } from "@/stores/email-store";
import { useTaskStore } from "@/stores/task-store";
import { debug } from "@/lib/debug";
import { reachesMailAccount } from "@/lib/deep-links";
import { stripMessageIdBrackets } from "@/lib/email-threading";
import { perStoreEpoch } from "@/lib/store-epoch";
import { completedTaskPatch } from "@/lib/task-reminders";
import {
  addFollowUpSender,
  followUpMailRef,
  followUpMailSummary,
  followUpMessageId,
  followUpsByEmailId,
  relinkFollowUpTask,
} from "@/lib/follow-ups";
import { isOpenTask } from "@/lib/calendar-tasks";
import {
  parseFollowUpMirror,
  planFollowUpSync,
  waitsForFreshTasks,
  type FollowUpMirror,
  type FollowUpSyncAction,
  type FollowUpSyncTask,
} from "@/lib/follow-up-sync";
import type { CalendarTask, EmailAddress } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import {
  forgetUnstarredHere,
  isFollowUpPending,
  isOwnMail,
  markUnstarredHere,
  mirrorFlag,
  onFollowUpChanged,
  unstarredHereMails,
  useFollowUpsEnabled,
} from "./use-follow-ups";

/**
 * Keeps each follow-up and its mail's $flagged in step, whatever changed
 * them: Bulwark's task list, a phone's task app, another mail client.
 * See `planFollowUpSync` for the rules.
 */

/** After the task list changed (a fetch, a task written here). */
const TASKS_DELAY_MS = 300;
/** After a push, which comes in bursts. */
const PUSH_DELAY_MS = 1000;

function mirrorKey(loginId: string | null, mailAccountId: string): string {
  return `follow-up-mirror:${loginId ?? ""}:${mailAccountId}`;
}

function readMirror(key: string): FollowUpMirror {
  try {
    return parseFollowUpMirror(localStorage.getItem(key));
  } catch {
    return {};
  }
}

function writeMirror(key: string, mirror: FollowUpMirror): void {
  try {
    if (Object.keys(mirror).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(mirror));
  } catch {
    // Storage full or blocked: the check falls back to "the task wins".
  }
}

// Task objects as a fetch gave them; a task changed here since is a new object.
const fetched = new WeakSet<CalendarTask>();
// Flag writes a plugin refused, not asked for again while the same accounts
// are on screen (task and mail ids mean nothing in another login's).
const refused = perStoreEpoch(() => new Set<string>());
// The tasks whose mail, gone by id, was looked for by its Message-ID.
const searched = perStoreEpoch(() => new Set<string>());
// While the check reloads the task list itself; that load starts no new check.
let ownFetches = 0;

function refusalKey(action: FollowUpSyncAction, task: FollowUpSyncTask | undefined): string {
  const what = action.kind === "flag" ? `flag:${action.flagged}` : action.kind;
  return `${what}:${action.taskId}:${task?.updated ?? ""}:${action.emailId}`;
}

/**
 * The id of the mail with this Message-ID in the user's own account, or null.
 * Works where the server searches the header (Stalwart only with `headers`
 * among its indexed fields); each hit is confirmed by its `messageId`, as a
 * header search may match on tokens.
 */
async function findByMessageId(client: IJMAPClient, messageId: string | null): Promise<string | null> {
  if (!messageId) return null;
  try {
    const hits = await client.queryEmailFields({ header: ["Message-ID", `<${messageId}>`] }, ["messageId"], undefined, 10);
    const hit = hits.find((h) => Array.isArray(h.messageId) && h.messageId.some((id) => typeof id === "string" && stripMessageIdBrackets(id) === messageId));
    return hit && typeof hit.id === "string" ? hit.id : null;
  } catch {
    return null;
  }
}

/** Points the task at the mail found again; the link keeps working from then on. */
async function relink(client: IJMAPClient, task: CalendarTask, emailId: string): Promise<void> {
  const patch = relinkFollowUpTask(task, emailId);
  if (!patch) return;
  try {
    await useTaskStore.getState().updateTask(client, task.id, patch);
  } catch (error) {
    debug.error("follow-up: link not updated", error);
  }
}

export type FollowUpMailState =
  | { kind: "checking" }
  | { kind: "present"; emailId: string }
  | { kind: "gone" }
  /** The server could not be asked; the link is offered as it is. */
  | { kind: "unknown"; emailId: string };

/**
 * Where a follow-up's mail is now: by its id (a mail moved to another folder
 * keeps it), else by its Message-ID (the task is pointed at it), else gone.
 */
export async function locateFollowUpMail(client: IJMAPClient, task: CalendarTask): Promise<FollowUpMailState> {
  const ref = followUpMailRef(task);
  if (!ref) return { kind: "gone" };
  try {
    const [found] = await client.getEmailFields([ref.emailId], ["id"], ref.accountId ?? undefined);
    if (found) return { kind: "present", emailId: ref.emailId };
  } catch {
    return { kind: "unknown", emailId: ref.emailId };
  }
  const again = ref.accountId && ref.accountId !== client.getAccountId()
    ? null
    : await findByMessageId(client, followUpMessageId(task));
  if (!again) return { kind: "gone" };
  await relink(client, task, again);
  return { kind: "present", emailId: again };
}

/**
 * Where the mail of a task shown in the task dialog is; null for a task
 * without one, or whose mail lies in an account the login does not reach,
 * and while follow-ups are off.
 */
export function useFollowUpMail(task: CalendarTask | null | undefined): FollowUpMailState | null {
  const client = useAuthStore((s) => s.client);
  const enabled = useFollowUpsEnabled();
  const ref = enabled && task && !task.isShared ? followUpMailRef(task) : null;
  // The user's own mail, or a group mailbox's the login reaches.
  const ownMail = !!ref && reachesMailAccount(client, ref.accountId);
  const [state, setState] = useState<{ taskId: string; mail: FollowUpMailState } | null>(null);
  const taskId = task?.id;
  useEffect(() => {
    if (!client || !task || !ownMail) return;
    let cancelled = false;
    void locateFollowUpMail(client, task).then((mail) => {
      if (!cancelled) setState({ taskId: task.id, mail });
    });
    return () => { cancelled = true; };
    // Located once per task the dialog shows, not again for each edit of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, taskId, ownMail]);
  if (!task || !ownMail) return null;
  return state?.taskId === task.id ? state.mail : { kind: "checking" };
}

function calendarOf(task: CalendarTask): string {
  return Object.keys(task.calendarIds ?? {})[0] ?? "";
}

/**
 * One check: reads the flags of the mails with an open (or remembered)
 * follow-up, then sets or clears flags and completes tasks as
 * `planFollowUpSync` says. Exported for tests.
 */
export async function checkFollowUps(client: IJMAPClient, loginId: string | null, refetched = false): Promise<void> {
  const taskState = useTaskStore.getState();
  if (taskState.loadedBy !== client) return;
  const mailAccountId = client.getAccountId();
  const isBusy = (emailId: string) => isFollowUpPending(mailAccountId, emailId);
  const key = mirrorKey(loginId, mailAccountId);
  const mirror = readMirror(key);
  // A group mailbox's mail never carries the flag: its follow-ups are left out.
  const index = followUpsByEmailId(taskState.tasks, mailAccountId, mailAccountId);

  const tasks: FollowUpSyncTask[] = [];
  const taskByEmail = new Map<string, CalendarTask>();
  for (const [emailId, task] of index) {
    // A follow-up naming another account's mail is not this account's to mirror.
    const ref = followUpMailRef(task);
    if (ref?.accountId && ref.accountId !== mailAccountId) continue;
    taskByEmail.set(emailId, task);
    tasks.push({
      id: task.id,
      emailId,
      calendarId: calendarOf(task),
      open: isOpenTask(task),
      updated: task.updated ?? null,
      fresh: fetched.has(task),
    });
  }

  const watched = new Set<string>();
  for (const task of tasks) if (task.open || mirror[task.id]) watched.add(task.emailId);
  for (const entry of Object.values(mirror)) watched.add(entry.emailId);
  for (const emailId of watched) if (isBusy(emailId)) watched.delete(emailId);
  if (watched.size === 0) return;

  const fields = await client.getEmailFields([...watched], ["keywords", "from"]);
  const flags = new Map<string, boolean | null>([...watched].map((id) => [id, null]));
  const senders = new Map<string, EmailAddress | undefined>();
  for (const field of fields) {
    if (typeof field.id !== "string") continue;
    const keywords = field.keywords as Record<string, boolean> | undefined;
    flags.set(field.id, !!keywords?.$flagged);
    senders.set(field.id, (field.from as EmailAddress[] | undefined)?.[0]);
  }

  const present = new Set(taskState.tasks.filter((t) => !t.isShared && t.progress !== "cancelled").map((t) => t.id));
  const scope = taskState.fetchedCalendarIds;
  const plan = planFollowUpSync({
    tasks,
    present,
    listed: (calendarId) => !scope || scope.includes(calendarId),
    flags,
    mirror,
    unstarredHere: unstarredHereMails(mailAccountId),
  });
  const actions = plan.actions.filter((a) => !refused().has(refusalKey(a, tasks.find((t) => t.id === a.taskId))));

  // A task is completed for a flag cleared elsewhere, or a flag cleared for
  // a task gone, only on a complete task list loaded just now: another tab
  // or device may have changed the task a moment ago, and a list read only
  // in part lacks tasks that still exist.
  if (!refetched && actions.some(waitsForFreshTasks)) {
    ownFetches += 1;
    try {
      await useTaskStore.getState().fetchTasks(client, scope);
    } finally {
      ownFetches -= 1;
    }
    return checkFollowUps(client, loginId, true);
  }

  const next = plan.mirror;
  // A failed or refused action keeps what was remembered, so the next check tries again.
  const keep = (taskId: string) => {
    const before = mirror[taskId];
    if (before) next[taskId] = before;
  };
  for (const action of actions) {
    if (isBusy(action.emailId)) {
      keep(action.taskId);
      continue;
    }
    const task = tasks.find((t) => t.id === action.taskId);
    const refusal = refusalKey(action, task);
    try {
      if (action.kind === "complete-task") {
        if (action.flagClearedElsewhere) debug.log("tasks", "follow-up: flag cleared elsewhere, task completed", action.taskId);
        if (!(await completeForClearedFlag(client, action.taskId, action.emailId))) keep(action.taskId);
        continue;
      }
      const serverFlagged = flags.get(action.emailId) ?? undefined;
      const written = await mirrorFlag(client, { id: action.emailId, keywords: {} }, action.flagged, mailAccountId, serverFlagged);
      if (!written) {
        refused().add(refusal);
        keep(action.taskId);
      } else if (action.flagged && task?.fresh) {
        next[task.id] = { emailId: task.emailId, calendarId: task.calendarId, updated: task.updated };
      }
    } catch (error) {
      debug.error("follow-up: flag and task not brought in step", error);
      keep(action.taskId);
    }
  }
  writeMirror(key, next);

  // Tasks written before they kept the sender get it while the mail is there;
  // a mail gone by id is looked for once by its Message-ID.
  for (const [emailId, task] of taskByEmail) {
    if (!watched.has(emailId) || isBusy(emailId)) continue;
    const flag = flags.get(emailId);
    if (flag === null) {
      if (searched().has(task.id)) continue;
      searched().add(task.id);
      const again = await findByMessageId(client, followUpMessageId(task));
      if (again) await relink(client, task, again);
      continue;
    }
    if (followUpMailSummary(task).sender) continue;
    const patch = addFollowUpSender(task, senders.get(emailId));
    if (!patch) continue;
    try {
      await useTaskStore.getState().updateTask(client, task.id, patch);
    } catch (error) {
      debug.error("follow-up: sender not kept", error);
    }
  }
}

/**
 * Completes the follow-up of a mail whose star was taken off, in the app or
 * elsewhere. Should a plugin refuse it, the star goes back on: the task
 * stays the original. Should the server fail, nothing else is written and a
 * later check tries again. The mail stays marked until one of the two is
 * written. Resolves whether task and star are in step.
 */
async function completeForClearedFlag(client: IJMAPClient, taskId: string, emailId: string): Promise<boolean> {
  try {
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
    const patch = task ? completedTaskPatch(task, new Date()) : { progress: "completed" as const };
    if (await useTaskStore.getState().updateTask(client, taskId, patch)) {
      forgetUnstarredHere(client.getAccountId(), emailId);
      return true;
    }
  } catch (error) {
    debug.error("follow-up: not completed after the star was taken off", error);
    return false;
  }
  try {
    if (await mirrorFlag(client, { id: emailId, keywords: {} }, true, client.getAccountId(), false)) {
      forgetUnstarredHere(client.getAccountId(), emailId);
      return true;
    }
  } catch (error) {
    debug.error("follow-up: star not put back", error);
  }
  return false;
}

/**
 * Runs the check when the task list loads or changes, when a push says
 * something changed (a mail's keywords among it), and after the user changed
 * a follow-up here. Mounted once for the whole app.
 */
export function useFollowUpSync(): void {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const loginId = useAuthStore((s) => s.activeAccountId);

  useEffect(() => {
    if (!enabled || !client) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let queue: Promise<void> = Promise.resolve();
    let stopped = false;

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // One check at a time; each reads the state afresh.
        queue = queue
          .then(() => (stopped ? undefined : checkFollowUps(client, loginId)))
          .catch((error) => debug.error("follow-up: check failed", error));
      }, delay);
    };

    const markFetched = (tasks: CalendarTask[]) => { for (const task of tasks) fetched.add(task); };
    if (useTaskStore.getState().loadedBy === client) markFetched(useTaskStore.getState().tasks);

    const stopTasks = useTaskStore.subscribe((state, prev) => {
      if (state.loadedBy === client && state.loadedBy !== prev.loadedBy) markFetched(state.tasks);
      if (ownFetches > 0) return;
      if (state.tasks !== prev.tasks || state.loadedBy !== prev.loadedBy) schedule(TASKS_DELAY_MS);
    });
    const stopPush = useEmailStore.subscribe((state, prev) => {
      if (state.lastPushUpdate !== prev.lastPushUpdate) schedule(PUSH_DELAY_MS);
    });
    onFollowUpChanged(() => schedule(TASKS_DELAY_MS));
    // Taking the star off in the app completes the follow-up, as the flag's
    // own click does, also one the check never saw in step.
    const stopStars = onStarToggled(({ email, starred }) => {
      if (!isOwnMail(email, client)) return;
      const accountId = client.getAccountId();
      if (starred) {
        forgetUnstarredHere(accountId, email.id);
        return;
      }
      // The follow-up's own actions clear the flag themselves.
      if (isFollowUpPending(accountId, email.id)) return;
      markUnstarredHere(accountId, email.id);
      schedule(TASKS_DELAY_MS);
    });
    schedule(TASKS_DELAY_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopTasks();
      stopPush();
      stopStars();
      onFollowUpChanged(null);
    };
  }, [enabled, client, loginId]);
}
