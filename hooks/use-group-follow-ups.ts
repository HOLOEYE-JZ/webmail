"use client";

/**
 * What the mail view, the dialog and the lists read of the group mailboxes'
 * task lists (kept in stores/group-task-store.ts), and the writes to them.
 */

import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useTaskStore } from "@/stores/task-store";
import { groupTasksPushed, useGroupTasks } from "@/stores/group-task-store";
import { subscribePushStateChanges } from "@/lib/push-events";
import { memoByArray } from "@/lib/utils";
import { normalizeAction } from "@/lib/follow-up-actions";
import { cachedPrincipals } from "@/lib/jmap/principal-cache";
import {
  buildFollowUpTask,
  buildReminderTask,
  editFollowUpTask,
  editReminderTask,
  retitle,
  type FollowUpDetails,
} from "@/lib/follow-ups";
import {
  addressOf,
  groupFollowUpsByEmailId,
  groupTaskOwnerPatch,
  groupTaskParticipants,
  isGroupFollowUpTask,
  isTaskForMe,
  principalName,
  taskListSharees,
  type GroupTaskList,
  type TaskPerson,
} from "@/lib/group-follow-ups";
import type { Calendar, CalendarTask, Email, Principal } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { GroupReminderScope } from "@/lib/task-reminders";
import { followUpTaskInput, useFollowUpsEnabled } from "./use-follow-ups";

/** How long the app waits for a page to load the calendars before it does so itself. */
const CALENDARS_DELAY_MS = 2_000;

/** The calendars' ids and rights, which decide the group lists: a reload only when they change. */
function listsKey(calendars: readonly Calendar[]): string {
  return calendars
    .filter((c) => c.isShared)
    .map((c) => `${c.id}:${c.isTasksOnly ? 1 : 0}${c.isDefault ? 1 : 0}${c.myRights?.mayWriteAll || c.myRights?.mayWriteOwn ? 1 : 0}:${Object.keys(c.shareWith ?? {}).sort().join(",")}`)
    .sort()
    .join("|");
}

/**
 * Loads the group lists and their tasks wherever the app opens (a reminder
 * for the user may stand in one), and again when the calendars change or a
 * push names a group's calendars.
 * Mounted once.
 */
export function useGroupTasksLoaded(): void {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const calendars = useCalendarStore((s) => s.calendars);
  const key = useMemo(() => listsKey(calendars), [calendars]);

  useEffect(() => {
    if (!enabled || !client) {
      useGroupTasks.getState().clear();
      return;
    }
    if (useCalendarStore.getState().calendars.length === 0) {
      const timer = setTimeout(() => {
        if (useCalendarStore.getState().calendars.length === 0) void useCalendarStore.getState().fetchCalendars(client);
      }, CALENDARS_DELAY_MS);
      return () => clearTimeout(timer);
    }
    void useGroupTasks.getState().refresh(client);
  }, [enabled, client, key]);

  // The login on screen's pushes, on every page (lib/push-events.ts).
  useEffect(() => {
    if (!enabled || !client) return;
    return subscribePushStateChanges((change, pushed, role) => {
      if (role === 'active') groupTasksPushed(change, pushed);
    });
  }, [enabled, client]);
}

// ---------------------------------------------------------------------------
// The user
// ---------------------------------------------------------------------------

/** The user's own addresses, lower case: identities of the login, calendar addresses, the login name. */
export function addressesOf(
  identities: readonly { email?: string | null; localAccountId?: string }[] | null | undefined,
  username: string | null | undefined,
  calendarIdentities: readonly { calendarAddress?: string | null }[] | null | undefined,
): Set<string> {
  const addresses = new Set<string>();
  for (const identity of identities ?? []) {
    if (identity.localAccountId) continue;
    const a = addressOf(identity.email);
    if (a) addresses.add(a);
  }
  for (const identity of calendarIdentities ?? []) {
    const a = addressOf(identity.calendarAddress);
    if (a) addresses.add(a);
  }
  const login = addressOf(username);
  if (login) addresses.add(login);
  return addresses;
}

/** As `addressesOf`, following the stores. */
export function useMyAddresses(): ReadonlySet<string> {
  const identities = useAuthStore((s) => s.identities);
  const username = useAuthStore((s) => s.username);
  const participantIdentities = useCalendarStore((s) => s.participantIdentities);
  return useMemo(() => addressesOf(identities, username, participantIdentities), [identities, username, participantIdentities]);
}

/** The user as a group task names them: the calendar address they act as, else their first identity's. */
export function myPerson(): TaskPerson | null {
  const auth = useAuthStore.getState();
  const identities = useCalendarStore.getState().participantIdentities ?? [];
  const calendarIdentity = identities.find((i) => i.isDefault) ?? identities[0];
  const mailIdentity = (auth.identities ?? []).find((i) => !i.localAccountId);
  const email = addressOf(calendarIdentity?.calendarAddress) ?? addressOf(mailIdentity?.email) ?? addressOf(auth.username);
  if (!email) return null;
  const name = calendarIdentity?.name?.trim() || mailIdentity?.name?.trim() || email;
  return { id: null, name, email };
}

/** The server's principals, loaded once per client; empty until then or when it lists none. */
export function usePrincipals(enabled = true): readonly Principal[] {
  const client = useAuthStore((s) => s.client);
  const [principals, setPrincipals] = useState<readonly Principal[]>([]);
  useEffect(() => {
    if (!client || !enabled) return;
    let cancelled = false;
    void cachedPrincipals(client).then((list) => { if (!cancelled) setPrincipals(list); });
    return () => { cancelled = true; };
  }, [client, enabled]);
  return principals;
}

// ---------------------------------------------------------------------------
// What the mail view and the dialog read
// ---------------------------------------------------------------------------

/** The group task list of a mail account, when it is a group mailbox's with one. */
export function useGroupTaskList(accountId: string | null): GroupTaskList | null {
  const enabled = useFollowUpsEnabled();
  const lists = useGroupTasks((s) => s.lists);
  return enabled && accountId ? lists.find((l) => l.accountId === accountId) ?? null : null;
}

// One index per task list and account, shared by every row that asks.
const groupIndex = memoByArray(groupFollowUpsByEmailId);

const NO_TASKS: CalendarTask[] = [];
const NO_INDEX = new Map<string, CalendarTask[]>();

/** The group follow-ups on the mails of a group account, by mail id. */
export function useGroupFollowUpIndex(accountId: string | null): Map<string, CalendarTask[]> {
  const enabled = useFollowUpsEnabled();
  const tasks = useGroupTasks((s) => s.tasks);
  return enabled && accountId ? groupIndex(tasks, accountId) : NO_INDEX;
}

/** The group follow-ups on one mail of a group account. */
export function useGroupFollowUpsOf(emailId: string | null | undefined, accountId: string | null): CalendarTask[] {
  const index = useGroupFollowUpIndex(accountId);
  return (emailId && index.get(emailId)) || NO_TASKS;
}

/** The group tasks for the user (open or not): the tasks panel and the reminders read them beside the own list. */
export function useGroupTasksForMe(): CalendarTask[] {
  const enabled = useFollowUpsEnabled();
  const tasks = useGroupTasks((s) => s.tasks);
  const { mine, groupListIds } = useGroupReminderScope();
  return useMemo(
    () => (enabled ? tasks.filter((t) => isGroupFollowUpTask(t, groupListIds) && isTaskForMe(t, mine)) : NO_TASKS),
    [enabled, tasks, mine, groupListIds],
  );
}

/** The user's addresses and the recognised group lists, for whose reminders a shared task's are. */
export function useGroupReminderScope(): GroupReminderScope {
  const mine = useMyAddresses();
  const lists = useGroupTasks((s) => s.lists);
  return useMemo(() => ({ mine, groupListIds: new Set(lists.map((l) => l.list.id)) }), [mine, lists]);
}

/** The group list a task lies in, when it lies in one. */
export function groupListOfTask(task: Pick<CalendarTask, "calendarIds">, lists: readonly GroupTaskList[]): GroupTaskList | null {
  const ids = Object.keys(task.calendarIds ?? {});
  return lists.find((l) => ids.includes(l.list.id)) ?? null;
}

/** The people a group's task list can name besides the user, by its shares. */
export function useTaskListSharees(list: Calendar | null): TaskPerson[] {
  const client = useAuthStore((s) => s.client);
  const principals = usePrincipals(!!list);
  const mine = useMyAddresses();
  return useMemo(
    () => taskListSharees(list, principals, mine, client?.getAccountId() ?? null),
    [list, principals, mine, client],
  );
}

/** A principal's name for an address, for tests and callers outside React. */
export function personOfAddress(email: string, principals: readonly Principal[]): TaskPerson {
  const principal = principals.find((p) => addressOf(p.email) === email);
  return { id: principal?.id ?? null, name: (principal && principalName(principal)) || email, email };
}

// ---------------------------------------------------------------------------
// Writing a group task
// ---------------------------------------------------------------------------

/** Whether a task is one of a group's list this app reads. */
export function isGroupTask(task: Pick<CalendarTask, "id">): boolean {
  return useGroupTasks.getState().tasks.some((t) => t.id === task.id);
}

/**
 * Creates a task in a group's list. Through the task store, so plugins see
 * it as any task; the task store keeps the user's own list only, so it is
 * taken out there and kept here.
 */
export async function createGroupTask(client: IJMAPClient, task: Partial<CalendarTask>): Promise<CalendarTask | null> {
  const created = await useTaskStore.getState().createTask(client, task);
  if (!created) return null;
  useTaskStore.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== created.id) }));
  useGroupTasks.getState().addLocal(created);
  return created;
}

/** Changes a group task (by paths where the patch names them); false when a plugin stopped it. */
export async function updateGroupTask(client: IJMAPClient, task: CalendarTask, patch: object): Promise<boolean> {
  const written = await useTaskStore.getState().updateTask(client, task.id, patch as Partial<CalendarTask>);
  if (written) useGroupTasks.getState().applyLocal(task.id, patch);
  return written;
}

export async function deleteGroupTask(client: IJMAPClient, task: CalendarTask): Promise<boolean> {
  const deleted = await useTaskStore.getState().deleteTask(client, task.id);
  if (deleted) useGroupTasks.getState().applyLocal(task.id, null);
  return deleted;
}

/** Changes a task wherever it is kept: a group's list or the user's own. */
export async function updateAnyTask(client: IJMAPClient, task: CalendarTask, patch: object): Promise<boolean> {
  if (isGroupTask(task)) return updateGroupTask(client, task, patch);
  return useTaskStore.getState().updateTask(client, task.id, patch as Partial<CalendarTask>);
}

// ---------------------------------------------------------------------------
// The dialog's handle on a group task
// ---------------------------------------------------------------------------

/** The task of a group's list by its id, null while it is not (or no longer) there. */
export function useGroupTask(taskId: string | null): CalendarTask | null {
  return useGroupTasks((s) => (taskId ? s.tasks.find((t) => t.id === taskId) ?? null : null));
}

/** What a group task is to say, besides the fields both lists share. */
export interface GroupTaskWrite {
  list: GroupTaskList;
  /** The task, or null for a new one. */
  task: CalendarTask | null;
  /**
   * Whom it is for; null for the user. Undefined keeps an existing task's
   * owner as it is (also none: a task without one stays everyone's until
   * the user names someone); a new one is then the user's.
   */
  person: TaskPerson | null | undefined;
  details: FollowUpDetails;
  /** The mail of a follow-up, and its account; none for a reminder without one. */
  mail?: { email: Pick<Email, "id" | "subject" | "from" | "messageId">; accountId: string } | null;
  /** Titles in the user's language. */
  text: { title: (action: string, subject: string) => string; noSubject: string; followUp: string };
  /** Told the task a new one was written as. */
  created?: (task: CalendarTask) => void;
}

/**
 * Writes a follow-up or reminder into a group's list. A new one names its
 * owner participant and who set it; a change names a new owner only when it
 * changed. Never an alarm mail (it would go to the group's inbox) and never
 * settling on an answer: both are left as the task has them.
 */
export async function writeGroupTask(client: IJMAPClient, write: GroupTaskWrite): Promise<boolean> {
  const me = myPerson();
  if (!me) return false;
  const owner = write.person ?? me;
  const ownerChosen = write.person !== undefined;
  const { details, task, list, mail } = write;
  const shared = { ...details, mailReminder: undefined, settlesOnReply: undefined };
  if (!task) {
    if (mail) {
      const action = normalizeAction(details.action, write.text.followUp);
      const created = await createGroupTask(client, buildFollowUpTask({
        ...(await followUpTaskInput(client, mail, { ...details, action }, list.list.id, write.text)),
        participants: groupTaskParticipants(owner, me),
      }));
      if (created) write.created?.(created);
      return !!created;
    }
    const title = normalizeAction(details.action);
    if (!title) return false;
    const created = await createGroupTask(client, buildReminderTask({
      title,
      calendarId: list.list.id,
      due: details.due,
      reminderAt: details.reminderAt,
      note: details.note,
      participants: groupTaskParticipants(owner, me),
    }));
    return !!created;
  }
  let patch: Record<string, unknown>;
  if (mail) {
    const title = retitle(task, normalizeAction(details.action, write.text.followUp), mail.email.subject, write.text);
    patch = { ...editFollowUpTask(task, { ...shared, title }) };
  } else {
    const title = normalizeAction(details.action);
    if (!title) return false;
    patch = { ...editReminderTask(task, { ...shared, title: title === task.title ? null : title }) };
  }
  if (ownerChosen) Object.assign(patch, groupTaskOwnerPatch(task, owner, me));
  if (Object.keys(patch).length === 0) return true;
  return updateGroupTask(client, task, patch);
}
