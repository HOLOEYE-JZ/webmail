"use client";

import { useEffect, useRef } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useTaskStore } from "@/stores/task-store";
import { debug } from "@/lib/debug";
import { reachesMailAccount } from "@/lib/deep-links";
import { perStoreEpoch } from "@/lib/store-epoch";
import { dueTaskReminders } from "@/lib/task-reminders";
import { followUpMailRef, type ReplyWatch } from "@/lib/follow-ups";
import {
  THREAD_MAIL_PROPERTIES,
  answeredTaskPatch,
  findReply,
  replyChecksDue,
  watchesForReply,
  type ThreadMail,
} from "@/lib/follow-up-replies";
import type { CalendarTask } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { completeTask, isFollowUpPending, useFollowUpsEnabled } from "./use-follow-ups";

/**
 * Looks for the answer that settles a follow-up (`lib/follow-up-replies.ts`)
 * when the tasks load, before such a reminder shows, after a push and every
 * quarter of an hour. Runs in the browser only: no service watches the mail
 * while Bulwark is closed, so an answer that came meanwhile settles the task
 * when Bulwark opens next, before its reminder shows.
 */

/** How often the check looks at the clock (a reminder falling due). */
const TICK_MS = 30_000;
/** After the task list changed or a push came, which come in bursts. */
const SOON_MS = 1_000;
/** At most this many mails of a thread are read. */
const THREAD_LIMIT = 200;

interface ReplyChecksState {
  /** When each task's thread was last looked at (a real instant, ms), this session. */
  checkedAt: Record<string, number>;
  mark: (taskIds: readonly string[], at: number) => void;
  reset: () => void;
}

/**
 * When each follow-up that settles on an answer was last looked at. The
 * reminders window holds such a reminder back until its thread was looked at
 * after it fell due (`dueTaskReminders`).
 */
export const useReplyChecks = create<ReplyChecksState>((set) => ({
  checkedAt: {},
  mark: (taskIds, at) => set((s) => ({ checkedAt: { ...s.checkedAt, ...Object.fromEntries(taskIds.map((id) => [id, at])) } })),
  reset: () => set({ checkedAt: {} }),
}));

export type ReplyLookup =
  | { kind: "answered"; mail: ThreadMail }
  | { kind: "none" }
  /** The mail is gone, its account out of reach, or the server failed: the reminder comes. */
  | { kind: "unknown" };

/**
 * What a round reads once per account: its Sent and Drafts folders, and its
 * own addresses (the user's identities, a group mailbox's own address).
 */
export class RoundCache {
  private folders = new Map<string, Promise<Set<string>>>();
  private addresses: Promise<Set<string>> | null = null;

  constructor(private client: IJMAPClient) {}

  ownFolders(accountId: string | undefined): Promise<Set<string>> {
    const key = accountId ?? "";
    let folders = this.folders.get(key);
    if (!folders) {
      folders = this.client.getMailboxes(accountId).then((boxes) => new Set(
        boxes.filter((b) => b.role === "sent" || b.role === "drafts").map((b) => b.id),
      ));
      this.folders.set(key, folders);
    }
    return folders;
  }

  async ownAddresses(accountId: string | undefined): Promise<Set<string>> {
    this.addresses ??= this.client.getIdentities().then(
      (identities) => new Set(identities.map((i) => i.email?.trim().toLowerCase()).filter((e): e is string => !!e)),
    );
    const own = new Set(await this.addresses);
    // A group mailbox's account is named by its address; it has no identities of the member's.
    const group = accountId ? this.client.getSharedAccounts?.().find((a) => a.id === accountId)?.name : undefined;
    if (group?.includes("@")) own.add(group.trim().toLowerCase());
    return own;
  }
}

/**
 * The thread and arrival of each flagged mail already looked at, by account
 * and Email id: both stay as they are, so a later look is one query. Kept
 * for the session.
 */
const flaggedMails = perStoreEpoch(() => new Map<string, { threadId: string; receivedAt: string | null }>());

/** Forgets what was read of the flagged mails (another login). */
export function forgetFlaggedMails(): void {
  flaggedMails().clear();
}

/**
 * Looks in the thread of a follow-up's mail for an answer, in the account the
 * mail lies in: the user's own, or a group mailbox's the login reaches.
 */
export async function lookForReply(
  client: IJMAPClient,
  task: CalendarTask,
  watch: ReplyWatch,
  cache: RoundCache = new RoundCache(client),
): Promise<ReplyLookup> {
  const ref = followUpMailRef(task);
  if (!ref || !reachesMailAccount(client, ref.accountId)) return { kind: "unknown" };
  // The own account named as none, as every other call for its mail.
  const accountId = ref.accountId && ref.accountId !== client.getAccountId() ? ref.accountId : undefined;
  try {
    const key = `${accountId ?? client.getAccountId()}\u0000${ref.emailId}`;
    let flagged = flaggedMails().get(key);
    if (!flagged) {
      const [fields] = await client.getEmailFields([ref.emailId], ["threadId", "receivedAt"], accountId);
      if (!fields || typeof fields.threadId !== "string") return { kind: "unknown" };
      flagged = { threadId: fields.threadId, receivedAt: typeof fields.receivedAt === "string" ? fields.receivedAt : null };
      flaggedMails().set(key, flagged);
    }
    const [mails, folders, addresses] = await Promise.all([
      client.queryEmailFields({ inThread: flagged.threadId }, [...THREAD_MAIL_PROPERTIES], accountId, THREAD_LIMIT),
      cache.ownFolders(accountId),
      cache.ownAddresses(accountId),
    ]);
    const mail = findReply({
      messageId: watch.messageId,
      flagged: { id: ref.emailId, receivedAt: flagged.receivedAt },
      mails: mails as unknown as ThreadMail[],
      ownFolderIds: folders,
      ownAddresses: addresses,
      after: watch.answeredAt,
    });
    return mail ? { kind: "answered", mail } : { kind: "none" };
  } catch (error) {
    debug.error("follow-up: answer not looked for", error);
    return { kind: "unknown" };
  }
}

/** When a task's reminder fell due (any of them, not dismissed), or null. */
function fireTimeOf(task: CalendarTask, nowMs: number): number | null {
  return dueTaskReminders([task], nowMs)[0]?.fireTimeMs ?? null;
}

let running = false;
// Tasks whose completion failed, logged once each.
const unwritten = perStoreEpoch(() => new Set<string>());

/**
 * One round: looks at the threads `replyChecksDue` names, completes the
 * tasks an answer settled, and marks each as looked at, so the reminders of
 * the others show. A completion that fails is logged once and counts as
 * looked at too: the reminder then comes rather than none. No toast: the
 * user did not ask for it. Exported for tests.
 */
export async function checkReplies(
  client: IJMAPClient,
  options: {
    now?: () => number;
    lastPushMs: number | null;
    /** "Answer received on …" for the day of the answer, in the user's language. */
    note: (answeredAt: Date) => string;
  },
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = options.now ?? Date.now;
    const started = now();
    const checks = useReplyChecks.getState();
    const due = replyChecksDue(
      useTaskStore.getState().tasks,
      started,
      (id) => checks.checkedAt[id],
      (task) => fireTimeOf(task, started),
      options.lastPushMs,
    );
    const cache = new RoundCache(client);
    for (const task of due) {
      // Read again: the task may have changed (completed elsewhere) meanwhile.
      const current = useTaskStore.getState().tasks.find((t) => t.id === task.id);
      const watch = current ? watchesForReply(current) : null;
      if (!current || !watch) continue;
      // The user is changing this follow-up right now: looked at again at the next tick.
      const ref = followUpMailRef(current);
      if (ref && isFollowUpPending(ref.accountId ?? client.getAccountId(), ref.emailId)) continue;
      const result = await lookForReply(client, current, watch, cache);
      if (result.kind === "answered") {
        const answeredAt = result.mail.receivedAt ?? new Date(started).toISOString();
        const patch = answeredTaskPatch(current, watch, answeredAt, options.note(new Date(answeredAt)), new Date(now()));
        if (await completeTask(client, current, null, patch)) {
          debug.log("tasks", "follow-up: answer came, task completed", current.id);
        } else if (!unwritten().has(current.id)) {
          unwritten().add(current.id);
          debug.warn("tasks", "follow-up: answer came, but the task could not be completed", current.id);
        }
      }
      useReplyChecks.getState().mark([current.id], started);
    }
  } finally {
    running = false;
  }
}

/**
 * Runs the round when the tasks load or change, after a push, and every
 * `TICK_MS` for a reminder falling due. Mounted once for the whole app.
 */
export function useFollowUpReplies(): void {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const t = useTranslations("follow_up");
  const format = useFormatter();
  // The words as of now, without starting the check anew (which would look at every thread again).
  const words = useRef({ t, format });
  words.current = { t, format };

  useEffect(() => {
    if (!enabled || !client) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const run = () => {
      if (stopped) return;
      const { t, format } = words.current;
      void checkReplies(client, {
        lastPushMs: useEmailStore.getState().lastPushUpdate,
        note: (at) => t("reply.answered_note", { day: format.dateTime(at, { day: "2-digit", month: "2-digit", year: "numeric" }) }),
      }).catch((error) => debug.error("follow-up: answers not looked for", error));
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run(); }, SOON_MS);
    };
    const tick = setInterval(run, TICK_MS);
    const stopTasks = useTaskStore.subscribe((state, prev) => { if (state.tasks !== prev.tasks) soon(); });
    const stopPush = useEmailStore.subscribe((state, prev) => { if (state.lastPushUpdate !== prev.lastPushUpdate) soon(); });
    soon();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      stopTasks();
      stopPush();
      // Another login's tasks are looked at afresh.
      useReplyChecks.getState().reset();
      forgetFlaggedMails();
    };
  }, [enabled, client]);
}
