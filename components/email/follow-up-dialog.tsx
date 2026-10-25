"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, Flag, Mail, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import {
  followUpCalendars,
  useFollowUp,
  useFollowUpDialog,
  type FollowUpDialogFocus,
} from "@/hooks/use-follow-ups";
import { useCalendarStore } from "@/stores/calendar-store";
import { usePolicyStore } from "@/stores/policy-store";
import { displayNow, fromDisplayDate, toDisplayDate } from "@/lib/timezone";
import {
  FOLLOW_UP_CHOICES,
  followUpAction,
  followUpActionKey,
  followUpDueDay,
  followUpNote,
  followUpReminder,
  otherFollowUpAlerts,
  proposedFollowUpReminder,
  scheduleFollowUp,
} from "@/lib/follow-ups";
import { FOLLOW_UP_ACTIONS, sanitizeFollowUpActions } from "@/lib/follow-up-actions";
import type { Email } from "@/lib/jmap/types";

/** The select's entry that opens the free text. */
const OTHER = "\u0000other";

const isoDay = (day: Date | null) => (day ? format(day, "yyyy-MM-dd") : "");

/** A display date from the date input's "yyyy-MM-dd" and, optionally, the time input's "HH:mm". */
function displayDateOf(day: string, time = "00:00"): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The dialog of the mail view, for the mail `useFollowUpDialog` names. Mounted once. */
export function FollowUpDialogHost() {
  const email = useFollowUpDialog((s) => s.email);
  const focus = useFollowUpDialog((s) => s.focus);
  const close = useFollowUpDialog((s) => s.close);
  if (!email) return null;
  return <FollowUpDialog key={`${email.id}:${focus}`} email={email} focus={focus} onClose={close} />;
}

/**
 * Outlook's "Custom" follow-up: what to do, the due day, the reminder and a
 * note, all kept in the follow-up's task and read back from it.
 */
export function FollowUpDialog({ email, focus, onClose }: {
  email: Email;
  focus: FollowUpDialogFocus;
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const id = useId();
  const controls = useFollowUp(email);
  const { task, workingTime } = controls;
  const calendars = useCalendarStore((s) => s.calendars);
  const extraActions = usePolicyStore((s) => s.policy.followUpActions);
  const [busy, setBusy] = useState(false);

  // A built-in action in the current language, whatever language the task was written in.
  const shownAction = (text: string) => {
    const key = followUpActionKey(text);
    return key ? t(`actions.${key}`) : text;
  };

  // Read once when the dialog opens: a push meanwhile must not overwrite what the user typed.
  const [initial] = useState(() => {
    const now = displayNow();
    const due = task ? followUpDueDay(task) : scheduleFollowUp("tomorrow", now, workingTime).due;
    const stored = task ? followUpReminder(task) : null;
    const reminder = stored
      ? toDisplayDate(stored)
      : focus === "reminder" ? proposedFollowUpReminder(due, now, workingTime) : null;
    return {
      action: task ? shownAction(followUpAction(task)) : t("actions.follow_up"),
      due,
      reminder,
      note: task ? followUpNote(task) : "",
      // Alerts the reminder shown leaves out (relative ones, a second one set on a phone): kept as they are.
      otherAlerts: task ? otherFollowUpAlerts(task) : 0,
    };
  });

  const actions = useMemo(() => {
    const builtIn = FOLLOW_UP_ACTIONS.map((key) => t(`actions.${key}`));
    const seen = new Set(builtIn.map((a) => a.toLocaleLowerCase()));
    return [...builtIn, ...sanitizeFollowUpActions(extraActions).filter((a) => !seen.has(a.toLocaleLowerCase()))];
  }, [t, extraActions]);

  const [action, setAction] = useState(initial.action);
  const [other, setOther] = useState(() => !actions.includes(initial.action));
  const [due, setDue] = useState(isoDay(initial.due));
  const [reminderOn, setReminderOn] = useState(!!initial.reminder);
  // Empty without a reminder, so turning one on proposes a time to come.
  const [reminderDay, setReminderDay] = useState(isoDay(initial.reminder));
  const [reminderTime, setReminderTime] = useState(initial.reminder ? format(initial.reminder, "HH:mm") : "");
  const [reminderPast, setReminderPast] = useState(false);
  const [note, setNote] = useState(initial.note);

  const actionRef = useRef<HTMLSelectElement>(null);
  const reminderTimeRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });

  useEffect(() => {
    const timer = setTimeout(() => {
      if (focus === "reminder") reminderTimeRef.current?.focus();
      else actionRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [focus]);

  // The mail could leave the user's mailbox (or follow-ups be turned off) while the dialog is open.
  useEffect(() => {
    if (!controls.available) onClose();
  }, [controls.available, onClose]);

  const now = displayNow();
  const choices = FOLLOW_UP_CHOICES.map((choice) => ({ choice, ...scheduleFollowUp(choice, now, workingTime) }));

  const pickChoice = (choice: (typeof choices)[number]) => {
    setDue(isoDay(choice.due));
    if (choice.reminder) {
      setReminderOn(true);
      setReminderDay(isoDay(choice.reminder));
      setReminderTime(format(choice.reminder, "HH:mm"));
    } else {
      setReminderOn(false);
    }
  };

  const toggleReminder = (on: boolean) => {
    setReminderOn(on);
    setReminderPast(false);
    if (on && (!reminderDay || !reminderTime)) {
      const proposed = proposedFollowUpReminder(displayDateOf(due), displayNow(), workingTime);
      setReminderDay(isoDay(proposed));
      setReminderTime(format(proposed, "HH:mm"));
    }
  };

  const reminder = reminderOn ? displayDateOf(reminderDay, reminderTime) : null;
  const canSave = !busy && (!reminderOn || !!reminder) && (!due || !!displayDateOf(due));

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSave) return;
    // A reminder set to a time gone by would never come; one kept as it was (it may have come already) stays.
    const changed = (reminder?.getTime() ?? null) !== (initial.reminder?.getTime() ?? null);
    if (reminder && changed && reminder.getTime() <= displayNow().getTime()) {
      setReminderPast(true);
      reminderTimeRef.current?.focus();
      return;
    }
    setBusy(true);
    const written = await controls.save({
      action,
      due: displayDateOf(due),
      reminderAt: reminder ? fromDisplayDate(reminder) : null,
      note,
    });
    setBusy(false);
    if (written) onClose();
  };

  const remove = async () => {
    setBusy(true);
    await controls.remove();
    setBusy(false);
    onClose();
  };

  // Where it is kept: the task's own list, else where a new one goes.
  const taskCalendarId = task ? Object.keys(task.calendarIds ?? {})[0] : undefined;
  const list = (taskCalendarId && calendars.find((c) => c.id === taskCalendarId)) || followUpCalendars(calendars)[0];
  const sender = email.from?.[0]?.name || email.from?.[0]?.email;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px] animate-in fade-in duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="follow-up-dialog"
        className="w-full max-w-md max-h-full overflow-y-auto rounded-lg border border-border bg-background shadow-xl animate-in zoom-in-95 duration-200"
      >
        <form onSubmit={save}>
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <Flag className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
            <h2 id={`${id}-title`} className="flex-1 text-base font-semibold text-foreground">
              {task ? t("dialog_title_edit") : t("dialog_title")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 px-5 py-4 text-sm">
            <p className="flex items-center gap-1.5 truncate text-muted-foreground">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {[sender, email.subject || t("no_subject")].filter(Boolean).join(" · ")}
              </span>
            </p>

            <div className="space-y-1.5">
              <label htmlFor={`${id}-action`} className="block font-medium text-foreground">{t("action_label")}</label>
              <select
                ref={actionRef}
                id={`${id}-action`}
                data-testid="follow-up-action"
                value={other ? OTHER : action}
                onChange={(e) => {
                  if (e.target.value === OTHER) {
                    setOther(true);
                    setAction("");
                  } else {
                    setOther(false);
                    setAction(e.target.value);
                  }
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {actions.map((a) => <option key={a} value={a}>{a}</option>)}
                <option value={OTHER}>{t("action_other")}</option>
              </select>
              {other && (
                <Input
                  data-testid="follow-up-action-text"
                  aria-label={t("action_text")}
                  placeholder={t("action_text")}
                  value={action}
                  maxLength={200}
                  autoFocus
                  onChange={(e) => setAction(e.target.value)}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <span id={`${id}-due`} className="block font-medium text-foreground">{t("due_label")}</span>
              <div role="group" aria-labelledby={`${id}-due`} className="flex flex-wrap gap-1.5">
                {choices.map((c) => {
                  const pressed = isoDay(c.due) === due;
                  return (
                    <button
                      key={c.choice}
                      type="button"
                      aria-pressed={pressed}
                      data-testid={`follow-up-dialog-${c.choice}`}
                      onClick={() => pickChoice(c)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        pressed
                          ? "border-orange-500 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {t(`choices.${c.choice}`)}
                    </button>
                  );
                })}
              </div>
              <Input
                type="date"
                data-testid="follow-up-due"
                aria-label={t("due_date")}
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className="w-auto"
              />
            </div>

            <div className="space-y-1.5">
              <label className="flex w-fit items-center gap-2 font-medium text-foreground">
                <input
                  type="checkbox"
                  data-testid="follow-up-reminder-on"
                  checked={reminderOn}
                  onChange={(e) => toggleReminder(e.target.checked)}
                  className="rounded border-input"
                />
                <Bell className="h-3.5 w-3.5" />
                {t("reminder_label")}
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="date"
                  data-testid="follow-up-reminder-day"
                  aria-label={t("reminder_day")}
                  value={reminderDay}
                  disabled={!reminderOn}
                  aria-invalid={reminderPast || undefined}
                  onChange={(e) => { setReminderDay(e.target.value); setReminderPast(false); }}
                  className="w-auto"
                />
                <Input
                  ref={reminderTimeRef}
                  type="time"
                  data-testid="follow-up-reminder-time"
                  aria-label={t("reminder_time")}
                  value={reminderTime}
                  disabled={!reminderOn}
                  aria-invalid={reminderPast || undefined}
                  aria-describedby={reminderPast ? `${id}-reminder-past` : undefined}
                  onChange={(e) => { setReminderTime(e.target.value); setReminderPast(false); }}
                  className="w-auto"
                />
              </div>
              {reminderPast && (
                <p id={`${id}-reminder-past`} role="alert" data-testid="follow-up-reminder-past" className="text-xs text-destructive">
                  {t("reminder_past")}
                </p>
              )}
              {initial.otherAlerts > 0 && (
                <p data-testid="follow-up-other-reminders" className="text-xs text-muted-foreground">
                  {t("other_reminders", { count: initial.otherAlerts })}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor={`${id}-note`} className="block font-medium text-foreground">{t("note_label")}</label>
              <textarea
                id={`${id}-note`}
                data-testid="follow-up-note"
                rows={2}
                value={note}
                placeholder={t("note_placeholder")}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <p data-testid="follow-up-kept" className="text-xs text-muted-foreground">
              {list?.name ? t("kept_in", { list: list.name }) : t("kept_in_tasks")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            {task && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()} data-testid="follow-up-dialog-remove">
                {t("remove_button")}
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
            <Button type="submit" disabled={!canSave} data-testid="follow-up-dialog-save">{t("save")}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
