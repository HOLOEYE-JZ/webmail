"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, ExternalLink, Mail, MoreHorizontal, X } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { completeTask } from "@/hooks/use-follow-ups";
import { useFollowUpDialog } from "@/stores/follow-up-dialog-store";
import { addReminderToday, openTaskItem, useUpcomingTasks } from "@/hooks/use-upcoming";
import { useDisplayNow } from "@/hooks/use-clock";
import { GroupTaskSource, useFollowUpFormat } from "@/components/email/follow-up";
import { toDisplayDate } from "@/lib/timezone";
import { followUpDueDay, followUpMailRef, followUpMailSummary, followUpNote, followUpReminder } from "@/lib/follow-ups";
import { isRecurringTask } from "@/lib/calendar-tasks";
import type { UpcomingGroup } from "@/lib/upcoming-tasks";
import type { CalendarTask } from "@/lib/jmap/types";

/** The task list in the calendar, where everything the pane leaves out is. */
const TASK_LIST_PATH = "/calendar/tasks";

/** The task list opened from here shows the user's tasks, as this pane does. */
const showMine = () => useTaskStore.getState().setListScope("mine");

const GROUP_KEYS: Record<UpcomingGroup, string> = {
  overdue: "overdue",
  today: "today",
  tomorrow: "tomorrow",
  "this-week": "this_week",
};

/**
 * "Upcoming for me" beside the mail list, as Outlook's To-Do bar: the user's
 * open tasks overdue, due today, tomorrow and this week, the rest counted. A
 * mail's follow-up opens its mail, any other task the dialog; the check box
 * marks it done. Its first line adds a reminder without a mail.
 */
export function UpcomingPane({ onOpenMail, className }: {
  /** Opens a follow-up's mail in the mail view; `mailAccountId` when the link names an account. */
  onOpenMail: (emailId: string, mailAccountId: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("follow_up");
  const client = useAuthStore((s) => s.client);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const { groups, later } = useUpcomingTasks();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const title = draft.trim();
    if (!client || !title || adding) return;
    setAdding(true);
    setDraft("");
    const written = await addReminderToday(client, title, { failed: t("reminder.failed"), noTaskList: t("no_task_list") });
    // Not written: the user's text comes back.
    if (!written) setDraft((current) => current || title);
    setAdding(false);
  };

  const openDialog = () => {
    useFollowUpDialog.getState().openReminder({ taskId: null, title: draft.trim() }, "reminder");
    setDraft("");
  };

  return (
    <aside
      data-testid="upcoming-pane"
      aria-label={t("upcoming.title")}
      className={cn("flex h-full w-64 shrink-0 flex-col border-s border-border bg-background", className)}
    >
      <div className="flex h-14 items-center gap-1 border-b border-border ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{t("upcoming.title")}</h2>
        <Link
          href={TASK_LIST_PATH}
          onClick={showMine}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("upcoming.all_tasks")}
          title={t("upcoming.all_tasks")}
        >
          <ExternalLink className="h-4 w-4" />
        </Link>
        <button
          type="button"
          data-testid="upcoming-hide"
          onClick={() => updateSetting("showUpcomingPane", false)}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("upcoming.hide")}
          title={t("upcoming.hide")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="flex items-center gap-1 px-3 py-2"
        onSubmit={(e) => { e.preventDefault(); void add(); }}
      >
        <input
          data-testid="upcoming-quick"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("upcoming.quick_placeholder")}
          aria-label={t("upcoming.quick_label")}
          maxLength={200}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          data-testid="upcoming-quick-more"
          onClick={openDialog}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-input text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("upcoming.quick_more")}
          title={t("upcoming.quick_more")}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {groups.length === 0 && (
          <p data-testid="upcoming-empty" className="px-4 py-6 text-center text-sm text-muted-foreground">{t("upcoming.empty")}</p>
        )}
        {groups.map(({ group, tasks }) => (
          <section key={group} data-testid={`upcoming-group-${group}`} aria-labelledby={`upcoming-${group}`}>
            <h3
              id={`upcoming-${group}`}
              className={cn(
                "px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider",
                group === "overdue" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t(`upcoming.groups.${GROUP_KEYS[group]}`)}
            </h3>
            <ul>
              {tasks.map((task) => (
                <UpcomingItem key={task.id} task={task} group={group} onOpenMail={onOpenMail} />
              ))}
            </ul>
          </section>
        ))}
        {later > 0 && (
          <Link
            href={TASK_LIST_PATH}
            onClick={showMine}
            data-testid="upcoming-more"
            className="mx-4 mt-3 block text-xs text-primary hover:underline"
          >
            {t("upcoming.more", { count: later })}
          </Link>
        )}
      </div>
    </aside>
  );
}

function UpcomingItem({ task, group, onOpenMail }: {
  task: CalendarTask;
  group: UpcomingGroup;
  onOpenMail: (emailId: string, mailAccountId: string | null) => void;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const client = useAuthStore((s) => s.client);
  const now = useDisplayNow();
  const [busy, setBusy] = useState(false);

  const mail = followUpMailRef(task);
  const summary = mail ? followUpMailSummary(task) : null;
  const title = mail ? fmt.action(task) ?? t("bar_action") : task.title?.trim() || t("upcoming.no_title");
  const sub = mail
    ? [summary?.sender, summary?.subject || t("no_subject")].filter(Boolean).join(" · ")
    : followUpNote(task) || t("upcoming.no_mail");
  const due = followUpDueDay(task);
  const when = group === "overdue" ? fmt.due(task, now) : group === "this-week" && due ? fmt.day(due) : null;
  const reminderAt = followUpReminder(task);
  const reminder = reminderAt
    ? (isSameDay(toDisplayDate(reminderAt), now) ? fmt.time(reminderAt) : fmt.reminder(reminderAt, now))
    : null;

  const markDone = async () => {
    if (!client || busy) return;
    setBusy(true);
    await completeTask(client, task, { failed: t("failed"), flagFailed: t("flag_failed") });
    setBusy(false);
  };

  const open = async () => {
    if (!mail) {
      useFollowUpDialog.getState().openReminder({ taskId: task.id });
      return;
    }
    if (client) await openTaskItem(client, task, onOpenMail, t("mail_gone"));
  };

  return (
    <li data-testid="upcoming-item" data-task={task.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/50">
      {/* A series is completed in the task list, never whole from here (the pane does not list one anyway). */}
      {!isRecurringTask(task) && <input
        type="checkbox"
        data-testid="upcoming-done"
        checked={false}
        disabled={busy}
        onChange={() => void markDone()}
        aria-label={t("upcoming.done_label", { title })}
        title={t("mark_done")}
        className="mt-1 h-4 w-4 shrink-0 rounded border-input"
      />}
      <button
        type="button"
        data-testid="upcoming-open"
        onClick={() => void open()}
        title={mail ? t("open_mail") : t("upcoming.edit")}
        className="min-w-0 flex-1 text-start"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
          {when && (
            <span className={cn("shrink-0 text-xs", group === "overdue" ? "text-destructive" : "text-muted-foreground")}>{when}</span>
          )}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {mail && <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate"><GroupTaskSource task={task} />{sub}</span>
          {reminder && (
            <span className="inline-flex shrink-0 items-center gap-0.5">
              <Bell className="h-3 w-3" aria-label={t("reminder_label")} />
              {reminder}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
