import { create } from "zustand";
import type { Email } from "@/lib/jmap/types";

/** Where the follow-up dialog puts the cursor first. */
export type FollowUpDialogFocus = "action" | "reminder";

/** A reminder without a mail in the dialog: an existing task, or a new one with what was typed. */
export interface ReminderDialogTarget {
  /** The task, or null for a new reminder. */
  taskId: string | null;
  /** What a new reminder is to say, as typed so far. */
  title?: string;
}

/** A follow-up in a group mailbox's task list: an existing one, or a new one (null). */
export interface GroupDialogTarget {
  taskId: string | null;
}

interface FollowUpDialogState {
  /** The mail whose follow-up the dialog edits, null while it is closed or shows a reminder. */
  email: Email | null;
  /** Set when the dialog edits a follow-up in the group's task list instead of the user's own. */
  group: GroupDialogTarget | null;
  /** The reminder without a mail the dialog edits, null while it is closed or shows a mail's. */
  reminder: ReminderDialogTarget | null;
  focus: FollowUpDialogFocus;
  open: (email: Email, focus?: FollowUpDialogFocus, group?: GroupDialogTarget | null) => void;
  openReminder: (reminder: ReminderDialogTarget, focus?: FollowUpDialogFocus) => void;
  close: () => void;
}

/**
 * The one follow-up dialog of the mail view (`FollowUpDialogHost`), opened
 * from any row, menu or bar for a mail, and from the pane "Upcoming" for a
 * reminder without one.
 */
export const useFollowUpDialog = create<FollowUpDialogState>((set) => ({
  email: null,
  group: null,
  reminder: null,
  focus: "action",
  open: (email, focus = "action", group = null) => set({ email, group, reminder: null, focus }),
  openReminder: (reminder, focus = "action") => set({ email: null, group: null, reminder, focus }),
  close: () => set({ email: null, group: null, reminder: null }),
}));
