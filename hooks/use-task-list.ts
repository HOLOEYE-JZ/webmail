"use client";

import { useMemo } from "react";
import { startOfDay } from "date-fns";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { followUpMailRef, isOpenFollowUp } from "@/lib/follow-ups";
import { completedTaskPatch } from "@/lib/task-reminders";
import { isGroupFollowUpTask, isInGroupList } from "@/lib/group-follow-ups";
import {
  mergeTaskSources,
  scopeGroupAccount,
  taskList,
  type TaskListScope,
  type TaskListSection,
} from "@/lib/task-list";
import type { CalendarTask } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { completeTask, useFollowUpsEnabled } from "./use-follow-ups";
import { useFollowUpDialog } from "@/stores/follow-up-dialog-store";
import {
  PUSH_DEBOUNCE_MS,
  isGroupTask,
  scheduleGroupRefresh,
  useGroupTasks,
  useMyAddresses,
  type GroupTaskList,
} from "./use-group-follow-ups";
import { openTaskItem } from "./use-upcoming";
import { useDisplayNow } from "./use-clock";

/**
 * The calendar's task list (lib/task-list.ts) from the stores: the task
 * store's tasks (every calendar while the calendar shows them) and the group
 * mailboxes' lists, kept apart (hooks/use-group-follow-ups.ts).
 */

export interface TaskListView {
  sections: TaskListSection[];
  /** The tasks shown, in order: what plugin buttons in the toolbar act on. */
  ids: string[];
  /** The scope shown: a group's that is no longer there shows `all`. */
  scope: TaskListScope;
  /** The group mailboxes' lists the scope can name. */
  groupLists: GroupTaskList[];
}

const NO_LISTS: GroupTaskList[] = [];
const NO_TASKS: CalendarTask[] = [];

/** The scope as the list can show it: a group's only while its list is there, the user's only with follow-ups on. */
export function effectiveScope(scope: TaskListScope, enabled: boolean, groupLists: readonly GroupTaskList[]): TaskListScope {
  if (!enabled) return "all";
  const group = scopeGroupAccount(scope);
  if (group !== null && !groupLists.some((l) => l.accountId === group)) return "all";
  return scope;
}

export function useTaskList(selectedCalendarIds: string[]): TaskListView {
  const enabled = useFollowUpsEnabled();
  const tasks = useTaskStore((s) => s.tasks);
  const filter = useTaskStore((s) => s.filter);
  const showCompleted = useTaskStore((s) => s.showCompleted);
  const chosen = useTaskStore((s) => s.listScope);
  const groupStoreTasks = useGroupTasks((s) => s.tasks);
  const storeLists = useGroupTasks((s) => s.lists);
  const groupLists = enabled ? storeLists : NO_LISTS;
  const groupTasks = enabled ? groupStoreTasks : NO_TASKS;
  const mine = useMyAddresses();
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  const now = useDisplayNow();
  const day = startOfDay(now).getTime();
  const scope = effectiveScope(chosen, enabled, groupLists);

  const sections = useMemo(() => taskList({
    tasks: mergeTaskSources(tasks, groupTasks, new Set(groupLists.map((l) => l.list.id))),
    scope,
    filter,
    showCompleted,
    now: new Date(day),
    firstDayOfWeek,
    mine,
    groupLists: groupLists.map((l) => ({ accountId: l.accountId, listId: l.list.id })),
    selectedCalendarIds,
  }), [tasks, groupTasks, scope, filter, showCompleted, day, firstDayOfWeek, mine, groupLists, selectedCalendarIds]);
  const ids = useMemo(() => sections.flatMap((s) => s.tasks.map((t) => t.id)), [sections]);

  return { sections, ids, scope, groupLists };
}

function groupListIds(): Set<string> {
  return new Set(useGroupTasks.getState().lists.map((l) => l.list.id));
}

/** Whether a task is one of the user's follow-ups on a mail, or a group list's: its mail opens from the list. */
export function opensMail(task: CalendarTask): boolean {
  return !!followUpMailRef(task) && (!task.isShared || isInGroupList(task, groupListIds()));
}

/**
 * Opens a task of the list: a follow-up's mail (lib: `openTaskItem`), a group
 * mailbox's follow-up without a mail in the follow-up dialog, which writes
 * it into the group's list; any other task in the task editor, as always.
 */
export async function openListedTask(
  client: IJMAPClient | null,
  task: CalendarTask,
  ways: { edit: (task: CalendarTask) => void; openMail: (emailId: string, mailAccountId: string | null) => void; mailGone: string },
): Promise<void> {
  if (client && opensMail(task)) {
    await openTaskItem(client, task, ways.openMail, ways.mailGone);
    return;
  }
  if (isGroupFollowUpTask(task, groupListIds()) && isGroupTask(task)) {
    useFollowUpDialog.getState().openReminder({ taskId: task.id });
    return;
  }
  ways.edit(task);
}

/**
 * Toggles a task as the list's check box always did (`toggleTaskComplete`,
 * which plugins see as `onTaskToggleComplete`), a group list's task also in
 * the group lists' store, so its chips and reminders follow at once.
 */
async function toggleInStores(client: IJMAPClient, task: CalendarTask): Promise<boolean> {
  const completing = task.progress !== "completed";
  const patch = completing ? completedTaskPatch(task, new Date()) : { progress: "needs-action" as const };
  await useTaskStore.getState().toggleTaskComplete(client, task);
  if (isGroupTask(task)) useGroupTasks.getState().applyLocal(task.id, patch);
  return true;
}

/**
 * The list's check box: one write, the toggle it always was. Completing a
 * follow-up on the user's own mail clears the mail's flag too, as its "Mark
 * complete" does. A cancelled task is completed by it, as before.
 */
export async function toggleListedTask(
  client: IJMAPClient,
  task: CalendarTask,
  messages: { failed: string; flagFailed: string },
): Promise<void> {
  const inGroupStore = isGroupTask(task);
  try {
    if (isOpenFollowUp(task) && !task.isShared && followUpMailRef(task)) {
      await completeTask(client, task, messages, undefined, () => toggleInStores(client, task));
    } else {
      await toggleInStores(client, task);
    }
    // A group list's task the group store does not hold (done ones are not kept): read the lists again.
    if (!inGroupStore && task.isShared && isInGroupList(task, groupListIds())) scheduleGroupRefresh(client, PUSH_DEBOUNCE_MS);
  } catch (error) {
    debug.error("task list: not toggled", error);
    toast.error(messages.failed);
  }
}
