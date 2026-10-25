"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarNotificationStore } from "@/stores/calendar-notification-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { useProTabStore } from "@/stores/pro-tab-store";
import { useToastStore } from "@/stores/toast-store";
import { playNotificationSound } from "@/lib/notification-sound";
import { groupMailAccountOf } from "@/lib/deep-links";
import { followMessageLink } from "@/lib/deep-link-handoff";
import { dueTaskReminders, type TaskReminder } from "@/lib/task-reminders";
import { followUpMailRef, followUpMailSummary, followUpNote } from "@/lib/follow-ups";
import { followUpCalendars } from "./use-follow-ups";
import { useReplyChecks } from "./use-follow-up-replies";

/** How often the window looks at the clock for reminders that fell due. */
const CHECK_MS = 30_000;
/** How long the app waits for a page's own task fetch before it loads the task list itself. */
const OWN_FETCH_DELAY_MS = 1_500;

interface RemindersWindowState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

/** The reminders window, shown over every view (`RemindersWindowHost`). */
export const useRemindersWindow = create<RemindersWindowState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

type MailOpener = (emailId: string, mailAccountId: string | null) => void;
let mailOpener: MailOpener | null = null;

/**
 * The mail view, while it is mounted, opens a reminder's mail in place (as
 * the pane "Upcoming" does); elsewhere the window goes to the mail's
 * permalink.
 */
export function setReminderMailOpener(opener: MailOpener | null): void {
  mailOpener = opener;
}

export function reminderMailOpener(): MailOpener | null {
  return mailOpener;
}

/**
 * Whether a mail view opens the reminders' mails: the standard one unless
 * the Pro shell takes over, in the Pro shell only the focused tab's (the one
 * on screen), never a hidden tab's.
 */
export function ownsReminderMails(view: { embedded: boolean; focusedProTab: boolean; proInterface: boolean }): boolean {
  return view.embedded ? view.focusedProTab : !view.proInterface;
}

/** Registers `opener` while `owns` holds; the latest one given is used. */
export function useReminderMailOpener(owns: boolean, opener: MailOpener): void {
  const ref = useRef(opener);
  ref.current = opener;
  useEffect(() => {
    if (!owns) return;
    const registered: MailOpener = (emailId, mailAccountId) => ref.current(emailId, mailAccountId);
    setReminderMailOpener(registered);
    return () => { if (mailOpener === registered) setReminderMailOpener(null); };
  }, [owns]);
}

/**
 * Opens a reminder's mail: through the mail view on screen when there is
 * one; else in the Pro shell as a mail tab (as its search opens a mail), or
 * by going to the mail's permalink.
 */
export function openReminderMail(
  emailId: string,
  mailAccountId: string | null,
  fallback: { proShell: boolean; navigate: (path: string) => void; title: string },
): void {
  if (mailOpener) {
    mailOpener(emailId, mailAccountId);
    return;
  }
  if (fallback.proShell) {
    // A group mailbox's mail is fetched in its account through the active login.
    const client = useAuthStore.getState().client;
    const groupAccountId = client ? groupMailAccountOf(mailAccountId, client) : undefined;
    useProTabStore.getState().openEmailTab(
      {
        accountId: mailAccountId ?? "",
        ...(groupAccountId ? { mailAccountId: groupAccountId } : {}),
        emailId,
        mailboxId: null,
        title: fallback.title,
      },
      { reuseReader: true },
    );
    return;
  }
  fallback.navigate(followMessageLink(emailId, mailAccountId));
}

/** Whether reminders are shown at all: calendar notifications and tasks on, signed in. */
function useRemindersEnabled(): boolean {
  const notifications = useSettingsStore((s) => s.calendarNotificationsEnabled);
  const tasksOn = useSettingsStore((s) => s.enableCalendarTasks);
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  return notifications && tasksOn && supportsCalendar && signedIn;
}

/** Now as a real instant, refreshed every `CHECK_MS`. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const NO_REMINDERS: TaskReminder[] = [];

/**
 * The reminders the window shows now; none while reminders are off. A
 * follow-up that settles itself on an answer shows only once its thread was
 * looked at after its reminder fell due (`useFollowUpReplies`).
 */
export function useDueTaskReminders(): TaskReminder[] {
  const enabled = useRemindersEnabled();
  const tasks = useTaskStore((s) => s.tasks);
  const checkedAt = useReplyChecks((s) => s.checkedAt);
  const now = useClock();
  return useMemo(
    () => (enabled ? dueTaskReminders(tasks, now, (id) => checkedAt[id]) : NO_REMINDERS),
    [enabled, tasks, now, checkedAt],
  );
}

/** What a reminder is about, as the window and its toast name it. */
export function useReminderText() {
  const t = useTranslations("follow_up");
  return useMemo(() => (task: TaskReminder["task"], action: string | null) => {
    const mail = followUpMailRef(task);
    if (!mail) {
      return { mail: false, what: task.title?.trim() || t("upcoming.no_title"), sub: followUpNote(task) || t("upcoming.no_mail") };
    }
    const summary = followUpMailSummary(task);
    return {
      mail: true,
      what: action ?? t("bar_action"),
      sub: [summary.sender, summary.subject || t("no_subject")].filter(Boolean).join(" · "),
    };
  }, [t]);
}

/**
 * Loads the user's own task list once when no page did (the app opened on
 * contacts or settings), so a reminder that fell due while the app was
 * closed shows wherever it opens. A page that loads tasks itself (the mail
 * view, the calendar) is left to do so.
 */
function useTaskListLoaded(enabled: boolean): void {
  const client = useAuthStore((s) => s.client);
  useEffect(() => {
    if (!enabled || !client) return;
    const timer = setTimeout(() => {
      void (async () => {
        const tasks = useTaskStore.getState();
        if (tasks.isLoading || tasks.loadedBy || tasks.scope || tasks.tasks.length > 0 || tasks.error) return;
        const calendars = useCalendarStore.getState();
        if (calendars.calendars.length === 0) await calendars.fetchCalendars(client);
        const ids = followUpCalendars(useCalendarStore.getState().calendars).map((c) => c.id);
        const again = useTaskStore.getState();
        if (ids.length === 0 || again.isLoading || again.loadedBy || again.scope || again.tasks.length > 0) return;
        await again.fetchTasks(client, ids);
      })();
    }, OWN_FETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, client]);
}

/**
 * Shows the reminders window when a reminder falls due, and when the app
 * opens with reminders that fell due while it was closed: a toast (with the
 * sound, once per reminder on this device) and the window. Mounted once.
 */
export function useTaskReminders(): void {
  const t = useTranslations("follow_up");
  const enabled = useRemindersEnabled();
  const reminders = useDueTaskReminders();
  const text = useReminderText();
  const sound = useSettingsStore((s) => s.calendarNotificationSound);
  const soundChoice = useSettingsStore((s) => s.notificationSoundChoice);
  const shownRef = useRef<Set<string>>(new Set());
  useTaskListLoaded(enabled);

  useEffect(() => {
    if (!enabled || reminders.length === 0) return;
    const fresh = reminders.filter((r) => !shownRef.current.has(r.key));
    if (fresh.length === 0) return;
    for (const r of fresh) shownRef.current.add(r.key);

    // Toasted (and rung) once per reminder on this device, again a day later
    // while it stands (kept as of the toast, not of when it fell due, so one
    // that fell due days ago does not ring at every start); the window comes
    // again at every start while a reminder stands.
    const notifications = useCalendarNotificationStore.getState();
    const unheard = fresh.filter((r) => !notifications.isAcknowledged(r.key));
    const heardAt = Date.now();
    for (const r of unheard) notifications.acknowledgeAlert(r.key, heardAt);
    if (unheard.length > 0) {
      if (sound) playNotificationSound(soundChoice);
      const first = text(unheard[0].task, null);
      const more = unheard.length - 1;
      useToastStore.getState().addToast({
        type: "info",
        title: unheard[0].task.title?.trim() || first.what,
        message: more > 0 ? `${first.sub} · ${t("reminders.toast_more", { count: more })}` : first.sub,
        duration: 15_000,
        action: { label: t("reminders.toast_open"), onClick: () => useRemindersWindow.getState().show() },
      });
    }
    useRemindersWindow.getState().show();
  }, [enabled, reminders, text, t, sound, soundChoice]);
}
