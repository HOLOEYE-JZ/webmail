import type { Calendar, CalendarParticipant, CalendarTask, Principal } from "@/lib/jmap/types";
import { patchPath } from "@/lib/jmap/patch-object";
import { followUpMailRef } from "@/lib/follow-ups";
import { isOpenTask } from "@/lib/calendar-tasks";

/**
 * Follow-ups and reminders in a group mailbox's task list (plan 037
 * decisions 2, 3, 8): kept in the task list of the group's own account,
 * which everyone it is shared with sees, and for one of them.
 *
 * Whom it is for is the task's owner participant (RFC 8984 `participants`,
 * `roles: { owner: true }`), named by its `calendarAddress` (`mailto:`;
 * Stalwart drops a participant without one). The server makes the writer
 * the organizer (`organizerCalendarAddress`) and keeps it; who set it is
 * also kept on the participant as a vendor property (`SET_BY_PROPERTY`), so
 * it can be named without the directory. Tasks are written without
 * scheduling messages (`sendSchedulingMessages: false`), so nobody gets an
 * invitation: the colleague sees the task in the group's list.
 *
 * Who can be chosen are the people the group's task list is shared with
 * (`Calendar.shareWith`, which everyone who may share it reads): Bulwark
 * cannot read who a group's members are, so the operator shares the list
 * with them. The user is always offered as "me".
 *
 * A reminder in such a task fires for its owner alone (`isTaskForMe`), not
 * for everyone who loads the list. No alarm mail is offered there (the
 * server would send it to the group's inbox), nor settling on an answer (the
 * reminder and its dismissal would be the group's, not the owner's).
 *
 * Pure.
 */

/** The key of the owner participant this app writes. */
export const GROUP_OWNER_PARTICIPANT_ID = "for";

/** RFC 8984 §3.3 vendor property on the owner participant: who set the task for them. */
export const SET_BY_PROPERTY = "bulwarkmail.org:setBy";

/** A person a group task can be for. */
export interface TaskPerson {
  /** The principal's id, or null for the user. */
  id: string | null;
  name: string;
  /** Lower-case address, without `mailto:`. */
  email: string;
}

/** Who set a task for its owner, as `SET_BY_PROPERTY` keeps it. */
export interface SetBy {
  name: string | null;
  email: string | null;
}

/** A group task's owner as read from the task. */
export interface TaskOwner {
  /** The participant's key in `participants`. */
  key: string;
  /** Lower-case address, without `mailto:`; null when it names none. */
  email: string | null;
  name: string | null;
  setBy: SetBy | null;
}

/** `mailto:a@b` and `A@B` alike as `a@b`; null for anything else. */
export function addressOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return bare.includes("@") ? bare : null;
}

/**
 * The task's owner as this app writes it: the participant under
 * `GROUP_OWNER_PARTICIPANT_ID` marked owner. Null for any other task, also
 * one whose participants another client wrote: it is not taken for whom a
 * group follow-up is for.
 */
export function groupTaskOwner(task: Partial<Pick<CalendarTask, "participants">>): TaskOwner | null {
  const participant = task.participants?.[GROUP_OWNER_PARTICIPANT_ID];
  if (!participant?.roles?.owner) return null;
  const raw = (participant as unknown as Record<string, unknown>)[SET_BY_PROPERTY];
  let setBy: SetBy | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
    const email = addressOf(typeof value.email === "string" ? value.email : null);
    if (name || email) setBy = { name, email };
  }
  return {
    key: GROUP_OWNER_PARTICIPANT_ID,
    email: addressOf(participant.calendarAddress) ?? addressOf(participant.email),
    name: typeof participant.name === "string" && participant.name.trim() ? participant.name.trim() : null,
    setBy,
  };
}

/** Whether a task names whom it is for (this app's owner participant). */
export function hasTaskOwner(task: Partial<Pick<CalendarTask, "participants">>): boolean {
  return groupTaskOwner(task) !== null;
}

/** Whether the task is for the user, whose addresses are `mine` (lower case). */
export function isTaskForMe(task: Partial<Pick<CalendarTask, "participants">>, mine: ReadonlySet<string>): boolean {
  const owner = groupTaskOwner(task);
  return !!owner?.email && mine.has(owner.email);
}

/** Whether a task lies in one of the group task lists this app recognised (`groupListIds`, calendar ids). */
export function isInGroupList(task: Pick<CalendarTask, "calendarIds">, groupListIds: ReadonlySet<string>): boolean {
  return Object.keys(task.calendarIds ?? {}).some((id) => groupListIds.has(id));
}

/**
 * Whether a task is a group follow-up of this app: in a recognised group
 * task list and naming whom it is for by this app's owner participant. Only
 * those remind their owner alone; any other shared task is everyone's who
 * loads it, as before, and never written for a reminder.
 */
export function isGroupFollowUpTask(
  task: Pick<CalendarTask, "calendarIds"> & Partial<Pick<CalendarTask, "participants" | "isShared">>,
  groupListIds: ReadonlySet<string>,
): boolean {
  return !!task.isShared && isInGroupList(task, groupListIds) && hasTaskOwner(task);
}

/** Who set the task: its owner's `setBy`, else the organizer the server keeps. */
export function groupTaskSetBy(
  task: Partial<Pick<CalendarTask, "participants" | "organizerCalendarAddress">>,
): SetBy | null {
  const owner = groupTaskOwner(task);
  if (owner?.setBy) return owner.setBy;
  const organizer = addressOf(task.organizerCalendarAddress);
  return organizer ? { name: null, email: organizer } : null;
}

/** The owner participant a new group task, or a change of whom it is for, writes. */
export function ownerParticipant(person: TaskPerson, setBy: TaskPerson): CalendarParticipant {
  return {
    "@type": "Participant",
    name: person.name,
    calendarAddress: `mailto:${person.email}`,
    kind: "individual",
    roles: { owner: true },
    [SET_BY_PROPERTY]: { name: setBy.name, email: setBy.email },
  } as unknown as CalendarParticipant;
}

/** The task's `participants` for a new group task. */
export function groupTaskParticipants(person: TaskPerson, setBy: TaskPerson): Record<string, CalendarParticipant> {
  return { [GROUP_OWNER_PARTICIPANT_ID]: ownerParticipant(person, setBy) };
}

/**
 * The patch that makes a group task someone else's: the owner participant
 * replaced by its key (another participant stays), who changed it named as
 * who set it. Empty when it is that person's already.
 */
export function groupTaskOwnerPatch(
  task: Partial<Pick<CalendarTask, "participants">>,
  person: TaskPerson,
  setBy: TaskPerson,
): Record<string, unknown> {
  const owner = groupTaskOwner(task);
  if (owner?.email === person.email.toLowerCase()) return {};
  const key = GROUP_OWNER_PARTICIPANT_ID;
  if (!task.participants || Object.keys(task.participants).length === 0) {
    return { participants: { [key]: ownerParticipant(person, setBy) } };
  }
  return { [`participants/${patchPath(key)}`]: ownerParticipant(person, setBy) };
}

/**
 * The group account's task list: the one holding only tasks, else its
 * default calendar (Stalwart makes one per account, plan 037 M4), else the
 * first. Only a calendar of that account, never a user's, and one the user
 * may write to. Null when there is none.
 */
export function groupTaskList(calendars: readonly Calendar[], accountId: string): Calendar | null {
  const own = calendars.filter((c) => c.isShared && c.accountId === accountId
    && (c.myRights?.mayWriteAll || c.myRights?.mayWriteOwn));
  return own.find((c) => c.isTasksOnly) ?? own.find((c) => c.isDefault) ?? own[0] ?? null;
}

/** The principal's name to show: its full name (Stalwart's description), else its name, else its address. */
export function principalName(principal: Pick<Principal, "name" | "description" | "email">): string {
  const description = principal.description?.trim();
  if (description) return description;
  return principal.name?.trim() || principal.email?.trim() || "";
}

/**
 * The people a group task can be for besides the user: those the task list
 * is shared with (`shareWith`) and may read it, as the directory names them.
 * One the directory does not name with an address is left out (a task needs
 * the address); the user too (offered as "me"). By name.
 */
export function taskListSharees(
  list: Pick<Calendar, "shareWith"> | null | undefined,
  principals: readonly Principal[],
  mine: ReadonlySet<string>,
  ownPrincipalId: string | null,
): TaskPerson[] {
  const byId = new Map(principals.map((p) => [p.id, p]));
  const people: TaskPerson[] = [];
  for (const [id, rights] of Object.entries(list?.shareWith ?? {})) {
    if (!rights?.mayReadItems || id === ownPrincipalId) continue;
    const principal = byId.get(id);
    const email = addressOf(principal?.email);
    if (!principal || !email || mine.has(email)) continue;
    if (principal.type && principal.type !== "individual") continue;
    people.push({ id, name: principalName(principal) || email, email });
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

/** The name to show for an address: the directory's, else its local part. */
export function nameOfAddress(email: string, principals: readonly Principal[]): string {
  const principal = principals.find((p) => addressOf(p.email) === email);
  return (principal && principalName(principal)) || email.split("@")[0];
}

/** How a group task names its people, from the user's point of view. */
export interface GroupTaskPeople {
  forMe: boolean;
  /** Whom it is for, when it is not the user. */
  forName: string | null;
  /** The user set it for someone else. */
  byMe: boolean;
  /** Who set it, when someone else did for another than themself; null when unknown. */
  byName: string | null;
}

/** The names of whom a group task is for and who set it. */
export function groupTaskPeople(
  task: Partial<Pick<CalendarTask, "participants" | "organizerCalendarAddress">>,
  mine: ReadonlySet<string>,
  principals: readonly Principal[],
): GroupTaskPeople {
  const owner = groupTaskOwner(task);
  const forMe = !!owner?.email && mine.has(owner.email);
  const forName = forMe ? null : owner?.name || (owner?.email ? nameOfAddress(owner.email, principals) : null);
  const setBy = groupTaskSetBy(task);
  const byEmail = setBy?.email ?? null;
  // Set for oneself says nothing more.
  if (!setBy || (byEmail && byEmail === owner?.email)) return { forMe, forName, byMe: false, byName: null };
  const byMe = !!byEmail && mine.has(byEmail);
  return {
    forMe,
    forName,
    byMe,
    byName: byMe ? null : setBy.name || (byEmail ? nameOfAddress(byEmail, principals) : null),
  };
}

/**
 * The group follow-ups of the mails of `mailAccountId` by mail id: tasks of
 * that account's own task list linking a mail of it. Every one, open and
 * done (not cancelled): several people can follow one mail up. Open first,
 * then the latest.
 */
export function groupFollowUpsByEmailId(
  tasks: readonly CalendarTask[],
  mailAccountId: string,
): Map<string, CalendarTask[]> {
  const byEmail = new Map<string, CalendarTask[]>();
  for (const task of tasks) {
    if (!task.isShared || task.accountId !== mailAccountId || task.progress === "cancelled") continue;
    const ref = followUpMailRef(task);
    if (!ref || ref.accountId !== mailAccountId) continue;
    const list = byEmail.get(ref.emailId) ?? [];
    list.push(task);
    byEmail.set(ref.emailId, list);
  }
  for (const list of byEmail.values()) {
    list.sort((a, b) => Number(isOpenTask(b)) - Number(isOpenTask(a)) || (b.updated ?? "").localeCompare(a.updated ?? ""));
  }
  return byEmail;
}

/** A group account's task list, with the account's name. */
export interface GroupTaskList {
  accountId: string;
  /** The account's name, its address in Stalwart ("vertrieb@example.com"). */
  name: string;
  list: Calendar;
}

/**
 * Whether the directory confirms an account as a group's (a group mailbox's
 * account). Only then: a shared account the directory does not name, or
 * names otherwise (a colleague's or a manager's delegated mailbox), is never
 * taken for a group, so nothing is written into a person's own calendar.
 */
export function isGroupAccount(accountId: string, principals: readonly Principal[]): boolean {
  return principals.some((p) => p.id === accountId && p.type === "group");
}

/**
 * The tasks a group list's read keeps: open ones only (Stalwart's
 * CalendarEvent/query filters by neither type nor progress, so the rest is
 * read and dropped), of the lists read. A done or cancelled one shows at the
 * mail only until the next read.
 */
export function keptGroupTasks(tasks: readonly CalendarTask[], listIds: ReadonlySet<string>): CalendarTask[] {
  return tasks.filter((t) => t.isShared && isOpenTask(t) && Object.keys(t.calendarIds ?? {}).some((id) => listIds.has(id)));
}
