import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '../task-store';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { dueTaskReminders } from '@/lib/task-reminders';

function makeTask(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'task-1',
    calendarIds: { 'cal-1': true },
    '@type': 'Task',
    uid: 'task-uid-1',
    title: 'Test task',
    description: '',
    due: '2026-09-08T10:00:00',
    start: null,
    duration: null,
    timeZone: null,
    showWithoutTime: false,
    progress: 'needs-action',
    priority: 0,
    privacy: 'public',
    keywords: null,
    categories: null,
    color: null,
    created: '2026-09-01T10:00:00Z',
    updated: '2026-09-01T10:00:00Z',
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
    ...overrides,
  };
}

describe('task-store', () => {
  let mockClient: Partial<IJMAPClient>;

  beforeEach(() => {
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      filter: 'all',
      showCompleted: false,
      isLoading: false,
      error: null,
    });

    mockClient = {
      getCalendarTasks: vi.fn().mockResolvedValue([makeTask()]),
      createCalendarTask: vi.fn().mockImplementation(async (t) => makeTask({ id: 'task-created', ...t })),
      updateCalendarTask: vi.fn().mockResolvedValue(undefined),
      deleteCalendarTask: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('toggleTaskComplete', () => {
    it('toggles needs-action to completed without sending progressUpdated in payload (#958)', async () => {
      const task = makeTask({ id: 't1', progress: 'needs-action' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

      expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
      const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledId).toBe('t1');
      expect(calledUpdates).toEqual({
        progress: 'completed',
      });
      // Stalwart rejects progressUpdated with invalidProperties error
      expect(calledUpdates).not.toHaveProperty('progressUpdated');

      const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't1');
      expect(updatedTask?.progress).toBe('completed');
    });

    it('completing dismisses the reminders that fired, by path, and keeps those to come', async () => {
      const alert = (when: string) => ({ '@type': 'Alert' as const, trigger: { '@type': 'AbsoluteTrigger' as const, when }, action: 'display' as const, acknowledged: null, relatedTo: null });
      const fired = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const later = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const task = makeTask({ id: 't3', progress: 'needs-action', alerts: { a: alert(fired), b: alert(later) } });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

      const [, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(Object.keys(calledUpdates).sort()).toEqual(['alerts/a/acknowledged', 'progress']);
      const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't3');
      expect(updatedTask?.alerts?.a.acknowledged).toBe(calledUpdates['alerts/a/acknowledged']);
      expect(updatedTask?.alerts?.b).toEqual(alert(later));
      expect(updatedTask).not.toHaveProperty(['alerts/a/acknowledged']);
    });

    it('toggles completed back to needs-action without sending progressUpdated in payload', async () => {
      const task = makeTask({ id: 't2', progress: 'completed' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

      expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
      const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledId).toBe('t2');
      expect(calledUpdates).toEqual({
        progress: 'needs-action',
      });
      expect(calledUpdates).not.toHaveProperty('progressUpdated');

      const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't2');
      expect(updatedTask?.progress).toBe('needs-action');
    });
  });

  describe('CRUD operations', () => {
    it('fetches tasks and updates store state', async () => {
      await useTaskStore.getState().fetchTasks(mockClient as IJMAPClient, ['cal-1']);

      expect(mockClient.getCalendarTasks).toHaveBeenCalledWith(['cal-1']);
      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().isLoading).toBe(false);
      expect(useTaskStore.getState().error).toBeNull();
    });

    it('drops the answer of a fetch that a later one overtook', async () => {
      const answers: ((list: { tasks: CalendarTask[]; complete: boolean }) => void)[] = [];
      const client = {
        ...mockClient,
        getCalendarTaskList: vi.fn().mockImplementation(() => new Promise((resolve) => { answers.push(resolve); })),
      } as IJMAPClient;
      const first = useTaskStore.getState().fetchTasks(client);
      const second = useTaskStore.getState().fetchTasks(client);
      answers[1]({ tasks: [makeTask({ id: 'new' })], complete: true });
      await second;
      answers[0]({ tasks: [makeTask({ id: 'old' })], complete: true });
      await first;

      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['new']);
      expect(useTaskStore.getState().loadedBy).toBe(client);
      expect(useTaskStore.getState().isLoading).toBe(false);
    });

    it('never narrows a list loaded in full: other calendars keep their reminders when the mail view asks for its few', async () => {
      const fired = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const reminder = { '@type': 'Alert' as const, trigger: { '@type': 'AbsoluteTrigger' as const, when: fired }, action: 'display' as const, acknowledged: null, relatedTo: null };
      const all = [
        makeTask({ id: 'mine', calendarIds: { 'cal-1': true } }),
        makeTask({ id: 'elsewhere', calendarIds: { 'cal-2': true }, alerts: { a: reminder } }),
      ];
      const getCalendarTaskList = vi.fn().mockImplementation(async (ids?: string[]) => ({
        tasks: ids ? all.filter((t) => Object.keys(t.calendarIds).some((id) => ids.includes(id))) : all,
        complete: true,
      }));
      const client = { ...mockClient, getCalendarTaskList } as IJMAPClient;

      await useTaskStore.getState().fetchTasks(client);
      // The mail view's follow-up calendars, then a push refetching the scope.
      await useTaskStore.getState().fetchTasks(client, ['cal-1']);
      await useTaskStore.getState().fetchTasks(client, useTaskStore.getState().scope);

      expect(getCalendarTaskList).toHaveBeenLastCalledWith(undefined);
      expect(useTaskStore.getState().scope).toBeUndefined();
      expect(dueTaskReminders(useTaskStore.getState().tasks, Date.now()).map((r) => r.task.id)).toEqual(['elsewhere']);
    });

    it('widens a scope by the calendars asked for, and starts afresh for another client', async () => {
      const getCalendarTaskList = vi.fn().mockResolvedValue({ tasks: [], complete: true });
      const client = { ...mockClient, getCalendarTaskList } as IJMAPClient;
      await useTaskStore.getState().fetchTasks(client, ['cal-1']);
      await useTaskStore.getState().fetchTasks(client, ['cal-2']);
      expect(getCalendarTaskList).toHaveBeenLastCalledWith(['cal-1', 'cal-2']);

      const other = { ...mockClient, getCalendarTaskList } as IJMAPClient;
      await useTaskStore.getState().fetchTasks(other, ['cal-9']);
      expect(getCalendarTaskList).toHaveBeenLastCalledWith(['cal-9']);
    });

    it('creates a task and appends to store', async () => {
      const created = await useTaskStore.getState().createTask(mockClient as IJMAPClient, { title: 'New Task' });

      expect(mockClient.createCalendarTask).toHaveBeenCalledWith({ title: 'New Task' });
      expect(created?.id).toBe('task-created');
      expect(useTaskStore.getState().tasks).toContainEqual(created);
    });

    it('updates a task and preserves unchanged fields', async () => {
      const task = makeTask({ id: 't3', title: 'Original Title' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().updateTask(mockClient as IJMAPClient, 't3', { title: 'Updated Title' });

      expect(mockClient.updateCalendarTask).toHaveBeenCalledWith('t3', { title: 'Updated Title' });
      const updated = useTaskStore.getState().tasks.find((t) => t.id === 't3');
      expect(updated?.title).toBe('Updated Title');
      expect(updated?.progress).toBe('needs-action');
    });

    it('a save that completes the task (the task modal) dismisses what fired and takes its own alarm mail off', async () => {
      const alert = (when: string, action: 'display' | 'email' = 'display') => ({ '@type': 'Alert' as const, trigger: { '@type': 'AbsoluteTrigger' as const, when }, action, acknowledged: null, relatedTo: null });
      const fired = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const task = makeTask({ id: 't5', alerts: { 'follow-up': alert(fired), 'follow-up-mail': alert(fired, 'email'), phone: alert(fired, 'email') } });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().updateTask(mockClient as IJMAPClient, 't5', { title: 'Done now', progress: 'completed' });

      const [, sent] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(Object.keys(sent).sort()).toEqual(['alerts/follow-up-mail', 'alerts/follow-up/acknowledged', 'progress', 'title']);
      const updated = useTaskStore.getState().tasks.find((t) => t.id === 't5');
      expect(Object.keys(updated?.alerts ?? {}).sort()).toEqual(['follow-up', 'phone']);

      // Written once: a second save of a completed task changes no alert.
      await useTaskStore.getState().updateTask(mockClient as IJMAPClient, 't5', { progress: 'completed' });
      expect((mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual({ progress: 'completed' });
    });

    it('reloads the list when a move to a shared calendar gives the task a new id (#1204)', async () => {
      useTaskStore.setState({ tasks: [makeTask({ id: 't5' })], selectedTaskId: 't5' });
      (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mockResolvedValue('acct-2:new');
      (mockClient.getCalendarTasks as ReturnType<typeof vi.fn>).mockResolvedValue([makeTask({ id: 'acct-2:new' })]);

      await useTaskStore.getState().updateTask(mockClient as IJMAPClient, 't5', { calendarIds: { 'acct-2:cal-s': true } });

      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['acct-2:new']);
      expect(useTaskStore.getState().selectedTaskId).toBe('acct-2:new');
    });

    it('deletes a task and resets selectedTaskId if selected', async () => {
      const task = makeTask({ id: 't4' });
      useTaskStore.setState({ tasks: [task], selectedTaskId: 't4' });

      await useTaskStore.getState().deleteTask(mockClient as IJMAPClient, 't4');

      expect(mockClient.deleteCalendarTask).toHaveBeenCalledWith('t4');
      expect(useTaskStore.getState().tasks).toHaveLength(0);
      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });
});
