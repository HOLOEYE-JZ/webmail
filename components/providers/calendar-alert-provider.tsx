"use client";

import { useCalendarAlerts } from '@/hooks/use-calendar-alerts';
import { useFollowUpSync } from '@/hooks/use-follow-up-sync';
import { ToastContainer } from '@/components/ui/toast';
import { useToastStore } from '@/stores/toast-store';

export function CalendarAlertProvider({ children }: { children: React.ReactNode }) {
  useCalendarAlerts();
  // Follow-ups: the mail's flag and its task kept in step, in every view.
  useFollowUpSync();

  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>
  );
}
