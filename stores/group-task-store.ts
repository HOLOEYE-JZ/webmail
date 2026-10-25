import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { debug } from "@/lib/debug";
import { reachesMailAccount } from "@/lib/deep-links";
import { cachedPrincipals } from "@/lib/jmap/principal-cache";
import { applyPatchObject } from "@/lib/jmap/patch-object";
import { groupTaskList, isGroupAccount, keptGroupTasks, type GroupTaskList } from "@/lib/group-follow-ups";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

/**
 * The task lists of the group mailboxes the user reaches, and their tasks
 * (lib/group-follow-ups.ts; read by hooks/use-group-follow-ups.ts). Kept
 * apart from the task store, which holds the user's own list: keeping the
 * flags in step and the pane read that one alone, and a group account that
 * cannot be read never makes the own list count as read in part. Only one list per group account is read, the one follow-ups
 * go into, so the cost stays that of the groups the user is in.
 */

interface GroupTaskState {
  lists: GroupTaskList[];
  tasks: CalendarTask[];
  /** The client the lists were read with, null before. */
  loadedBy: IJMAPClient | null;
  refresh: (client: IJMAPClient) => Promise<void>;
  /** Applies a written change here at once (null: deleted). */
  applyLocal: (id: string, patch: object | null) => void;
  addLocal: (task: CalendarTask) => void;
  clear: () => void;
}

/** The group lists found, and whether the directory could be read to tell them. */
export interface GroupTaskListsFound {
  lists: GroupTaskList[];
  /** False when shared accounts were there but the directory listed nothing: asked again later. */
  directoryRead: boolean;
}

/**
 * The group accounts' task lists among `calendars`: shared accounts the
 * login reaches for mail too, which the directory names as groups. Without
 * the directory (not offered, failed, empty) none.
 */
export async function findGroupTaskLists(client: IJMAPClient, calendars: readonly Calendar[]): Promise<GroupTaskListsFound> {
  const accountIds = [...new Set(calendars.filter((c) => c.isShared && c.accountId).map((c) => c.accountId as string))]
    .filter((id) => id !== client.getAccountId() && reachesMailAccount(client, id));
  if (accountIds.length === 0) return { lists: [], directoryRead: true };
  // An empty answer is not kept by the cache: the next call asks again.
  const principals = await cachedPrincipals(client);
  if (principals.length === 0) return { lists: [], directoryRead: false };
  const lists: GroupTaskList[] = [];
  for (const accountId of accountIds) {
    if (!isGroupAccount(accountId, principals)) continue;
    const list = groupTaskList(calendars, accountId);
    if (list) lists.push({ accountId, name: list.accountName || accountId, list });
  }
  return { lists: lists.sort((a, b) => a.name.localeCompare(b.name)), directoryRead: true };
}

/** How long pushes are gathered before the lists are read again. */
export const PUSH_DEBOUNCE_MS = 1_500;
/** When a directory that could not be read is asked again. */
export const DIRECTORY_RETRY_MS = 60_000;

// Each read gets a number: an answer of an older read than the latest is
// dropped, so a late one never overwrites newer state.
let generation = 0;
// Bumped by every write applied here: a read begun before it is dropped and
// made again, so it does not undo the write in the store.
let localVersion = 0;
let scheduled: ReturnType<typeof setTimeout> | null = null;

/** Reads the group lists again after `delayMs`; calls meanwhile are gathered into one. */
export function scheduleGroupRefresh(client: IJMAPClient, delayMs: number): void {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    if (useAuthStore.getState().client === client) void useGroupTasks.getState().refresh(client);
  }, delayMs);
}

export const useGroupTasks = create<GroupTaskState>((set, get) => ({
  lists: [],
  tasks: [],
  loadedBy: null,
  refresh: async (client) => {
    const mine = ++generation;
    const local = localVersion;
    const current = () => mine === generation && useAuthStore.getState().client === client;
    try {
      const { lists, directoryRead } = await findGroupTaskLists(client, useCalendarStore.getState().calendars);
      if (!current()) return;
      if (!directoryRead) scheduleGroupRefresh(client, DIRECTORY_RETRY_MS);
      if (lists.length === 0) {
        set({ lists, tasks: [], loadedBy: client });
        return;
      }
      const ids = lists.map((l) => l.list.id);
      const { tasks } = client.getCalendarTaskList
        ? await client.getCalendarTaskList(ids)
        : { tasks: await client.getCalendarTasks(ids) };
      if (!current()) return;
      if (local !== localVersion) {
        // Written meanwhile: read again rather than put back what was there before.
        scheduleGroupRefresh(client, PUSH_DEBOUNCE_MS);
        return;
      }
      set({ lists, tasks: keptGroupTasks(tasks, new Set(ids)), loadedBy: client });
    } catch (error) {
      debug.error("group follow-ups: not loaded", error);
    }
  },
  applyLocal: (id, patch) => {
    localVersion += 1;
    set({
      tasks: patch === null
        ? get().tasks.filter((t) => t.id !== id)
        : get().tasks.map((t) => (t.id === id ? { ...applyPatchObject(t, patch), updated: new Date().toISOString() } : t)),
    });
  },
  addLocal: (task) => {
    localVersion += 1;
    set({ tasks: [...get().tasks.filter((t) => t.id !== task.id), task] });
  },
  clear: () => {
    generation += 1;
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    set({ lists: [], tasks: [], loadedBy: null });
  },
}));

/**
 * After a push naming a change of calendars in an account other than the
 * login's own: the group lists are read again when one lies there.
 */
export function refreshGroupTasksFor(client: IJMAPClient, changedAccountIds: readonly string[]): void {
  const state = useGroupTasks.getState();
  if (state.loadedBy !== client) return;
  if (state.lists.some((l) => changedAccountIds.includes(l.accountId))) scheduleGroupRefresh(client, PUSH_DEBOUNCE_MS);
}
