"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useFollowUpDialog, type FollowUpDialogFocus } from "@/stores/follow-up-dialog-store";
import { useAuthStore } from "@/stores/auth-store";
import { ensureCalendars, useCalendarStore } from "@/stores/calendar-store";
import { followUpCalendars } from "@/lib/calendar-tasks";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { toast } from "@/stores/toast-store";
import { appUrl, buildMailMessageLink, reachesMailAccount } from "@/lib/deep-links";
import { memoByArray } from "@/lib/utils";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { isFilterEmpty } from "@/lib/jmap/search-utils";
import { isAllFoldersSearchScope } from "@/lib/search-scope-folders";
import { emailHooks } from "@/lib/plugin-hooks";
import { debug } from "@/lib/debug";
import { normalizeAction } from "@/lib/follow-up-actions";
import { perStoreEpoch } from "@/lib/store-epoch";
import { completedTaskPatch, type TaskPatch } from "@/lib/task-reminders";
import {
  buildFollowUpTask,
  editFollowUpTask,
  followUpMailRef,
  followUpMessageId,
  followUpsByEmailId,
  isOtherAccountMail,
  mailAccountOfMailboxIds,
  rescheduleFollowUpTask,
  retitle,
  threadFollowUpEmail,
  type FollowUpDetails,
  type FollowUpTaskInput,
} from "@/lib/follow-ups";
import {
  DEFAULT_WORKING_TIME,
  scheduleFollowUp,
  type FollowUpChoice,
  type WorkingTime,
} from "@/lib/follow-up-schedule";
import type { CalendarTask, Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { updateAnyTask, useGroupFollowUpIndex, useGroupTaskList } from "./use-group-follow-ups";
import type { GroupTaskList } from "@/lib/group-follow-ups";

/** Whether the user can keep follow-ups at all: tasks on, a calendar server. */
export function useFollowUpsEnabled(): boolean {
  const tasksOn = useSettingsStore((s) => s.enableCalendarTasks);
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  return tasksOn && supportsCalendar;
}

/**
 * Loads the tasks of the calendars follow-ups live in once the mail view
 * opens, so the list rows and the reader know which mails have one. Only
 * those calendars: the task store remembers the scope, so a push refetches
 * the same few, not every calendar of every account. A list already loaded
 * in full (the calendar was open) stays full: the store never narrows it.
 */
export function useFollowUpTasks(): void {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    void (async () => {
      const ids = followUpCalendars(await ensureCalendars(client)).map((c) => c.id);
      if (cancelled || ids.length === 0) return;
      await useTaskStore.getState().fetchTasks(client, ids);
    })();
    return () => { cancelled = true; };
  }, [enabled, client]);
}

/** The user's working time for the quick choices; Bulwark keeps no working hours, so 08:00-17:00. */
export function useWorkingTime(): WorkingTime {
  const workingDays = useSettingsStore((s) => s.calendarWorkingDays);
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  return useMemo(() => ({
    ...DEFAULT_WORKING_TIME,
    workingDays: Array.isArray(workingDays) ? workingDays : DEFAULT_WORKING_TIME.workingDays,
    firstDayOfWeek,
  }), [workingDays, firstDayOfWeek]);
}

// One index per task list and mail account, shared by every row that asks.
const followUpIndex = memoByArray((tasks: CalendarTask[], accounts: string) => {
  const [primaryAccountId, mailAccountId] = accounts.split("\u0000");
  return followUpsByEmailId(tasks, mailAccountId, primaryAccountId);
});

const NO_FOLLOW_UPS = new Map<string, CalendarTask>();

/**
 * The follow-ups on the mails of one JMAP account by mail id (the user's own
 * account, or a group mailbox's); none while follow-ups are off.
 */
function useFollowUpIndex(mailAccountId: string | null): Map<string, CalendarTask> {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const tasks = useTaskStore((s) => s.tasks);
  return enabled && client && mailAccountId ? followUpIndex(tasks, `${client.getAccountId()}\u0000${mailAccountId}`) : NO_FOLLOW_UPS;
}

/**
 * The JMAP account a mail lies in, when a follow-up can be kept on it: the
 * user's own, or a shared one (a group mailbox's) reached through the
 * signed-in login. Read from the mail itself first: its `sourceAccountId`,
 * else its folders' ids (namespaced for another account); only a mail
 * naming neither falls back to the folder shown or searched. Null for a mail
 * of another login (which comes later) and whenever the account is not
 * certain: then nothing is offered, and no flag written, rather than the
 * wrong mail of the same id touched.
 */
export function followUpMailAccount(email: Email, client: IJMAPClient | null): string | null {
  if (!client) return null;
  const activeAccountId = useAuthStore.getState().activeAccountId;
  if (email.sourceClientAccountId && activeAccountId && email.sourceClientAccountId !== activeAccountId) return null;
  const reached = (accountId: string | null) => (accountId && reachesMailAccount(client, accountId) ? accountId : null);
  if (email.sourceAccountId) return reached(email.sourceAccountId);
  const state = useEmailStore.getState();
  if (state.viewingAccountId && activeAccountId && state.viewingAccountId !== activeAccountId) return null;
  const byFolders = mailAccountOfMailboxIds(email.mailboxIds, client.getAccountId());
  if (byFolders !== undefined) return reached(byFolders);
  // No folder named: the one searched in, else the one shown; across folders nothing is certain.
  const searching = !!state.searchQuery || !isFilterEmpty(state.searchFilters);
  const folderId = searching ? state.searchMailboxId : state.selectedMailbox;
  if (searching && isAllFoldersSearchScope(folderId)) return null;
  const mailboxes = state.viewingAccountId ? state.accountMailboxes[state.viewingAccountId] ?? state.mailboxes : state.mailboxes;
  const mailbox = mailboxes.find((m) => m.id === folderId);
  if (!mailbox) return null;
  return mailbox.isShared ? reached(mailbox.accountId ?? null) : client.getAccountId();
}

/** Whether a mail lies in the user's own mailbox, whose $flagged mirrors its follow-up. */
export function isOwnMail(email: Email, client: IJMAPClient | null): boolean {
  return !!client && followUpMailAccount(email, client) === client.getAccountId();
}

/**
 * The mail a conversation row's flag acts on: the newest with a follow-up,
 * else the newest of all.
 */
export function useThreadFollowUpEmail(emails: readonly Email[], latest: Email): Email {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const mailAccountId = enabled ? followUpMailAccount(latest, client) : null;
  const index = useFollowUpIndex(mailAccountId);
  // A group mailbox's mails: also one a colleague follows up in the group's list.
  const groupIndex = useGroupFollowUpIndex(mailAccountId && client && mailAccountId !== client.getAccountId() ? mailAccountId : null);
  return threadFollowUpEmail(emails, index) ?? threadFollowUpEmail(emails, groupIndex) ?? latest;
}

/**
 * A mail in the session's state: Email ids are unique only within their JMAP
 * account, so a group mailbox's mail and one of the user's own may share one.
 */
function mailKey(accountId: string, emailId: string): string {
  return `${accountId}\u0000${emailId}`;
}

// Mails whose follow-up is being written, so a double click writes one task
// and the check that keeps flag and task in step leaves them alone meanwhile.
const pending = perStoreEpoch(() => new Set<string>());

/** Whether the user is changing the follow-up of this mail of `accountId` right now. */
export function isFollowUpPending(accountId: string, emailId: string): boolean {
  return pending().has(mailKey(accountId, emailId));
}

// Mails the user took the star off in the app this session, by account:
// their open follow-up is completed, also when the task list did not hold it
// yet. Setting the star or a new follow-up here lifts it. Forgotten when
// another account comes on screen.
const unstarredHere = perStoreEpoch(() => new Map<string, Set<string>>());

export function markUnstarredHere(accountId: string, emailId: string): void {
  const mails = unstarredHere().get(accountId) ?? new Set<string>();
  mails.add(emailId);
  unstarredHere().set(accountId, mails);
}

export function forgetUnstarredHere(accountId: string, emailId: string): void {
  unstarredHere().get(accountId)?.delete(emailId);
}

const NO_MAILS: ReadonlySet<string> = new Set();

/** The ids of the mails of `accountId` the star was taken off in the app. */
export function unstarredHereMails(accountId: string): ReadonlySet<string> {
  return unstarredHere().get(accountId) ?? NO_MAILS;
}

// Called once the user's own change is written, so the check runs after it.
let afterChange: (() => void) | null = null;
export function onFollowUpChanged(listener: (() => void) | null): void {
  afterChange = listener;
}

/** The mail's Message-ID, read from the server when the list did not give it. */
export async function messageIdOf(client: IJMAPClient, email: Pick<Email, "id" | "messageId">, accountId: string): Promise<string | readonly string[] | null> {
  if (email.messageId) return email.messageId;
  try {
    const [fields] = await client.getEmailFields([email.id], ["messageId"], accountId === client.getAccountId() ? undefined : accountId);
    return (fields?.messageId as string[] | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sets or clears the mail's $flagged, which mirrors an open follow-up, in the
 * JMAP account `accountId` named explicitly, so a mail of the same id in
 * another account is never touched. Resolves false when a plugin vetoed it
 * (the plugin tells the user why). Rows of the list and the open mail
 * follow only when they are that account's mail.
 *
 * `serverFlagged`, the flag as just read from the server, is taken instead
 * of what the list shows (the check that keeps flag and task in step).
 */
export async function mirrorFlag(
  client: IJMAPClient,
  email: Pick<Email, "id" | "keywords">,
  flagged: boolean,
  accountId: string,
  serverFlagged?: boolean,
): Promise<boolean> {
  const sameMail = (e: Email | null | undefined): e is Email =>
    !!e && e.id === email.id && followUpMailAccount(e, client) === accountId;
  const store = useEmailStore.getState();
  const shown = store.emails.find(sameMail) ?? (sameMail(store.selectedEmail) ? store.selectedEmail : null);
  const current = serverFlagged ?? !!(shown ?? email).keywords?.$flagged;
  if (current === flagged) return true;
  if (emailHooks.onBeforeEmailStarToggle.size > 0
    && !(await emailHooks.onBeforeEmailStarToggle.intercept({ emailIds: [email.id], starred: flagged }))) {
    return false;
  }
  await client.toggleStar(email.id, flagged, accountId);
  void emailHooks.onEmailStarToggle.emit({ emailIds: [email.id], starred: flagged });
  const withFlag = (e: Email) => ({ ...e, keywords: { ...e.keywords, $flagged: flagged } });
  useEmailStore.setState((s) => ({
    emails: s.emails.some(sameMail) ? s.emails.map((e) => (sameMail(e) ? withFlag(e) : e)) : s.emails,
    selectedEmail: sameMail(s.selectedEmail) ? withFlag(s.selectedEmail) : s.selectedEmail,
  }));
  return true;
}

/**
 * One change of a mail's follow-up: writes the task, then mirrors it as
 * $flagged. While it runs, the check that keeps flag and task in step leaves
 * the mail alone; afterwards it runs. A failure after the task was written
 * says so: the follow-up stands, only the mail's flag does not.
 */
async function changeFollowUp(
  mail: { accountId: string; emailId: string },
  writeTask: () => Promise<boolean>,
  mirror: () => Promise<unknown>,
  /** Null: no toast (a change the user did not make here), only the log. */
  messages: { failed: string; flagFailed: string } | null,
): Promise<boolean> {
  const key = mailKey(mail.accountId, mail.emailId);
  const writing = pending();
  if (writing.has(key)) return false;
  writing.add(key);
  try {
    let written: boolean;
    try {
      written = await writeTask();
    } catch (error) {
      debug.error("follow-up: task not written", error);
      if (messages) toast.error(messages.failed);
      return false;
    }
    if (!written) return false;
    try {
      await mirror();
    } catch (error) {
      debug.error("follow-up: flag not mirrored", error);
      if (messages) toast.error(messages.flagFailed);
    }
    return true;
  } finally {
    writing.delete(key);
    afterChange?.();
  }
}

/** What a new follow-up's task says, in the user's language. */
export interface FollowUpText {
  title: (action: string, subject: string) => string;
  noSubject: string;
  /** Said when the user has no task list to put it in; null: only logged. */
  noTaskList: string | null;
}

/** The mail a follow-up is written for: what its task names of it. */
export type FollowUpMail = Pick<Email, "id" | "subject" | "from" | "messageId" | "keywords">;

/**
 * Writes a new follow-up into the user's own task list, also for a group
 * mailbox's mail: its link names the mail's JMAP account `mailAccountId`.
 */
export async function createOwnFollowUp(
  client: IJMAPClient,
  email: FollowUpMail,
  mailAccountId: string,
  details: FollowUpDetails,
  text: FollowUpText,
): Promise<CalendarTask | null> {
  const [calendar] = followUpCalendars(await ensureCalendars(client));
  if (!calendar) {
    if (text.noTaskList) toast.error(text.noTaskList);
    else debug.warn("follow-up", "no task list to put the follow-up in");
    return null;
  }
  return useTaskStore.getState().createTask(client, buildFollowUpTask({
    ...(await followUpTaskInput(client, { email, accountId: mailAccountId }, details, calendar.id, text)),
    mailReminder: details.mailReminder,
    settlesOnReply: details.settlesOnReply,
  }));
}

/**
 * What every new follow-up on a mail says of it, in whichever task list:
 * the title, the mail's permalink (naming its JMAP account), subject,
 * Message-ID and sender, and the dialog's day, reminder and note.
 */
export async function followUpTaskInput(
  client: IJMAPClient,
  mail: { email: Pick<Email, "id" | "subject" | "from" | "messageId">; accountId: string },
  details: Pick<FollowUpDetails, "action" | "due" | "reminderAt" | "note">,
  calendarId: string,
  text: Pick<FollowUpText, "title" | "noSubject">,
): Promise<FollowUpTaskInput> {
  const { email, accountId } = mail;
  return {
    title: text.title(details.action, email.subject || text.noSubject),
    mailUrl: appUrl(buildMailMessageLink(email.id, accountId)),
    subject: email.subject,
    messageId: await messageIdOf(client, email, accountId),
    from: email.from?.[0] ?? null,
    calendarId,
    due: details.due,
    reminderAt: details.reminderAt,
    note: details.note,
  };
}

/**
 * A new follow-up in the user's own task list on a mail the user is not
 * looking at (the sent copy of a mail just sent), as the menu's choices write
 * one: the task, then $flagged on a mail of the user's own mailbox (never on a
 * group mailbox's), the check that keeps flag and task in step held off
 * meanwhile. Resolves the task written, or null.
 */
export async function followUpOnMail(
  client: IJMAPClient,
  email: FollowUpMail,
  mailAccountId: string,
  details: FollowUpDetails,
  text: FollowUpText,
  messages: { failed: string; flagFailed: string } | null,
): Promise<CalendarTask | null> {
  forgetUnstarredHere(mailAccountId, email.id);
  const own = mailAccountId === client.getAccountId();
  let created: CalendarTask | null = null;
  await changeFollowUp(
    { accountId: mailAccountId, emailId: email.id },
    async () => {
      created = await createOwnFollowUp(client, email, mailAccountId, details, text);
      return !!created;
    },
    async () => (own ? mirrorFlag(client, { id: email.id, keywords: email.keywords ?? {} }, true, mailAccountId, !!email.keywords?.$flagged) : true),
    messages,
  );
  return created;
}

/**
 * Deletes one follow-up of the user's own list by its id, and clears the
 * flag of its mail when that is the user's own; failures are only logged.
 */
export async function deleteOwnFollowUp(
  client: IJMAPClient,
  taskId: string,
  emailId: string,
  mailAccountId: string,
): Promise<boolean> {
  return changeFollowUp(
    { accountId: mailAccountId, emailId },
    () => useTaskStore.getState().deleteTask(client, taskId),
    async () => (mailAccountId === client.getAccountId()
      ? mirrorFlag(client, { id: emailId, keywords: {} }, false, mailAccountId, true)
      : true),
    null,
  );
}

/**
 * Marks a task done from a list that holds only the task (the tasks
 * panel), as the mail's own "Mark complete" does: a follow-up on a mail
 * of the user's own account clears that mail's flag too. Any other task is
 * only completed. `patch` completes it otherwise than Mark Complete (an
 * answer that settled it). Resolves whether the task was written.
 */
export async function completeTask(
  client: IJMAPClient,
  task: CalendarTask,
  /** Null: failures are only logged (a completion in the background). */
  messages: { failed: string; flagFailed: string } | null,
  patch?: TaskPatch,
  /** Writes the completion instead (the task list's check box, which plugins see as a toggle). */
  write?: () => Promise<boolean>,
): Promise<boolean> {
  // Its reminders that fired are dismissed with it, so reopened it does not remind of them again.
  // A group's task is written there (its list is kept apart from the own one).
  const complete = write ?? (() => updateAnyTask(client, task, patch ?? completedTaskPatch(task, new Date())));
  const ref = task.isShared ? null : followUpMailRef(task);
  // A group mailbox's mail carries no flag: its follow-up is only completed.
  if (!ref || isOtherAccountMail(ref, client.getAccountId())) {
    try {
      return await complete();
    } catch (error) {
      debug.error("tasks: not completed", error);
      if (messages) toast.error(messages.failed);
      return false;
    }
  }
  return changeFollowUp({ accountId: client.getAccountId(), emailId: ref.emailId }, complete, async () => {
    // The row in the list, when it is there, so it follows at once; else the flag as the server has it.
    const listed = useEmailStore.getState().emails.find((e) => e.id === ref.emailId && isOwnMail(e, client));
    if (listed) return mirrorFlag(client, listed, false, client.getAccountId());
    const [fields] = await client.getEmailFields([ref.emailId], ["keywords"]);
    if (!fields) return true; // The mail is gone: nothing to mirror.
    const keywords = fields.keywords as Record<string, boolean> | undefined;
    return mirrorFlag(client, { id: ref.emailId, keywords: {} }, false, client.getAccountId(), !!keywords?.$flagged);
  }, messages);
}

/**
 * Takes back `completeTask` (an undo): the task open again, wherever it is
 * kept, and a follow-up on a mail of the user's own account flagged again.
 */
export async function reopenTask(
  client: IJMAPClient,
  task: CalendarTask,
  messages: { failed: string; flagFailed: string },
): Promise<boolean> {
  const reopen = () => updateAnyTask(client, task, { progress: "needs-action" });
  const ref = task.isShared ? null : followUpMailRef(task);
  if (!ref || isOtherAccountMail(ref, client.getAccountId())) {
    try {
      return await reopen();
    } catch (error) {
      debug.error("tasks: not reopened", error);
      toast.error(messages.failed);
      return false;
    }
  }
  return changeFollowUp({ accountId: client.getAccountId(), emailId: ref.emailId }, reopen, () => {
    const listed = useEmailStore.getState().emails.find((e) => e.id === ref.emailId && isOwnMail(e, client));
    return mirrorFlag(client, listed ?? { id: ref.emailId, keywords: {} }, true, client.getAccountId());
  }, messages);
}

export interface FollowUpControls {
  /** Whether this mail can get a follow-up here. */
  available: boolean;
  /**
   * The mail lies in a group mailbox (another JMAP account): its follow-up is
   * kept in the user's own task list alone ("only me"), no colleague sees it,
   * and nothing is set on the mail, never $flagged.
   */
  onlyMe: boolean;
  /** The group mailbox's name, when the mail lies in one and its name is known. */
  mailboxName: string | null;
  /**
   * The group mailbox's task list, when the mail lies in a group mailbox
   * whose list the user may write: a follow-up there can be for a
   * colleague. Null on the user's own mail.
   */
  group: GroupTaskList | null;
  /** Opens the dialog for a new follow-up in the group's list ("For a colleague …"). */
  openGroupDialog: () => void;
  /** The mail's follow-up, open or done. */
  task: CalendarTask | null;
  workingTime: WorkingTime;
  /** Sets (or moves) the follow-up to a quick choice. */
  apply: (choice: FollowUpChoice) => Promise<void>;
  /** Sets the follow-up as the dialog says; resolves whether it was written. */
  save: (details: FollowUpDetails) => Promise<boolean>;
  /** Opens the dialog for this mail. */
  openDialog: (focus?: FollowUpDialogFocus) => void;
  markDone: () => Promise<void>;
  remove: () => Promise<void>;
  /** Outlook's Quick Click: none → Today, open → done, done → removed. */
  quickClick: () => Promise<void>;
}

export function useFollowUp(email: Email | null | undefined): FollowUpControls {
  const t = useTranslations("follow_up");
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const mailAccountId = enabled && email ? followUpMailAccount(email, client) : null;
  const index = useFollowUpIndex(mailAccountId);
  const workingTime = useWorkingTime();
  const onlyMe = !!client && !!mailAccountId && mailAccountId !== client.getAccountId();
  const mailboxName = useEmailStore((s) => (onlyMe
    ? s.mailboxes.find((m) => m.isShared && m.accountId === mailAccountId && m.accountName)?.accountName ?? null
    : null));

  const available = enabled && !!email && !email.isScheduled && !email.keywords?.$draft && !!mailAccountId;
  const group = useGroupTaskList(available && onlyMe ? mailAccountId : null);
  const task = available && email ? index.get(email.id) ?? null : null;

  /**
   * Writes the task, then mirrors it as $flagged; a group mailbox's mail is
   * never flagged. A failure after the task was written says so: the
   * follow-up stands, only the mail's flag does not.
   */
  const run = useCallback(async (
    writeTask: (client: IJMAPClient, email: Email) => Promise<boolean>,
    flagged: boolean,
  ): Promise<boolean> => {
    if (!client || !email || !mailAccountId) return false;
    return changeFollowUp(
      { accountId: mailAccountId, emailId: email.id },
      () => writeTask(client, email),
      async () => (onlyMe ? true : mirrorFlag(client, email, flagged, mailAccountId)),
      { failed: t("failed"), flagFailed: t("flag_failed") },
    );
  }, [client, email, t, onlyMe, mailAccountId]);

  const create = useCallback(async (client: IJMAPClient, email: Email, details: FollowUpDetails) => {
    if (!mailAccountId) return false;
    return !!(await createOwnFollowUp(client, email, mailAccountId, details, {
      title: (action, subject) => t("task_title", { action, subject }),
      noSubject: t("no_subject"),
      noTaskList: t("no_task_list"),
    }));
  }, [t, mailAccountId]);

  const apply = useCallback(async (choice: FollowUpChoice) => {
    await run(async (client, email) => {
      if (mailAccountId) forgetUnstarredHere(mailAccountId, email.id);
      const { due, reminder } = scheduleFollowUp(choice, displayNow(), workingTime);
      const reminderAt = reminder ? fromDisplayDate(reminder) : null;
      // Its alarm mail, when it has one, moves with the reminder.
      if (task) return useTaskStore.getState().updateTask(client, task.id, rescheduleFollowUpTask(task, due, reminderAt));
      return create(client, email, { action: t("actions.follow_up"), due, reminderAt, note: "" });
    }, true);
  }, [run, task, t, workingTime, create, mailAccountId]);

  const save = useCallback((details: FollowUpDetails) => run(async (client, email) => {
    if (mailAccountId) forgetUnstarredHere(mailAccountId, email.id);
    const action = normalizeAction(details.action, t("actions.follow_up"));
    if (!task) return create(client, email, { ...details, action });
    const title = retitle(task, action, email.subject, {
      title: (action, subject) => t("task_title", { action, subject }),
      noSubject: t("no_subject"),
    });
    // Settling on an answer needs the Message-ID; a task written without its relation gets it now.
    const messageId = details.settlesOnReply && !followUpMessageId(task) && mailAccountId
      ? await messageIdOf(client, email, mailAccountId)
      : undefined;
    return useTaskStore.getState().updateTask(client, task.id, editFollowUpTask(task, { ...details, title, messageId }));
  }, true), [run, task, t, create, mailAccountId]);

  const openDialog = useCallback((focus?: FollowUpDialogFocus) => {
    if (email) useFollowUpDialog.getState().open(email, focus);
  }, [email]);

  const openGroupDialog = useCallback(() => {
    if (email && group) useFollowUpDialog.getState().open(email, "action", { taskId: null });
  }, [email, group]);

  const markDone = useCallback(async () => {
    await run(async (client) => (
      !!task && useTaskStore.getState().updateTask(client, task.id, completedTaskPatch(task, new Date()))
    ), false);
  }, [run, task]);

  const remove = useCallback(async () => {
    await run(async (client) => (
      !task || useTaskStore.getState().deleteTask(client, task.id)
    ), false);
  }, [run, task]);

  const quickClick = useCallback(async () => {
    if (!task) return apply("today");
    if (task.progress === "completed") return remove();
    return markDone();
  }, [task, apply, remove, markDone]);

  return { available, onlyMe, mailboxName, group, task, workingTime, apply, save, openDialog, openGroupDialog, markDone, remove, quickClick };
}
