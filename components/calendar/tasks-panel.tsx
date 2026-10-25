"use client";

import { useCallback, useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, ChevronDown, ExternalLink, Flag, ListTodo, Mail, MoreHorizontal, X } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useTaskStore } from "@/stores/task-store";
import { completeTask, reopenTask } from "@/hooks/use-follow-ups";
import { isGroupTask } from "@/hooks/use-group-follow-ups";
import { useFollowUpDialog } from "@/stores/follow-up-dialog-store";
import { useFollowUpPopover, type FollowUpPopoverPoint } from "@/stores/follow-up-popover-store";
import { toast } from "@/stores/toast-store";
import { addReminderToday, followUpEmailOf, openTaskItem, useUpcomingTasks } from "@/hooks/use-upcoming";
import { useDisplayNow } from "@/hooks/use-clock";
import { GroupTaskSource, useFollowUpFormat } from "@/components/email/follow-up";
import { toDisplayDate } from "@/lib/timezone";
import { followUpDueDay, followUpMailRef, followUpMailSummary, followUpNote, followUpReminder } from "@/lib/follow-ups";
import { isRecurringTask } from "@/lib/calendar-tasks";
import { FOLDED_GROUPS, type UpcomingGroup } from "@/lib/upcoming-tasks";
import type { CalendarTask } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

/** The task list in the calendar, the one place the panel leads out of the mail to. */
export const TASK_LIST_PATH = "/calendar/tasks";

/** The task list opened from here shows the user's tasks, as this panel does. */
export const showMyTasks = () => useTaskStore.getState().setListScope("mine");

/** Opens a follow-up's mail in the mail view; `mailAccountId` when the link names an account. */
export type OpenTaskMail = (emailId: string, mailAccountId: string | null) => void;

const GROUP_KEYS: Record<UpcomingGroup, string> = {
  overdue: "overdue",
  today: "today",
  tomorrow: "tomorrow",
  "this-week": "this_week",
  "next-week": "next_week",
  later: "later",
  "no-date": "no_date",
};

/** Whether the panel beside the default layout's mail list is open; per browser, open until closed. */
const OPEN_KEY = "tasksPanelOpen";

function readOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * The default layout's choice to show the tasks panel beside the mail. Kept
 * in this browser only, as the panel widths are: it is how this screen is
 * laid out, not an account setting. Mountain View opens its panels from its
 * own icons instead.
 */
export function useTasksPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Storage blocked: open or closed for this visit only.
    }
  }, []);
  return [open, setOpen];
}

/** The groups the user folded or opened in the panel; per browser, as whether it is open. */
const FOLDED_KEY = "tasksPanelFolded";

function readFolded(): Partial<Record<UpcomingGroup, boolean>> {
  if (typeof window === "undefined") return {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}");
    return stored && typeof stored === "object" ? stored as Partial<Record<UpcomingGroup, boolean>> : {};
  } catch {
    return {};
  }
}

/**
 * Which of the panel's groups are folded: the far ones until the user
 * opens them, each as the user last left it. Kept in this browser.
 */
export function useFoldedGroups(): [(group: UpcomingGroup) => boolean, (group: UpcomingGroup) => void] {
  const [folded, setFolded] = useState(readFolded);
  const isFolded = useCallback((group: UpcomingGroup) => folded[group] ?? FOLDED_GROUPS.has(group), [folded]);
  const toggle = useCallback((group: UpcomingGroup) => {
    setFolded((current) => {
      const next = { ...current, [group]: !(current[group] ?? FOLDED_GROUPS.has(group)) };
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: folded or open for this visit only.
      }
      return next;
    });
  }, []);
  return [isFolded, toggle];
}

/**
 * The task list beside the mail, as Outlook's To-Do bar: the user's open
 * tasks by when they are due (overdue, today, tomorrow, this week, next
 * week, later, no date), the far groups folded with their count. Nothing in
 * it leaves the mail view: a mail's follow-up opens its mail, any other task
 * the dialog; the check box marks it done (with undo), the flag and the
 * right click open the popover "Follow up". Its first line adds a task due
 * today (Enter), or opens the dialog for one with day, time and note; its
 * foot is the one way into the task list. The host draws the frame and the
 * header: Mountain View's side panel, or `TasksSidebar` in the default
 * layout.
 */
export function TasksPanel({ onOpenMail }: { onOpenMail: OpenTaskMail }) {
  const t = useTranslations("follow_up");
  const client = useAuthStore((s) => s.client);
  const { groups } = useUpcomingTasks();
  const [isFolded, toggleFolded] = useFoldedGroups();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const title = draft.trim();
    if (!client || !title || adding) return;
    setAdding(true);
    setDraft("");
    const written = await addReminderToday(client, title, { failed: t("reminder.failed"), noTaskList: t("no_task_list") });
    // Not written (a plugin stopped it, or it failed): the user's text comes back.
    if (!written) setDraft((current) => current || title);
    setAdding(false);
  };

  const openDialog = () => {
    useFollowUpDialog.getState().openReminder({ taskId: null, title: draft.trim() }, "reminder");
    setDraft("");
  };

  return (
    <>
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
        {groups.map(({ group, tasks, count }) => {
          const folded = isFolded(group);
          return (
            <section key={group} data-testid={`upcoming-group-${group}`} aria-labelledby={`upcoming-${group}`}>
              <h3 className="px-2 pt-2">
                <button
                  type="button"
                  id={`upcoming-${group}`}
                  data-testid="upcoming-group-head"
                  aria-expanded={!folded}
                  onClick={() => toggleFolded(group)}
                  className={cn(
                    "flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider hover:bg-muted hover:text-foreground",
                    group === "overdue" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", folded && "-rotate-90 rtl:rotate-90")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-start">{t(`upcoming.groups.${GROUP_KEYS[group]}`)}</span>
                  <span className="shrink-0 font-medium tracking-normal">{count}</span>
                </button>
              </h3>
              {!folded && (
                <ul>
                  {tasks.map((task) => (
                    <TaskItem key={task.id} task={task} group={group} onOpenMail={onOpenMail} />
                  ))}
                </ul>
              )}
              {!folded && count > tasks.length && (
                <Link
                  href={TASK_LIST_PATH}
                  onClick={showMyTasks}
                  data-testid="upcoming-no-date-all"
                  className="mx-4 mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t("upcoming.no_date_all", { count })}
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                </Link>
              )}
            </section>
          );
        })}
      </div>

      <div className="border-t border-border px-2 py-1.5">
        <Link
          href={TASK_LIST_PATH}
          onClick={showMyTasks}
          data-testid="upcoming-open-list"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-primary hover:bg-muted"
        >
          <ListTodo className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t("upcoming.open_list")}</span>
          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      </div>
    </>
  );
}

/** The default layout's frame for the panel: beside the mail list, with its title and ✕. */
export function TasksSidebar({ onClose, onOpenMail, className }: {
  onClose: () => void;
  onOpenMail: OpenTaskMail;
  className?: string;
}) {
  const t = useTranslations("follow_up");
  return (
    <aside
      data-testid="upcoming-pane"
      aria-label={t("upcoming.title")}
      className={cn("flex h-full w-64 shrink-0 flex-col border-s border-border bg-background", className)}
    >
      <div className="flex h-14 items-center gap-1 border-b border-border ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{t("upcoming.title")}</h2>
        <button
          type="button"
          data-testid="upcoming-hide"
          onClick={onClose}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("upcoming.hide")}
          title={t("upcoming.hide")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <TasksPanel onOpenMail={onOpenMail} />
    </aside>
  );
}

/** The groups whose name does not tell the day, so a row says it. */
const DATED_GROUPS: ReadonlySet<UpcomingGroup> = new Set(["this-week", "next-week", "later"]);

/**
 * Opens the popover "Follow up" for a row at `at`: a follow-up's on its mail
 * (a group list's on that task), a task without a mail, or whose mail cannot
 * be read, on the task alone.
 */
async function openRowPopover(client: IJMAPClient, task: CalendarTask, at: FollowUpPopoverPoint, trigger: HTMLElement): Promise<void> {
  const email = followUpMailRef(task) ? await followUpEmailOf(client, task).catch(() => null) : null;
  const popover = useFollowUpPopover.getState();
  if (email) popover.openAt(email, at, trigger, isGroupTask(task) ? task.id : null);
  else popover.openTaskAt(task.id, at, trigger);
}

function TaskItem({ task, group, onOpenMail }: {
  task: CalendarTask;
  group: UpcomingGroup;
  onOpenMail: OpenTaskMail;
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
  const recurring = isRecurringTask(task);
  const when = group === "overdue"
    ? fmt.due(task, now)
    : DATED_GROUPS.has(group) && due && !recurring ? fmt.day(due) : null;
  const reminderAt = followUpReminder(task);
  const reminder = reminderAt
    ? (isSameDay(toDisplayDate(reminderAt), now) ? fmt.time(reminderAt) : fmt.reminder(reminderAt, now))
    : null;

  const markDone = async () => {
    if (!client || busy) return;
    setBusy(true);
    const messages = { failed: t("failed"), flagFailed: t("flag_failed") };
    const done = await completeTask(client, task, messages);
    setBusy(false);
    if (done) {
      toast.success(t("upcoming.done_toast", { title }), {
        action: { label: t("undo"), onClick: () => void reopenTask(client, task, messages) },
      });
    }
  };

  const open = async () => {
    if (!mail) {
      useFollowUpDialog.getState().openReminder({ taskId: task.id });
      return;
    }
    if (client) await openTaskItem(client, task, onOpenMail, t("mail_gone"));
  };

  const popover = (at: FollowUpPopoverPoint, trigger: HTMLElement) => {
    if (client) void openRowPopover(client, task, at, trigger);
  };

  const onContextMenu = (e: MouseEvent<HTMLLIElement>) => {
    e.preventDefault();
    popover({ x: e.clientX, y: e.clientY }, e.currentTarget);
  };

  const onFlag = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    popover({ x: rect.left, y: rect.bottom + 4 }, e.currentTarget);
  };

  return (
    <li
      data-testid="upcoming-item"
      data-task={task.id}
      data-mv-panel-task=""
      onContextMenu={onContextMenu}
      className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/50"
    >
      {/* A series is completed in the task list, never whole from here. */}
      {!recurring && <input
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
            <span className={cn("shrink-0 text-xs group-hover:hidden group-focus-within:hidden", group === "overdue" ? "text-destructive" : "text-muted-foreground")}>{when}</span>
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
      <button
        type="button"
        data-testid="upcoming-flag"
        onClick={onFlag}
        aria-label={t("upcoming.flag_label", { title })}
        title={t("menu_title")}
        className="hidden h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:grid group-hover:grid group-focus-within:grid"
      >
        <Flag className="h-4 w-4" />
      </button>
    </li>
  );
}
