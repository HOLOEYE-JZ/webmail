import { create } from 'zustand';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';
import { taskHooks } from '@/lib/plugin-hooks';
import { taskToView } from '@/lib/plugin-projection';

export type TaskViewFilter = 'all' | 'pending' | 'completed' | 'overdue';

interface TaskStore {
  tasks: CalendarTask[];
  selectedTaskId: string | null;
  filter: TaskViewFilter;
  showCompleted: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * The calendars the last fetch read, or undefined for all of them. A push
   * refetches the same scope, so the mail view's few calendars (follow-ups)
   * do not turn into a reload of every account's calendars.
   */
  scope: string[] | undefined;
  /**
   * The client whose fetch the list holds, null while none has finished, the
   * last one could not read every task, or a fetch of another scope is under
   * way. Only then does a task missing from the list mean that it was deleted.
   */
  loadedBy: IJMAPClient | null;
  setTasks: (tasks: CalendarTask[]) => void;
  setSelectedTaskId: (id: string | null) => void;
  setFilter: (filter: TaskViewFilter) => void;
  setShowCompleted: (show: boolean) => void;
  fetchTasks: (client: IJMAPClient, calendarIds?: string[]) => Promise<void>;
  /** Resolves to null when a plugin stopped the create. */
  createTask: (client: IJMAPClient, task: Partial<CalendarTask>) => Promise<CalendarTask | null>;
  /** false when a plugin stopped it (the plugin tells the user why). */
  updateTask: (client: IJMAPClient, id: string, updates: Partial<CalendarTask>) => Promise<boolean>;
  deleteTask: (client: IJMAPClient, id: string) => Promise<boolean>;
  toggleTaskComplete: (client: IJMAPClient, task: CalendarTask) => Promise<void>;
  clearTasks: () => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  filter: 'all',
  showCompleted: false,
  isLoading: false,
  error: null,
  scope: undefined,
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

  fetchTasks: async (client, calendarIds) => {
    debug.log('tasks', 'TaskStore/fetchTasks start', { calendarIds: calendarIds || 'all' });
    const scope = calendarIds?.length ? [...calendarIds] : undefined;
    // A fetch started later for another scope makes this one's list partial.
    const stillCurrent = () => get().scope === scope;
    set({ isLoading: true, error: null, scope, loadedBy: null });
    try {
      // Only a list read in full counts as loaded: follow-ups take a task
      // missing from it for deleted.
      const { tasks, complete } = client.getCalendarTaskList
        ? await client.getCalendarTaskList(calendarIds)
        : { tasks: await client.getCalendarTasks(calendarIds), complete: false };
      debug.log('tasks', 'TaskStore/fetchTasks received', tasks.length, 'tasks');
      tasks.forEach((t, i) => {
        debug.log('tasks', `TaskStore/fetchTasks [${i}]`, {
          id: t.id, uid: t.uid, '@type': t['@type'],
          title: t.title, due: t.due, progress: t.progress,
          showWithoutTime: t.showWithoutTime, calendarIds: t.calendarIds,
        });
      });
      set({ tasks, isLoading: false, loadedBy: complete && stillCurrent() ? client : null });
      if (taskHooks.onTasksLoaded.size > 0) void taskHooks.onTasksLoaded.emit(tasks.map(taskToView));
    } catch (error) {
      debug.error('TaskStore/fetchTasks failed', error);
      set({ isLoading: false, error: 'Failed to fetch tasks' });
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

  updateTask: async (client, id, updates) => {
    if (!(await taskHooks.onBeforeTaskUpdate.intercept({ taskId: id, patch: updates }))) return false;
    const before = get().tasks.find(t => t.id === id);
    const newId = await client.updateCalendarTask(id, updates);
    if (newId && newId !== id) {
      // Moved into a calendar of another account: the server recreated it
      // under a new id, so reload rather than patch the old entry. (#1204)
      set({ selectedTaskId: get().selectedTaskId === id ? newId : get().selectedTaskId });
      await get().fetchTasks(client, get().scope);
      const moved = get().tasks.find(t => t.id === newId)
        ?? ({ ...before, ...updates, id: newId } as CalendarTask);
      void taskHooks.onTaskUpdate.emit(taskToView(moved));
      return true;
    }
    const updated = { ...(before ?? { id }), ...updates, updated: new Date().toISOString() } as CalendarTask;
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
    const updates: Partial<CalendarTask> = {
      progress: newProgress,
    };
    await client.updateCalendarTask(task.id, updates);
    set({
      tasks: get().tasks.map(t => t.id === task.id ? { ...t, ...updates, updated: new Date().toISOString() } : t),
    });
    // A toggle is reported as onTaskToggleComplete only, not also as
    // onTaskUpdate, so a plugin that listens to both sees each change once.
    void taskHooks.onTaskToggleComplete.emit({ taskId: task.id, complete: newProgress === 'completed' });
  },

  clearTasks: () => set({ tasks: [], selectedTaskId: null, error: null, scope: undefined, loadedBy: null }),
}));
