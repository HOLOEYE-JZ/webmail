"use client";

import { useCallback, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { differenceInCalendarDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, Check, ChevronDown, Flag, Reply, Users } from "@/components/icons";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import {
  completeTask,
  followUpMailAccount,
  useFollowUp,
  useFollowUpsEnabled,
} from "@/hooks/use-follow-ups";
import { useFollowUpDialog } from "@/stores/follow-up-dialog-store";
import { useFollowUpPopover } from "@/stores/follow-up-popover-store";
import {
  deleteGroupTask,
  groupListOfTask,
  useGroupFollowUpsOf,
  useMyAddresses,
  usePrincipals,
} from "@/hooks/use-group-follow-ups";
import { useGroupTasks } from "@/stores/group-task-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { groupTaskPeople, isTaskForMe } from "@/lib/group-follow-ups";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { displayNow, toDisplayDate } from "@/lib/timezone";
import {
  followUpAction,
  followUpActionKey,
  followUpNote,
  followUpDueDay,
  followUpReminder,
  followUpState,
  type FollowUpState,
} from "@/lib/follow-ups";
import { settlesOnReply } from "@/lib/follow-up-replies";
import { dueDistance } from "@/lib/follow-up-schedule";
import type { CalendarTask, Email } from "@/lib/jmap/types";

const DAY_FORMAT = { weekday: "short", day: "2-digit", month: "2-digit" } as const;

/** Days and times as the follow-up's parts show them. */
export function useFollowUpFormat() {
  const t = useTranslations("follow_up");
  const format = useFormatter();
  const displayFormat = useDisplayDateFormatter();
  const hour12 = useSettingsStore((s) => s.timeFormat) === "12h";

  return useMemo(() => {
    /** A display date's day, "Fri, 30.10." */
    const day = (date: Date) => displayFormat.dateTime(date, DAY_FORMAT);
    /** A real instant's day and time, in the user's time zone. */
    const dayTime = (instant: Date) => format.dateTime(instant, { ...DAY_FORMAT, hour: "2-digit", minute: "2-digit", hour12 });
    const time = (instant: Date) => format.dateTime(instant, { hour: "2-digit", minute: "2-digit", hour12 });
    const weekdayTime = (instant: Date) => format.dateTime(instant, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12 });

    /** "due tomorrow", "due Thu", "overdue for 3 days", "no date". */
    const due = (task: CalendarTask, now: Date) => {
      const distance = dueDistance(followUpDueDay(task), now);
      switch (distance.kind) {
        case "none": return t("no_date");
        case "today": return t("due_today");
        case "tomorrow": return t("due_tomorrow");
        case "weekday": return t("due_on", { day: displayFormat.dateTime(distance.day, { weekday: "short" }) });
        case "date": return t("due_on", { day: day(distance.day) });
        case "yesterday": return t("overdue_yesterday");
        case "days_ago": return t("overdue_days", { count: distance.count });
      }
    };

    /** A reminder: "Wed 10:00" within the week ahead, else "Fri, 06.11., 10:00". */
    const reminder = (instant: Date, now: Date) => {
      const days = differenceInCalendarDays(toDisplayDate(instant), now);
      return days >= 0 && days < 7 ? weekdayTime(instant) : dayTime(instant);
    };

    /**
     * What the follow-up asks for, a built-in action in the current language
     * whatever language it was written in; null for the default ("Follow
     * up"), which goes without saying.
     */
    const action = (task: CalendarTask) => {
      const text = followUpAction(task);
      const key = followUpActionKey(text);
      if (!text || key === "follow_up") return null;
      return key ? t(`actions.${key}`) : text;
    };

    return { day, dayTime, time, weekdayTime, due, reminder, action };
  }, [t, format, displayFormat, hour12]);
}

const STATE_CLASSES: Record<FollowUpState, string> = {
  open: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  overdue: "bg-destructive/10 text-destructive font-medium",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

const FLAG_CLASSES: Record<FollowUpState, string> = {
  open: "text-orange-600 dark:text-orange-400",
  overdue: "text-destructive",
  done: "text-emerald-600 dark:text-emerald-400",
};

/**
 * The ⚑ at a list row's end: a click sets "Today", the next marks it done,
 * the next removes it (Outlook's Quick Click); a right click opens the
 * popover "Follow up" there.
 */
export function FollowUpFlagButton({ email, className, onlyWhenSet = false, revealOnHover = false }: {
  email: Email;
  className?: string;
  /** Shown only while the mail has a follow-up (a row whose hover actions show it otherwise). */
  onlyWhenSet?: boolean;
  /** Without a follow-up, shown only while the row (a `group`) is hovered or it has focus. */
  revealOnHover?: boolean;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const controls = useFollowUp(email);
  const { task } = controls;
  if (!controls.available || (onlyWhenSet && !task)) return null;

  const now = displayNow();
  const state = task ? followUpState(task, now) : null;
  const title = !state ? t("flag_set") : state === "done" ? t("flag_clear") : t("flag_done");
  // Says what the follow-up is and what a click does: "Follow-up: due tomorrow – click: mark complete".
  const label = t("flag_aria", {
    state: !task || !state ? t("flag_state_none") : state === "done" ? t("done") : fmt.due(task, now),
    action: !state ? t("flag_action_set") : state === "done" ? t("flag_action_clear") : t("flag_action_done"),
  });
  const Icon = state === "done" ? Check : Flag;

  return (
    <button
      type="button"
      data-testid="follow-up-flag"
      data-follow-up={state ?? "none"}
      aria-label={label}
      title={title}
      className={cn(
        "rounded p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10",
        state ? FLAG_CLASSES[state] : "text-muted-foreground hover:text-orange-600 dark:hover:text-orange-400",
        !state && revealOnHover && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); void controls.quickClick(); }}
      onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useFollowUpPopover.getState().openAt(email, { x: e.clientX, y: e.clientY }, e.currentTarget);
      }}
    >
      <Icon className={cn("w-4 h-4", state && state !== "done" && "fill-current")} />
    </button>
  );
}

/**
 * The row's chip: "⚑ due tomorrow", "⚑ Call · due Thu · 🔔 Wed 10:00", red
 * "overdue for 3 days", "✓ completed"; on a group mailbox's mail "⚑ only me ·
 * due Thu", since no colleague sees it. One that settles itself when an
 * answer comes ends with ↩ and says so in its title.
 */
export function FollowUpChip({ email, className }: { email: Email; className?: string }) {
  return (
    <>
      <OwnFollowUpChip email={email} className={className} />
      <GroupFollowUpChips email={email} className={className} />
    </>
  );
}

function OwnFollowUpChip({ email, className }: { email: Email; className?: string }) {
  const t = useTranslations("follow_up");
  const { available, onlyMe, task } = useFollowUp(email);
  if (!available || !task) return null;
  const open = task.progress !== "completed";
  return (
    <FollowUpChipView
      task={task}
      testId="follow-up-chip"
      palette={STATE_CLASSES}
      data={{ "data-only-me": onlyMe || undefined }}
      lead={onlyMe ? t("only_me") : null}
      reminderAt={open ? followUpReminder(task) : null}
      settles={open && settlesOnReply(task)}
      titleExtras={[onlyMe && t("kept_only_me_tasks")]}
      className={className}
    />
  );
}

type DataAttributes = Record<`data-${string}`, string | boolean | undefined>;

/**
 * A follow-up's chip, as a row shows it: who or "only me" (`lead`), what,
 * when due, the reminder, ↩ for one that settles itself on an answer.
 */
function FollowUpChipView({ task, testId, palette, data, lead, reminderAt, settles = false, titleExtras = [], className }: {
  task: CalendarTask;
  testId: string;
  palette: Record<FollowUpState, string>;
  data?: DataAttributes;
  lead: string | null;
  /** The reminder to show; null for none (done, or not the user's). */
  reminderAt: Date | null;
  settles?: boolean;
  /** More for the tooltip, after what the chip says. */
  titleExtras?: (string | false | null)[];
  className?: string;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const now = displayNow();
  const state = followUpState(task, now);
  const Icon = state === "done" ? Check : Flag;
  const reminder = reminderAt ? fmt.reminder(reminderAt, now) : null;
  const text = [lead, ...(state === "done" ? [t("done")] : [fmt.action(task), fmt.due(task, now)])]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-testid={testId}
      data-follow-up={state}
      data-settles-on-reply={settles || undefined}
      {...data}
      title={[
        text,
        reminder && t("bar_reminder", { when: reminder }),
        settles && t("reply.settles_short"),
        ...titleExtras,
      ].filter(Boolean).join(" · ")}
      className={cn("inline-flex max-w-[16rem] shrink-0 items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs", palette[state], className)}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
      {reminder && (
        <span data-testid={`${testId}-reminder`} className="inline-flex shrink-0 items-center gap-0.5 opacity-80">
          <span aria-hidden="true">·</span>
          <Bell className="h-3 w-3 shrink-0" aria-label={t("reminder_label")} />
          {reminder}
        </span>
      )}
      {settles && (
        <span data-testid={`${testId}-settles`} className="inline-flex shrink-0 items-center gap-0.5 opacity-80">
          <span aria-hidden="true">·</span>
          <Reply className="h-3 w-3 shrink-0" role="img" aria-label={t("reply.settles_short")} />
        </span>
      )}
    </span>
  );
}

/** "⚑ Follow up ▾" in the reader, opening the popover "Follow up" under it. */
export function FollowUpReaderButton({ email }: { email: Email }) {
  const t = useTranslations("follow_up");
  const controls = useFollowUp(email);
  if (!controls.available) return null;
  const state = controls.task ? followUpState(controls.task, displayNow()) : null;
  return (
    <button
      type="button"
      data-testid="follow-up-reader-button"
      aria-haspopup="menu"
      className={cn(
        "flex-shrink-0 self-center inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted transition-colors",
        state ? FLAG_CLASSES[state] : "text-muted-foreground",
      )}
      onClick={(e) => useFollowUpPopover.getState().openBelow(email, e.currentTarget)}
    >
      <Flag className={cn("w-4 h-4", state && state !== "done" && "fill-current")} />
      <span>{t("reader_button")}</span>
      <ChevronDown className="w-3.5 h-3.5" />
    </button>
  );
}

/**
 * The reader's bar while the mail has a follow-up: what, due, reminder, note;
 * Complete, Change …, Remove. On a group mailbox's mail it starts with "only
 * me": the user's own task, which no colleague sees.
 */
export function FollowUpInfoBar({ email }: { email: Email }) {
  return (
    <>
      <OwnFollowUpInfoBar email={email} />
      <GroupFollowUpInfoBars email={email} />
    </>
  );
}

function OwnFollowUpInfoBar({ email }: { email: Email }) {
  const t = useTranslations("follow_up");
  const controls = useFollowUp(email);
  const { task } = controls;
  if (!controls.available || !task) return null;
  return (
    <FollowUpBarView
      task={task}
      testId="follow-up-bar"
      palette={STATE_CLASSES}
      data={{ "data-only-me": controls.onlyMe || undefined }}
      lead={controls.onlyMe ? <span data-testid="follow-up-bar-only-me" title={t("kept_only_me_tasks")}>{t("only_me")}</span> : null}
      reminderAt={followUpReminder(task)}
      settles={settlesOnReply(task)}
      onDone={() => void controls.markDone()}
      onChange={() => controls.openDialog("action")}
      onRemove={() => void controls.remove()}
    />
  );
}

const SEP = <span aria-hidden="true"> · </span>;

/**
 * A follow-up's bar above the mail: who or "only me" (`lead`), what, due,
 * the reminder, settling on an answer, the note; Complete, Change …, Remove.
 */
function FollowUpBarView({ task, testId, palette, data, lead, reminderAt, settles = false, busy = false, onDone, onChange, onRemove, children }: {
  task: CalendarTask;
  testId: string;
  palette: Record<FollowUpState, string>;
  data?: DataAttributes;
  lead: React.ReactNode;
  /** The reminder to show; null for none (or not the user's). */
  reminderAt: Date | null;
  settles?: boolean;
  busy?: boolean;
  onDone: () => void;
  onChange: () => void;
  onRemove: () => void;
  /** After the buttons (a confirmation dialog). */
  children?: React.ReactNode;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const now = displayNow();
  const state = followUpState(task, now);
  const due = followUpDueDay(task);
  const note = followUpNote(task);
  const Icon = state === "done" ? Check : Flag;

  return (
    <div
      data-testid={testId}
      data-follow-up={state}
      {...data}
      role="status"
      className={cn("border-b border-border px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm", palette[state])}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-[12rem]">
        {lead && <>{lead}{SEP}</>}
        {state === "done" ? t("bar_done") : (
          <>
            <b data-testid={`${testId}-action`}>{fmt.action(task) ?? t("bar_action")}</b>
            {SEP}
            {due ? (state === "overdue" ? fmt.due(task, now) : t("due_on", { day: fmt.day(due) })) : t("no_date")}
            {reminderAt && (
              <>
                {SEP}
                <span data-testid={`${testId}-reminder`} className="inline-flex items-center gap-1">
                  <Bell className="h-3.5 w-3.5" aria-label={t("reminder_label")} />
                  {fmt.reminder(reminderAt, now)}
                </span>
              </>
            )}
            {settles && (
              <>
                {SEP}
                <span data-testid={`${testId}-settles`}>{t("reply.settles_short")}</span>
              </>
            )}
            {note && (
              <>
                {SEP}
                <span data-testid={`${testId}-note`} className="break-words">{t("bar_note", { note })}</span>
              </>
            )}
          </>
        )}
      </span>
      {state !== "done" && (
        <button type="button" disabled={busy} className="underline underline-offset-2 hover:opacity-80" onClick={onDone}>
          {t("done_button")}
        </button>
      )}
      {state !== "done" && (
        <button
          type="button"
          data-testid={`${testId}-change`}
          className="underline underline-offset-2 hover:opacity-80"
          onClick={onChange}
        >
          {t("change_button")}
        </button>
      )}
      <button type="button" disabled={busy} className="underline underline-offset-2 hover:opacity-80" onClick={onRemove}>
        {t("remove_button")}
      </button>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A group mailbox's task list
// ---------------------------------------------------------------------------

const GROUP_STATE_CLASSES: Record<FollowUpState, string> = {
  open: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  overdue: "bg-destructive/10 text-destructive font-medium",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

/** The group follow-ups on a mail of a group mailbox, and that group's list. */
function useMailGroupFollowUps(email: Email) {
  const enabled = useFollowUpsEnabled();
  const client = useAuthStore((s) => s.client);
  const accountId = enabled ? followUpMailAccount(email, client) : null;
  const groupAccountId = accountId && client && accountId !== client.getAccountId() ? accountId : null;
  const tasks = useGroupFollowUpsOf(email.id, groupAccountId);
  const lists = useGroupTasks((s) => s.lists);
  const list = groupAccountId ? lists.find((l) => l.accountId === groupAccountId) ?? null : null;
  return { tasks: email.isScheduled || email.keywords?.$draft ? [] : tasks, list };
}

/** "for Anna (from Ben)", "for me", "for Anna": whom a group task is for and who set it. */
export function useGroupPeopleText() {
  const t = useTranslations("follow_up");
  const mine = useMyAddresses();
  const principals = usePrincipals();
  return useCallback((task: CalendarTask) => {
    const people = groupTaskPeople(task, mine, principals);
    // A task naming no one (written elsewhere) is everyone's.
    const forWhom = people.forMe ? t("group.for_me") : t("group.for_person", { name: people.forName ?? t("group.nobody") });
    const by = people.byMe ? t("group.by_me") : people.byName ? t("group.by_person", { name: people.byName }) : null;
    // The chip's short name: "me", or the colleague's.
    const short = people.forMe ? t("group.chip_me") : people.forName ?? t("group.nobody");
    return { forWhom, by, short, forMe: people.forMe };
  }, [t, mine, principals]);
}

/**
 * The chips of a group mailbox's mail, one per follow-up in the group's
 * list, which every member sees: "⚑ Anna · Write a quote · due Thu"; the
 * reminder only on the user's own.
 */
function GroupFollowUpChips({ email, className }: { email: Email; className?: string }) {
  const { tasks, list } = useMailGroupFollowUps(email);
  if (tasks.length === 0) return null;
  return <GroupFollowUpChipList tasks={tasks} listName={list?.name ?? null} className={className} />;
}

function GroupFollowUpChipList({ tasks, listName, className }: { tasks: CalendarTask[]; listName: string | null; className?: string }) {
  const t = useTranslations("follow_up");
  const people = useGroupPeopleText();
  const mine = useMyAddresses();
  return (
    <>
      {tasks.map((task) => {
        const who = people(task);
        return (
          <FollowUpChipView
            key={task.id}
            task={task}
            testId="group-follow-up-chip"
            palette={GROUP_STATE_CLASSES}
            data={{ "data-for-me": who.forMe || undefined }}
            lead={who.short}
            // The reminder is its owner's alone.
            reminderAt={task.progress !== "completed" && isTaskForMe(task, mine) ? followUpReminder(task) : null}
            titleExtras={[who.by && `${who.forWhom} ${who.by}`, listName && t("group.chip_title", { group: listName })]}
            className={className}
          />
        );
      })}
    </>
  );
}

/**
 * The reader's bar for each follow-up in the group's list: "for Anna (from
 * Ben) · Task list sales@ · Write a quote · due Thu"; anyone who reads the
 * list may complete, change or remove it.
 */
function GroupFollowUpInfoBars({ email }: { email: Email }) {
  const { tasks, list } = useMailGroupFollowUps(email);
  if (tasks.length === 0) return null;
  return <>{tasks.map((task) => <GroupFollowUpInfoBar key={task.id} email={email} task={task} listName={list?.name ?? null} />)}</>;
}

function GroupFollowUpInfoBar({ email, task, listName }: { email: Email; task: CalendarTask; listName: string | null }) {
  const t = useTranslations("follow_up");
  const people = useGroupPeopleText();
  const mine = useMyAddresses();
  const client = useAuthStore((s) => s.client);
  const { dialogProps, confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const who = people(task);
  const messages = { failed: t("failed"), flagFailed: t("flag_failed") };

  const markDone = async () => {
    if (!client || busy) return;
    setBusy(true);
    await completeTask(client, task, messages);
    setBusy(false);
  };
  const remove = async () => {
    if (!client || busy) return;
    // Colleagues see it too: asked first.
    if (!(await confirm({
      title: t("group.remove_title"),
      message: t("group.remove_confirm", { group: listName ?? "" }),
      confirmText: t("remove_button"),
      variant: "destructive",
    }))) return;
    setBusy(true);
    try {
      await deleteGroupTask(client, task);
    } catch {
      toast.error(t("failed"));
    }
    setBusy(false);
  };

  return (
    <FollowUpBarView
      task={task}
      testId="group-follow-up-bar"
      palette={GROUP_STATE_CLASSES}
      lead={(
        <>
          <span data-testid="group-follow-up-bar-for">{who.by ? `${who.forWhom} (${who.by})` : who.forWhom}</span>
          {listName && (
            <>
              {SEP}
              <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden="true" />{t("group.list_of", { group: listName })}</span>
            </>
          )}
        </>
      )}
      // The reminder is its owner's alone.
      reminderAt={isTaskForMe(task, mine) ? followUpReminder(task) : null}
      busy={busy}
      onDone={() => void markDone()}
      onChange={() => useFollowUpDialog.getState().open(email, "action", { taskId: task.id })}
      onRemove={() => void remove()}
    >
      <ConfirmDialog {...dialogProps} />
    </FollowUpBarView>
  );
}

/**
 * Where a task of a group's list comes from, before what the pane and the
 * reminders window say of it: "👥 sales@ · from Ben · ". Nothing for a
 * task of the user's own list.
 */
export function GroupTaskSource({ task }: { task: CalendarTask }) {
  const lists = useGroupTasks((s) => s.lists);
  const list = task.isShared ? groupListOfTask(task, lists) : null;
  if (!list) return null;
  return <GroupTaskSourceText task={task} name={list.name} />;
}

function GroupTaskSourceText({ task, name }: { task: CalendarTask; name: string }) {
  const t = useTranslations("follow_up");
  const people = useGroupPeopleText();
  const list = { name };
  const who = people(task);
  return (
    <span data-testid="group-task-source" className="inline-flex items-center gap-1" title={t("group.chip_title", { group: list.name })}>
      <Users className="h-3 w-3 shrink-0" aria-label={t("group.list_of", { group: list.name })} />
      <span>{[list.name, who.by].filter(Boolean).join(" · ")}</span>
      <span aria-hidden="true"> · </span>
    </span>
  );
}
