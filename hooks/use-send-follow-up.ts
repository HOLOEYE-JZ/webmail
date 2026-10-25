"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { normalizeAction } from "@/lib/follow-up-actions";
import { stripMessageIdBrackets } from "@/lib/email-threading";
import { displayNow, fromDisplayDate, toDisplayDate } from "@/lib/timezone";
import { rememberDraftFollowUp, sendFollowUpDetails, type SendFollowUp } from "@/lib/send-follow-up";
import type { WorkingTime } from "@/lib/follow-ups";
import type { CalendarTask, Email, SendEmailResult } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import {
  deleteOwnFollowUp,
  followUpOnMail,
  reachesMailAccount,
  useFollowUpsEnabled,
  useWorkingTime,
  type FollowUpMail,
} from "./use-follow-ups";
import { deleteGroupTask, useGroupTasks, writeGroupTask } from "./use-group-follow-ups";

/**
 * The follow-up the composer's "⚑ Follow up" asks for, written on the sent
 * copy once the mail has left (lib/send-follow-up.ts).
 */

/** What is known of a mail just sent. */
export interface SentMail {
  /** The Email id the send created (SendEmailResult.emailId). */
  emailId: string | null;
  /** The JMAP account it lies in (SendEmailResult.emailAccountId). */
  accountId: string;
  /** The Message-ID it went out with, without angle brackets. */
  messageId: string | null;
}

/**
 * How long to look for the sent copy: at once, then again a few times. The
 * copy is the created mail itself, filed into Sent by the submission; a
 * server that files later, or keeps a copy of its own, gets the time.
 */
export const SENT_COPY_WAITS_MS = [0, 2_000, 5_000, 15_000, 45_000] as const;

const COPY_PROPERTIES = ["messageId", "mailboxIds", "keywords", "subject", "from", "receivedAt"];

function carries(fields: Record<string, unknown>, messageId: string | null): boolean {
  if (!messageId) return true;
  const ids = fields.messageId;
  return Array.isArray(ids) && ids.some((id) => typeof id === "string" && stripMessageIdBrackets(id) === messageId);
}

function isFiled(fields: Record<string, unknown>): boolean {
  return !(fields.keywords as Record<string, boolean> | undefined)?.$draft;
}

function copyOf(fields: Record<string, unknown>): FollowUpMail {
  return {
    id: fields.id as string,
    subject: (fields.subject as string | undefined) ?? undefined,
    from: (fields.from as Email["from"]) ?? undefined,
    messageId: Array.isArray(fields.messageId) ? (fields.messageId[0] as string | undefined) : undefined,
    keywords: (fields.keywords as Record<string, boolean> | undefined) ?? {},
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The sent copy of a mail just sent: the mail the send created, by its id,
 * once it carries the Message-ID it went out with and is no draft any more
 * (filed into Sent); else the newest mail of the account's Sent folder with
 * that Message-ID. Asked again after each of `waits`; null when it never
 * shows (the follow-up is then not written).
 */
export async function findSentCopy(
  client: IJMAPClient,
  sent: SentMail,
  waits: readonly number[] = SENT_COPY_WAITS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<FollowUpMail | null> {
  const accountId = sent.accountId === client.getAccountId() ? undefined : sent.accountId;
  for (const ms of waits) {
    if (ms > 0) await wait(ms);
    try {
      if (sent.emailId) {
        const [fields] = await client.getEmailFields([sent.emailId], COPY_PROPERTIES, accountId);
        if (fields && carries(fields, sent.messageId) && isFiled(fields)) return copyOf(fields);
        // There, but not filed yet: wait for it rather than look elsewhere.
        if (fields && carries(fields, sent.messageId)) continue;
      }
      if (!sent.messageId) continue;
      const sentFolder = (await client.getMailboxes(accountId)).find((m) => m.role === "sent");
      if (!sentFolder) continue;
      const recent = await client.queryEmailFields(
        { inMailbox: sentFolder.originalId ?? sentFolder.id },
        COPY_PROPERTIES,
        accountId,
        30,
      );
      const found = recent.find((fields) => carries(fields, sent.messageId) && isFiled(fields));
      if (found) return copyOf(found);
    } catch (error) {
      debug.warn("follow-up", "looking for the sent copy failed", error);
    }
  }
  return null;
}

/** What the writer says, in the user's language. */
export interface SentFollowUpText {
  title: (action: string, subject: string) => string;
  noSubject: string;
  followUp: string;
  noTaskList: string;
  failed: string;
  flagFailed: string;
  notFound: string;
  groupGone: string;
}

/** What a sent mail's follow-up wrote, so a send taken back takes exactly that off again. */
interface Written {
  /** The write while it runs (finding the copy included). */
  running: Promise<void>;
  emailId: string | null;
  own: CalendarTask | null;
  group: CalendarTask | null;
}

// By "<account>\u0000<Email id>" of the mail sent, for the session.
const written = new Map<string, Written>();
const writtenKey = (accountId: string, emailId: string) => `${accountId}\u0000${emailId}`;

/** Forget what the sends wrote (tests). */
export function resetSentFollowUps(): void {
  written.clear();
}

/**
 * Writes the composer's follow-up on the sent copy: the user's own list by
 * default, also from a group mailbox (then "only me", nothing set on the
 * group's mail); the group's list only when the dialog chose it and the
 * group is still one the directory names (`useGroupTasks`' lists), else the
 * own list after all, said. `sentAt` is the display date the mail went out,
 * from which a no-answer choice is counted. Resolves whether it was written.
 */
export async function followUpSentMail(
  client: IJMAPClient,
  sent: SentMail,
  followUp: SendFollowUp,
  sentAt: Date,
  work: WorkingTime,
  text: SentFollowUpText,
  waits: readonly number[] = SENT_COPY_WAITS_MS,
): Promise<boolean> {
  if (!reachesMailAccount(client, sent.accountId)) return false;
  const entry: Written = { running: Promise.resolve(), emailId: null, own: null, group: null };
  let done!: () => void;
  entry.running = new Promise<void>((resolve) => { done = resolve; });
  if (sent.emailId) written.set(writtenKey(sent.accountId, sent.emailId), entry);
  try {
    return await writeSentFollowUp(client, sent, followUp, sentAt, work, text, waits, entry);
  } finally {
    done();
  }
}

async function writeSentFollowUp(
  client: IJMAPClient,
  sent: SentMail,
  followUp: SendFollowUp,
  sentAt: Date,
  work: WorkingTime,
  text: SentFollowUpText,
  waits: readonly number[],
  entry: Written,
): Promise<boolean> {
  const copy = await findSentCopy(client, sent, waits);
  if (!copy) {
    toast.warning(text.notFound);
    return false;
  }
  entry.emailId = copy.id;
  // Found under another id (a copy the server filed itself): known by that one too.
  if (copy.id !== sent.emailId) written.set(writtenKey(sent.accountId, copy.id), entry);
  let details = sendFollowUpDetails(followUp, sentAt, work, text.followUp, fromDisplayDate);
  const action = normalizeAction(details.action, text.followUp);
  details = { ...details, action };
  if (details.groupAccountId) {
    const list = details.groupAccountId === sent.accountId
      ? useGroupTasks.getState().lists.find((l) => l.accountId === details.groupAccountId) ?? null
      : null;
    if (list) {
      try {
        return await writeGroupTask(client, {
          list,
          task: null,
          person: details.person ?? null,
          details,
          mail: { email: copy, accountId: sent.accountId },
          text: { title: text.title, noSubject: text.noSubject, followUp: text.followUp },
          created: (task) => { entry.group = task; },
        });
      } catch (error) {
        debug.error("follow-up: the sent mail's group follow-up not written", error);
        toast.error(text.failed);
        return false;
      }
    }
    toast.warning(text.groupGone);
    details = { ...details, groupAccountId: null, person: undefined };
  }
  entry.own = await followUpOnMail(
    client,
    copy,
    sent.accountId,
    details,
    { title: text.title, noSubject: text.noSubject, noTaskList: text.noTaskList },
    { failed: text.failed, flagFailed: text.flagFailed },
  );
  return !!entry.own;
}

/**
 * A mail whose send was taken back after its follow-up was written (one
 * scheduled for later, undone or taken back to edit; a reschedule that put
 * it back into Drafts): it never left, so the follow-up this session's send
 * wrote on it goes again, the own list's with the mail's flag, a group list's
 * task by its id. A write still running is waited for first. Nothing else is
 * touched: no task the send did not write, never a colleague's.
 */
export async function dropFollowUpsOfUnsentMail(
  client: IJMAPClient,
  emailId: string,
  mailAccountId: string,
): Promise<void> {
  const key = writtenKey(mailAccountId, emailId);
  const entry = written.get(key);
  if (!entry) return;
  await entry.running;
  for (const [k, e] of written) if (e === entry) written.delete(k);
  try {
    if (entry.own) await deleteOwnFollowUp(client, entry.own.id, entry.emailId ?? emailId, mailAccountId);
    if (entry.group) await deleteGroupTask(client, entry.group);
  } catch (error) {
    debug.error("follow-up: the follow-up of a mail taken back not deleted", error);
  }
}

/** What the hosts know of a send besides its result. */
export interface SentFollowUpRequest {
  followUp?: SendFollowUp | null;
  /** `delayedUntil` is the "send delay" setting's undo hold, not a time the user chose. */
  undoHold?: boolean;
  /** The login the mail was sent through, when not the active one. */
  localAccountId?: string;
  /** Set when the user scheduled the mail for later. */
  delayedUntil?: string;
}

/**
 * For the hosts that send (the mail view, the Pro shell's compose tab): the
 * work to run once a send is reported (`announceSent`'s `then`), or
 * undefined when the composer asked for no follow-up. A send held back for
 * undo runs it when the hold ends and never when undone; a send scheduled
 * for later runs it at once, counted from the time it goes out, and a
 * cancelled one takes it off again (`dropFollowUpsOfUnsentMail`). Either way
 * a send that can still be taken back keeps the choice for its draft.
 */
export function useSendFollowUp(): (result: SendEmailResult, request: SentFollowUpRequest) => (() => void) | undefined {
  const t = useTranslations("follow_up");
  const enabled = useFollowUpsEnabled();
  const work = useWorkingTime();
  return useCallback((result, request) => {
    const followUp = request.followUp;
    if (!followUp || !enabled) return undefined;
    const client = useAuthStore.getState().client;
    const activeAccountId = useAuthStore.getState().activeAccountId;
    // Another login's mail: its follow-ups are not kept here (the composer does not offer it).
    if (!client || (request.localAccountId && request.localAccountId !== activeAccountId)) return undefined;
    if (!result.emailAccountId || (!result.emailId && !result.messageId)) {
      toast.warning(t("send.not_found"));
      return undefined;
    }
    if (result.scheduled) rememberDraftFollowUp(result.emailId, followUp);
    const sent: SentMail = { emailId: result.emailId ?? null, accountId: result.emailAccountId, messageId: result.messageId ?? null };
    const text: SentFollowUpText = {
      title: (action, subject) => t("task_title", { action, subject }),
      noSubject: t("no_subject"),
      followUp: t("actions.follow_up"),
      noTaskList: t("no_task_list"),
      failed: t("failed"),
      flagFailed: t("flag_failed"),
      notFound: t("send.not_found"),
      groupGone: t("send.group_gone"),
    };
    return () => {
      const now = displayNow();
      const scheduledFor = request.undoHold ? undefined : request.delayedUntil;
      const goesOut = scheduledFor ? toDisplayDate(new Date(result.sendAt ?? scheduledFor)) : now;
      const sentAt = Number.isNaN(goesOut.getTime()) || goesOut.getTime() < now.getTime() ? now : goesOut;
      void followUpSentMail(client, sent, followUp, sentAt, work, text).catch((error) => {
        debug.error("follow-up: the sent mail's follow-up not written", error);
      });
    };
  }, [t, enabled, work]);
}
