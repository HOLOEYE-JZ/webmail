import { create } from 'zustand';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';
import { taskHooks } from '@/lib/plugin-hooks';
import { taskToView } from '@/lib/plugin-projection';
import { applyPatchObject, patchedProperties } from '@/lib/jmap/patch-object';
import { completedTaskPatch, withCompletion } from '@/lib/task-reminders';
import type { TaskListScope } from '@/lib/task-list';

export type TaskViewFilter = 'all' | 'pending' | 'completed' | 'overdue';

/**
 * The `error` a failed task load leaves. The tasks loaded before stay; the
 * task list shows a notice for it.
 */
export const TASKS_LOAD_ERROR = 'Failed to fetch tasks';

interface TaskStore {
  tasks: CalendarTask[];
  selectedTaskId: string | null;
  filter: TaskViewFilter;
  showCompleted: boolean;
  /**
   * Which tasks the task list shows: the calendars shown, the user's, or a
   * group mailbox's list (lib/task-list.ts). A filter of what is loaded.
   */
  listScope: TaskListScope;
  isLoading: boolean;
  error: string | null;
  /**
   * The calendars the last fetch read, or undefined for all of them (not to
   * be confused with `listScope`, which tasks the list shows). A push
   * refetches the same calendars, so the mail view's few (follow-ups) do not
   * turn into a reload of every account's calendars. A fetch never narrows
   * them for the same client: asked for fewer, it reads these too.
   */
  fetchedCalendarIds: string[] | undefined;
  /**
   * The client whose fetch the list holds, null while none has finished, the
   * last one could not read every task, or another fetch is under way. Only
   * then does a task missing from the list mean that it was deleted.
   */
  loadedBy: IJMAPClient | null;
  setTasks: (tasks: CalendarTask[]) => void;
  setSelectedTaskId: (id: string | null) => void;
  setFilter: (filter: TaskViewFilter) => void;
  setShowCompleted: (show: boolean) => void;
  setListScope: (scope: TaskListScope) => void;
  fetchTasks: (client: IJMAPClient, calendarIds?: string[]) => Promise<void>;
  /** Resolves to null when a plugin stopped the create. */
  createTask: (client: IJMAPClient, task: Partial<CalendarTask>) => Promise<CalendarTask | null>;
  /** false when a plugin stopped it (the plugin tells the user why). */
  updateTask: (client: IJMAPClient, id: string, updates: Partial<CalendarTask>) => Promise<boolean>;
  deleteTask: (client: IJMAPClient, id: string) => Promise<boolean>;
  toggleTaskComplete: (client: IJMAPClient, task: CalendarTask) => Promise<void>;
  clearTasks: () => void;
}

// Each fetch gets a number: only the latest one's answer is kept, so an
// answer that comes late never puts an older list back.
let latestFetch = 0;
// The client `fetchedCalendarIds` were fetched for, null before any fetch.
let fetchedFor: IJMAPClient | null = null;

/**
 * The calendars a fetch reads: never fewer than the list holds already for
 * the same client, so a view that needs a few (the mail view's follow-ups)
 * does not drop the tasks of the others, whose reminders would then stop.
 * Undefined is every calendar.
 */
function widenedScope(held: string[] | undefined, asked: string[] | undefined): string[] | undefined {
  if (!asked?.length || !held) return undefined;
  return [...new Set([...held, ...asked])];
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  filter: 'all',
  showCompleted: false,
  listScope: 'all',
  isLoading: false,
  error: null,
  fetchedCalendarIds: undefined,
  loadedBy: null,
  setTasks: (tasks) => set({ tasks }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter });
    void taskHooks.onTaskFilterChange.emit({ filter, showCompleted: get().showCompleted });
  },
  setShowCompleted: (show) => {
    if (get().showCompleted === show) return;
    set({ showCompleted: show });
    void taskHooks.onTaskFilterChange.emit({ filter: get().filter, showCompleted: show });
  },
  setListScope: (listScope) => set({ listScope }),

  fetchTasks: async (client, calendarIds) => {
    debug.log('tasks', 'TaskStore/fetchTasks start', { calendarIds: calendarIds || 'all' });
    const asked = calendarIds?.length ? [...calendarIds] : undefined;
    const ids = fetchedFor === client ? widenedScope(get().fetchedCalendarIds, asked) : asked;
    fetchedFor = client;
    const fetch = ++latestFetch;
    const stillCurrent = () => fetch === latestFetch;
    set({ isLoading: true, error: null, fetchedCalendarIds: ids, loadedBy: null });
    try {
      // Only a list read in full counts as loaded: follow-ups take a task
      // missing from it for deleted.
      const { tasks, complete } = client.getCalendarTaskList
        ? await client.getCalendarTaskList(ids)
        : { tasks: await client.getCalendarTasks(ids), complete: false };
      // A fetch started later decides the list.
      if (!stillCurrent()) return;
      debug.log('tasks', 'TaskStore/fetchTasks received', tasks.length, 'tasks');
      tasks.forEach((t, i) => {
        debug.log('tasks', `TaskStore/fetchTasks [${i}]`, {
          id: t.id, uid: t.uid, '@type': t['@type'],
          title: t.title, due: t.due, progress: t.progress,
          showWithoutTime: t.showWithoutTime, calendarIds: t.calendarIds,
        });
      });
      set({ tasks, isLoading: false, loadedBy: complete ? client : null });
      if (taskHooks.onTasksLoaded.size > 0) void taskHooks.onTasksLoaded.emit(tasks.map(taskToView));
    } catch (error) {
      debug.error('TaskStore/fetchTasks failed', error);
      if (stillCurrent()) set({ isLoading: false, error: TASKS_LOAD_ERROR });
    }
  },

  createTask: async (client, task) => {
    debug.log('tasks', 'TaskStore/createTask', task);
    if (!(await taskHooks.onBeforeTaskCreate.intercept(taskToView({ id: '', ...task } as CalendarTask)))) return null;
    const created = await client.createCalendarTask(task);
    debug.log('tasks', 'TaskStore/createTask result', { id: created.id, uid: created.uid, title: created.title });
    set({ tasks: [...get().tasks, created] });
    void taskHooks.onTaskCreate.emit(taskToView(created));
    return created;
  },

  updateTask: async (client, id, patch) => {
    const before = get().tasks.find(t => t.id === id);
    // Completed from any form (the task modal too): its fired reminders
    // dismissed and its alarm mail taken off, as Mark Complete does.
    const updates = withCompletion(before, patch, new Date());
    // Plugins read the patch as whole properties, as before paths were
    // written: a member changed by path shows as its property after the change.
    const pluginPatch = patchedProperties(before ?? { id }, updates);
    if (!(await taskHooks.onBeforeTaskUpdate.intercept({ taskId: id, patch: pluginPatch }))) return false;
    const newId = await client.updateCalendarTask(id, updates);
    if (newId && newId !== id) {
      // Moved into a calendar of another account: the server recreated it
      // under a new id, so reload rather than patch the old entry. (#1204)
      set({ selectedTaskId: get().selectedTaskId === id ? newId : get().selectedTaskId });
      await get().fetchTasks(client, get().fetchedCalendarIds);
      const moved = get().tasks.find(t => t.id === newId)
        ?? ({ ...applyPatchObject(before ?? {}, updates), id: newId } as CalendarTask);
      void taskHooks.onTaskUpdate.emit(taskToView(moved));
      return true;
    }
    // `updates` may name members by path (`alerts/<id>/acknowledged`).
    const updated = { ...applyPatchObject(before ?? { id }, updates), updated: new Date().toISOString() } as CalendarTask;
    set({
      tasks: get().tasks.map(t => t.id === id ? updated : t),
    });
    void taskHooks.onTaskUpdate.emit(taskToView(updated));
    return true;
  },

  deleteTask: async (client, id) => {
    const title = get().tasks.find(t => t.id === id)?.title || '';
    if (!(await taskHooks.onBeforeTaskDelete.intercept({ taskId: id, title }))) return false;
    await client.deleteCalendarTask(id);
    set({
      tasks: get().tasks.filter(t => t.id !== id),
      selectedTaskId: get().selectedTaskId === id ? null : get().selectedTaskId,
    });
    void taskHooks.onTaskDelete.emit({ taskId: id, title });
    return true;
  },

  toggleTaskComplete: async (client, task) => {
    const newProgress = task.progress === 'completed' ? 'needs-action' : 'completed';
    // Completing dismisses the reminders that have fired, as Outlook's Mark
    // Complete: reopened, the task does not remind of them again.
    const updates: Partial<CalendarTask> = newProgress === 'completed'
      ? completedTaskPatch(task, new Date())
      : { progress: newProgress };
    await client.updateCalendarTask(task.id, updates);
    set({
      tasks: get().tasks.map(t => t.id === task.id ? { ...applyPatchObject(t, updates), updated: new Date().toISOString() } : t),
    });
    // A toggle is reported as onTaskToggleComplete only, not also as
    // onTaskUpdate, so a plugin that listens to both sees each change once.
    void taskHooks.onTaskToggleComplete.emit({ taskId: task.id, complete: newProgress === 'completed' });
  },

  clearTasks: () => {
    latestFetch += 1;
    fetchedFor = null;
    set({ tasks: [], selectedTaskId: null, error: null, isLoading: false, fetchedCalendarIds: undefined, loadedBy: null });
  },
}));
