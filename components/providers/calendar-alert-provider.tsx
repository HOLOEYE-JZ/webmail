"use client";

import { useCalendarAlerts } from '@/hooks/use-calendar-alerts';
import { useFollowUpSync } from '@/hooks/use-follow-up-sync';
import { useFollowUpReplies } from '@/hooks/use-follow-up-replies';
import { useTaskReminders } from '@/hooks/use-task-reminders';
import { useGroupTasksLoaded } from '@/hooks/use-group-follow-ups';
import { RemindersWindowHost } from '@/components/email/reminders-window';
import { ToastContainer } from '@/components/ui/toast';
import { useToastStore } from '@/stores/toast-store';

export function CalendarAlertProvider({ children }: { children: React.ReactNode }) {
  useCalendarAlerts();
  // Follow-ups: the mail's flag and its task kept in step, in every view.
  useFollowUpSync();
  // Follow-ups that settle themselves when an answer comes: the answer looked for.
  useFollowUpReplies();
  // A group mailbox's task list: its follow-ups at the mails, its reminders for the user.
  useGroupTasksLoaded();
  // Task reminders: the toast, then the window "n reminders".
  useTaskReminders();

  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <>
      {children}
      <RemindersWindowHost />
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>
  );
}
