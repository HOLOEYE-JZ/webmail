"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Bell, Mail, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useTaskStore } from "@/stores/task-store";
import { toast } from "@/stores/toast-store";
import { completeTask, useWorkingTime } from "@/hooks/use-follow-ups";
import { openTaskItem } from "@/hooks/use-upcoming";
import {
  openReminderMail,
  useDueTaskReminders,
  useReminderText,
  useRemindersWindow,
} from "@/hooks/use-task-reminders";
import { useFollowUpFormat } from "@/components/email/follow-up";
import { debug } from "@/lib/debug";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { followUpMailSummary, followUpState } from "@/lib/follow-ups";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import {
  DEFAULT_SNOOZE,
  dismissTaskReminder,
  snoozeTaskReminder,
  snoozeTimes,
  type SnoozeChoice,
  type TaskReminder,
} from "@/lib/task-reminders";

/**
 * The reminders window, shown over every view while reminders stand and the
 * user has not closed it. Mounted once.
 */
export function RemindersWindowHost() {
  const open = useRemindersWindow((s) => s.open);
  const hide = useRemindersWindow((s) => s.hide);
  const reminders = useDueTaskReminders();
  const empty = reminders.length === 0;
  useEffect(() => {
    if (open && empty) hide();
  }, [open, empty, hide]);
  if (!open || empty) return null;
  return <RemindersWindow reminders={reminders} onClose={hide} />;
}

/**
 * "n reminders", as Outlook's: one row per task whose reminder fell due, the
 * selected one opened, completed, dismissed or snoozed. Not modal: the mail a
 * row opens is read beside it, then marked complete here. Closing the window
 * leaves the reminders standing; it comes again with the next one, or at the
 * next start.
 */
export function RemindersWindow({ reminders, onClose }: {
  reminders: TaskReminder[];
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const format = useFormatter();
  const fmt = useFollowUpFormat();
  const text = useReminderText();
  const router = useRouter();
  const proShell = useProInterfaceActive();
  const client = useAuthStore((s) => s.client);
  const workingTime = useWorkingTime();
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snooze, setSnooze] = useState<SnoozeChoice>(DEFAULT_SNOOZE);
  const [busy, setBusy] = useState(false);

  // The row chosen, else the first: a row that goes (done elsewhere) moves the choice on.
  const selected = reminders.find((r) => r.task.id === selectedId) ?? reminders[0];
  const now = displayNow();

  const times = useMemo(
    () => snoozeTimes(selected.task, new Date(), displayNow(), workingTime, fromDisplayDate),
    // Worked out again for another row; the minutes count from when the button is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected.task, workingTime, reminders],
  );
  const choice = times.some((x) => x.choice === snooze) ? snooze : DEFAULT_SNOOZE;

  const snoozeLabel = (c: SnoozeChoice, at: Date) => {
    const when = fmt.reminder(at, now);
    switch (c) {
      case "5m": return t("reminders.snooze_choices.5m");
      case "15m": return t("reminders.snooze_choices.15m");
      case "1h": return t("reminders.snooze_choices.1h");
      case "4h": return t("reminders.snooze_choices.4h");
      case "tomorrow": return t("reminders.snooze_choices.tomorrow", { when });
      case "next-week": return t("reminders.snooze_choices.next_week", { when, weekday: format.dateTime(at, { weekday: "long" }) });
      case "due-day": return t("reminders.snooze_choices.due_day", { when });
    }
  };

  /** Runs one change of the selected reminder (or all); a failure is said, the window stays. */
  const run = async (write: () => Promise<unknown>) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await write();
    } catch (error) {
      debug.error("reminders: not written", error);
      toast.error(t("reminders.failed"));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = (r: TaskReminder) => run(() => (
    useTaskStore.getState().updateTask(client!, r.task.id, dismissTaskReminder(r.task, r.alertIds, new Date()))
  ));

  const dismissAll = () => run(async () => {
    const at = new Date();
    for (const r of reminders) {
      await useTaskStore.getState().updateTask(client!, r.task.id, dismissTaskReminder(r.task, r.alertIds, at));
    }
  });

  const snoozeSelected = () => run(async () => {
    // From the moment the button is pressed, not from when the window opened.
    const at = snoozeTimes(selected.task, new Date(), displayNow(), workingTime, fromDisplayDate)
      .find((x) => x.choice === choice)?.at;
    if (!at) return;
    await useTaskStore.getState().updateTask(client!, selected.task.id, snoozeTaskReminder(selected.task, selected.alertIds, at, new Date()));
  });

  // A mail's follow-up as the mail's own "Mark complete": its flag goes too.
  const done = (r: TaskReminder) => run(() => completeTask(client!, r.task, { failed: t("failed"), flagFailed: t("flag_failed") }));

  const open = (r: TaskReminder) => {
    if (!client) return;
    const title = followUpMailSummary(r.task).subject || t("no_subject");
    const openMail = (emailId: string, mailAccountId: string | null) =>
      openReminderMail(emailId, mailAccountId, { proShell, navigate: (path) => router.push(path), title });
    void openTaskItem(client, r.task, openMail, t("mail_gone"));
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const index = reminders.indexOf(selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = reminders[Math.min(Math.max(index + (e.key === "ArrowDown" ? 1 : -1), 0), reminders.length - 1)];
      setSelectedId(next.task.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(selected);
    }
  };

  const selectedText = text(selected.task, fmt.action(selected.task));

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      data-testid="reminders-window"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      className="fixed inset-x-4 bottom-4 z-50 flex max-h-[70vh] flex-col rounded-lg border border-border bg-background shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200 sm:inset-x-auto sm:left-1/2 sm:w-[32rem] sm:-translate-x-1/2"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Bell className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
        <h2 id={`${id}-title`} className="flex-1 text-sm font-semibold text-foreground">
          {t("reminders.title", { count: reminders.length })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          title={t("close")}
          data-testid="reminders-window-close"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul
        role="listbox"
        tabIndex={0}
        aria-label={t("reminders.list_label")}
        aria-activedescendant={`${id}-r-${reminders.indexOf(selected)}`}
        onKeyDown={onListKey}
        className="min-h-0 flex-1 overflow-y-auto py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {reminders.map((r, i) => {
          const row = text(r.task, fmt.action(r.task));
          const overdue = followUpState(r.task, now) === "overdue";
          const isSelected = r === selected;
          return (
            <li
              key={r.task.id}
              id={`${id}-r-${i}`}
              role="option"
              aria-selected={isSelected}
              data-testid="reminder-row"
              data-task={r.task.id}
              onClick={() => setSelectedId(r.task.id)}
              onDoubleClick={() => { setSelectedId(r.task.id); open(r); }}
              className={cn(
                "flex cursor-default items-start gap-2 px-4 py-1.5 select-none",
                isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
              )}
            >
              {row.mail
                ? <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={t("reminders.mail")} />
                : <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={t("reminder_label")} />}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.what}</span>
                  <span
                    data-testid="reminder-due"
                    className={cn("shrink-0 text-xs", overdue ? "font-medium text-destructive" : "text-muted-foreground")}
                  >
                    {fmt.due(r.task, now)}
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">{row.sub}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void dismissAll()} data-testid="reminders-dismiss-all">
          {t("reminders.dismiss_all")}
        </Button>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={() => open(selected)} data-testid="reminders-open">
          {selectedText.mail ? t("open_mail") : t("reminders.open")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void done(selected)} data-testid="reminders-done">
          {t("done_button")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void dismiss(selected)} data-testid="reminders-dismiss">
          {t("reminders.dismiss")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-sm">
        <label htmlFor={`${id}-snooze`} className="text-muted-foreground">{t("reminders.snooze_label")}</label>
        <select
          id={`${id}-snooze`}
          data-testid="reminders-snooze-choice"
          value={choice}
          onChange={(e) => setSnooze(e.target.value as SnoozeChoice)}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {times.map(({ choice: c, at }) => (
            <option key={c} value={c}>{snoozeLabel(c, at)}</option>
          ))}
        </select>
        <Button type="button" size="sm" disabled={busy} onClick={() => void snoozeSelected()} data-testid="reminders-snooze">
          {t("reminders.snooze")}
        </Button>
      </div>
    </div>
  );
}
