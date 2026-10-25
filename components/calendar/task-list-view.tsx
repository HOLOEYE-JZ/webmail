"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { format, isSameDay, startOfDay } from "date-fns";
import { toDisplayDate } from "@/lib/timezone";
import { Bell, Check, Flag, ListTodo, Mail, Plus, Repeat, Users } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarTask, Calendar } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useRouter } from "@/i18n/navigation";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { useFollowUpFormat, useGroupPeopleText } from "@/components/email/follow-up";
import { useDisplayNow } from "@/hooks/use-upcoming";
import { groupListOfTask, useGroupTasks, useMyAddresses } from "@/hooks/use-group-follow-ups";
import { openReminderMail } from "@/hooks/use-task-reminders";
import { openListedTask, opensMail, toggleListedTask } from "@/hooks/use-task-list";
import { followUpMailRef, followUpMailSummary, followUpNote, followUpReminder, isRecurringTask } from "@/lib/follow-ups";
import { isTaskForMe } from "@/lib/group-follow-ups";
import { taskListDue, type TaskListGroup, type TaskListSection } from "@/lib/task-list";

interface TaskListViewProps {
  /** The list's sections (hooks/use-task-list.ts), in order. */
  sections: TaskListSection[];
  calendars: Calendar[];
  /** Opens a task in the task editor. */
  onSelectTask: (task: CalendarTask) => void;
  selectedTaskId?: string | null;
  onQuickCreate?: (title: string) => void;
}

function getTaskPriorityIcon(priority: number) {
  if (priority >= 1 && priority <= 4) return <Flag className="h-3.5 w-3.5 text-red-500" />;
  if (priority === 5) return <Flag className="h-3.5 w-3.5 text-orange-500" />;
  if (priority >= 6 && priority <= 9) return <Flag className="h-3.5 w-3.5 text-gray-400" />;
  return null;
}

const GROUP_KEYS: Record<TaskListGroup, string> = {
  overdue: "overdue",
  today: "today",
  tomorrow: "tomorrow",
  "this-week": "this_week",
  later: "later",
  "no-date": "no_date",
  done: "done",
};

/**
 * The task list, grouped by when a task is due: overdue, today, tomorrow,
 * this week, later, without a date, done (lib/task-list.ts). A follow-up on
 * a mail shows its sender and subject and opens the mail; a group mailbox's
 * task whom it is for; a reminder its time beside the due day.
 */
export function TaskListView({
  sections,
  calendars,
  onSelectTask,
  selectedTaskId,
  onQuickCreate,
}: TaskListViewProps) {
  const t = useTranslations("calendar");
  const [quickAddTitle, setQuickAddTitle] = useState("");
  // Whom a group's task is for: read once for all rows (the directory).
  const people = useGroupPeopleText();

  const quickAdd = onQuickCreate && (
    <div className="px-4 py-2 border-b border-border">
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <input
          type="text"
          value={quickAddTitle}
          onChange={(e) => setQuickAddTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && quickAddTitle.trim()) {
              onQuickCreate(quickAddTitle.trim());
              setQuickAddTitle("");
            }
          }}
          placeholder={t("tasks.quick_add_placeholder")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );

  if (sections.length === 0) {
    return (
      <div className="flex flex-col flex-1">
        {quickAdd}
        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground py-12">
          <ListTodo className="h-12 w-12 mb-3 opacity-30" />
          <p className="text-sm">{t("tasks.no_tasks")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {quickAdd}
      {sections.map(({ group, tasks }) => (
        <section key={group} data-testid={`task-group-${group}`} aria-labelledby={`task-group-heading-${group}`}>
          <h3
            id={`task-group-heading-${group}`}
            className={cn(
              "flex items-baseline gap-1.5 px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider",
              group === "overdue" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span>{t(`tasks.groups.${GROUP_KEYS[group]}`)}</span>
            <span className="font-normal">{tasks.length}</span>
          </h3>
          <div className="divide-y divide-border">
            {tasks.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                group={group}
                calendars={calendars}
                selected={selectedTaskId === task.id}
                onEdit={onSelectTask}
                people={people}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskListItem({ task, group, calendars, selected, onEdit, people }: {
  task: CalendarTask;
  group: TaskListGroup;
  calendars: Calendar[];
  selected: boolean;
  onEdit: (task: CalendarTask) => void;
  people: ReturnType<typeof useGroupPeopleText>;
}) {
  const t = useTranslations("calendar");
  const tFollowUp = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const mine = useMyAddresses();
  const client = useAuthStore((s) => s.client);
  const router = useRouter();
  const proShell = useProInterfaceActive();
  const lists = useGroupTasks((s) => s.lists);
  const now = useDisplayNow();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const [busy, setBusy] = useState(false);

  const cal = calendars.find((c) => task.calendarIds[c.id]);
  const done = group === "done";
  const groupList = task.isShared ? groupListOfTask(task, lists) : null;
  const mail = opensMail(task) ? followUpMailRef(task) : null;
  const summary = mail ? followUpMailSummary(task) : null;
  const subject = summary?.subject || tFollowUp("no_subject");
  const title = mail ? fmt.action(task) ?? tFollowUp("bar_action") : task.title?.trim() || t("tasks.no_title");
  const sub = mail ? [summary?.sender, subject].filter(Boolean).join(" · ") : followUpNote(task);
  // The due date-time (a repeating task's next one), a wall time as the task gives it.
  const dueAt = done ? null : taskListDue(task, now);
  const dueTime = dueAt && task.showWithoutTime === false ? format(dueAt, timeFormat === "12h" ? "h:mm a" : "HH:mm") : null;
  const dueDay = group === "overdue"
    ? fmt.due(task, now)
    : dueAt && group !== "today" && group !== "tomorrow" ? fmt.day(startOfDay(dueAt)) : null;
  const when = [dueDay, dueTime].filter(Boolean).join(", ") || null;
  // A group task's reminder is its owner's alone.
  const reminderAt = !done && (!task.isShared || isTaskForMe(task, mine)) ? followUpReminder(task) : null;
  const reminder = reminderAt
    ? (isSameDay(toDisplayDate(reminderAt), now) ? fmt.time(reminderAt) : fmt.reminder(reminderAt, now))
    : null;
  const who = groupList ? people(task) : null;

  const open = useCallback(() => {
    void openListedTask(client, task, {
      edit: onEdit,
      openMail: (emailId, mailAccountId) => openReminderMail(emailId, mailAccountId, {
        proShell,
        navigate: (path) => router.push(path as never),
        title: subject,
      }),
      mailGone: tFollowUp("mail_gone"),
    });
  }, [client, task, onEdit, proShell, router, subject, tFollowUp]);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || busy) return;
    setBusy(true);
    await toggleListedTask(client, task, { failed: tFollowUp("failed"), flagFailed: tFollowUp("flag_failed") });
    setBusy(false);
  };

  return (
    <div
      data-testid="task-item"
      data-task={task.id}
      onClick={open}
      title={mail ? tFollowUp("open_mail") : t("tasks.edit")}
      className={cn(
        "flex items-start gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors",
        selected && "bg-muted",
      )}
    >
      {/* Checkbox */}
      <button
        type="button"
        data-testid="task-toggle"
        onClick={(e) => void toggle(e)}
        disabled={busy}
        className={cn(
          "mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
          done
            ? "bg-success border-success text-success-foreground"
            : "border-muted-foreground/40 hover:border-primary"
        )}
        aria-label={done ? t("tasks.mark_incomplete") : t("tasks.mark_complete")}
      >
        {done && <Check className="h-3 w-3" />}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            data-testid="task-title"
            className={cn("min-w-0 flex-1 text-sm font-medium truncate", done && "line-through text-muted-foreground")}
          >
            {title}
          </span>
          {getTaskPriorityIcon(task.priority)}
          {who && groupList && (
            <span
              data-testid="task-group-person"
              title={[tFollowUp("group.list_of", { group: groupList.name }), who.by && `${who.forWhom} ${who.by}`].filter(Boolean).join(" · ")}
              className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 truncate rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-700 dark:text-sky-300"
            >
              <Users className="h-3 w-3 shrink-0" aria-label={tFollowUp("group.list_of", { group: groupList.name })} />
              <span className="truncate">{who.short}</span>
            </span>
          )}
          {isRecurringTask(task) && (
            <span title={t("tasks.repeats")} className="shrink-0 text-muted-foreground">
              <Repeat className="h-3.5 w-3.5" aria-label={t("tasks.repeats")} />
            </span>
          )}
          {when && (
            <span
              data-testid="task-due"
              className={cn("shrink-0 text-xs", group === "overdue" ? "text-destructive font-medium" : "text-muted-foreground")}
            >
              {when}
            </span>
          )}
          {reminder && (
            <span data-testid="task-reminder" className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
              <Bell className="h-3 w-3" aria-label={tFollowUp("reminder_label")} />
              {reminder}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {sub && (
            <span data-testid="task-sub" className="flex min-w-0 flex-1 items-center gap-1">
              {mail && <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />}
              <span className="truncate">{sub}</span>
            </span>
          )}
          {cal && (
            <span className="flex min-w-0 shrink-0 items-center gap-1">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cal.color || "#3b82f6" }} />
              <span className="truncate">{groupList?.name ?? cal.name}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
