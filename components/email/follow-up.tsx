"use client";

import { useCallback, useMemo } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { differenceInCalendarDays, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, Check, ChevronDown, Flag, Pencil, Reply } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuHeader,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { useFollowUp, type FollowUpControls } from "@/hooks/use-follow-ups";
import { useSettingsStore } from "@/stores/settings-store";
import { displayNow, fromDisplayDate, toDisplayDate } from "@/lib/timezone";
import {
  FOLLOW_UP_CHOICES,
  dueDistance,
  followUpAction,
  followUpActionKey,
  followUpNote,
  followUpDueDay,
  followUpReminder,
  followUpState,
  scheduleFollowUp,
  settlesOnReply,
  type FollowUpState,
} from "@/lib/follow-ups";
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
 * The menu's entries: the quick choices, each with its due day and reminder
 * time, then done and remove.
 */
export function FollowUpMenuItems({ controls, onClose, heading = true }: {
  controls: FollowUpControls;
  onClose: () => void;
  /** Off inside a submenu, whose entry already names it. */
  heading?: boolean;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const now = displayNow();
  const { task, workingTime } = controls;
  const open = !!task && task.progress !== "completed";

  return (
    <>
      {heading && <ContextMenuHeader>{controls.onlyMe ? t("menu_title_only_me") : t("menu_title")}</ContextMenuHeader>}
      {FOLLOW_UP_CHOICES.map((choice) => {
        const { due, reminder } = scheduleFollowUp(choice, now, workingTime);
        // The reminder's time, with its weekday when it comes before the due day.
        const remind = reminder && (due && isSameDay(reminder, due)
          ? fmt.time(fromDisplayDate(reminder))
          : fmt.weekdayTime(fromDisplayDate(reminder)));
        const parts = [due && fmt.day(due), remind].filter(Boolean);
        return (
          <ContextMenuItem
            key={choice}
            icon={Flag}
            label={t(`choices.${choice}`)}
            shortcut={parts.join(" · ") || undefined}
            testId={`follow-up-${choice}`}
            onClick={() => { onClose(); void controls.apply(choice); }}
          />
        );
      })}
      <ContextMenuItem
        icon={Pencil}
        label={t("custom")}
        testId="follow-up-custom"
        onClick={() => { onClose(); controls.openDialog("action"); }}
      />
      <ContextMenuItem
        icon={Bell}
        label={t("add_reminder")}
        testId="follow-up-add-reminder"
        onClick={() => { onClose(); controls.openDialog("reminder"); }}
      />
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Check}
        label={t("mark_done")}
        testId="follow-up-done"
        disabled={!open}
        onClick={() => { onClose(); void controls.markDone(); }}
      />
      <ContextMenuItem
        icon={Flag}
        label={t("remove")}
        testId="follow-up-remove"
        disabled={!task}
        onClick={() => { onClose(); void controls.remove(); }}
      />
    </>
  );
}

/** The menu on its own, at the pointer or under a button. */
function useFollowUpMenu(controls: FollowUpControls) {
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<true>();
  const menu = (
    <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
      <FollowUpMenuItems controls={controls} onClose={closeContextMenu} />
    </ContextMenu>
  );
  return { menu, openContextMenu };
}

/**
 * The ⚑ at a list row's end: a click sets "Today", the next marks it done,
 * the next removes it (Outlook's Quick Click); a right click opens the menu.
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
  const { menu, openContextMenu } = useFollowUpMenu(controls);
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
    <>
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
        onContextMenu={(e) => openContextMenu(e, true)}
      >
        <Icon className={cn("w-4 h-4", state && state !== "done" && "fill-current")} />
      </button>
      {menu}
    </>
  );
}

/**
 * The row's chip: "⚑ due tomorrow", "⚑ Call · due Thu · 🔔 Wed 10:00", red
 * "overdue for 3 days", "✓ completed"; on a group mailbox's mail "⚑ only me ·
 * due Thu", since no colleague sees it. One that settles itself when an
 * answer comes ends with ↩ and says so in its title.
 */
export function FollowUpChip({ email, className }: { email: Email; className?: string }) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const { available, onlyMe, task } = useFollowUp(email);
  if (!available || !task) return null;
  const now = displayNow();
  const state = followUpState(task, now);
  const Icon = state === "done" ? Check : Flag;
  const action = state === "done" ? null : fmt.action(task);
  const reminderAt = state === "done" ? null : followUpReminder(task);
  const reminder = reminderAt ? fmt.reminder(reminderAt, now) : null;
  const settles = state !== "done" && settlesOnReply(task);
  const text = [onlyMe && t("only_me"), ...(state === "done" ? [t("done")] : [action, fmt.due(task, now)])]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-testid="follow-up-chip"
      data-follow-up={state}
      data-only-me={onlyMe || undefined}
      data-settles-on-reply={settles || undefined}
      title={[
        text,
        reminder && t("bar_reminder", { when: reminder }),
        settles && t("reply.settles_short"),
        onlyMe && t("kept_only_me_tasks"),
      ].filter(Boolean).join(" · ")}
      className={cn("inline-flex max-w-[16rem] shrink-0 items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs", STATE_CLASSES[state], className)}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
      {reminder && (
        <span data-testid="follow-up-chip-reminder" className="inline-flex shrink-0 items-center gap-0.5 opacity-80">
          <span aria-hidden="true">·</span>
          <Bell className="h-3 w-3 shrink-0" aria-label={t("reminder_label")} />
          {reminder}
        </span>
      )}
      {settles && (
        <span data-testid="follow-up-chip-settles" className="inline-flex shrink-0 items-center gap-0.5 opacity-80">
          <span aria-hidden="true">·</span>
          <Reply className="h-3 w-3 shrink-0" role="img" aria-label={t("reply.settles_short")} />
        </span>
      )}
    </span>
  );
}

/** "⚑ Follow up ▾" in the reader. */
export function FollowUpReaderButton({ email }: { email: Email }) {
  const t = useTranslations("follow_up");
  const controls = useFollowUp(email);
  const { menu, openContextMenu } = useFollowUpMenu(controls);
  const openBelow = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu({ ...e, clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, true);
  }, [openContextMenu]);
  if (!controls.available) return null;
  const state = controls.task ? followUpState(controls.task, displayNow()) : null;
  return (
    <>
      <button
        type="button"
        data-testid="follow-up-reader-button"
        aria-haspopup="menu"
        className={cn(
          "flex-shrink-0 self-center inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted transition-colors",
          state ? FLAG_CLASSES[state] : "text-muted-foreground",
        )}
        onClick={openBelow}
      >
        <Flag className={cn("w-4 h-4", state && state !== "done" && "fill-current")} />
        <span>{t("reader_button")}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {menu}
    </>
  );
}

/**
 * The reader's bar while the mail has a follow-up: what, due, reminder, note;
 * Complete, Change …, Remove. On a group mailbox's mail it starts with "only
 * me": the user's own task, which no colleague sees.
 */
export function FollowUpInfoBar({ email }: { email: Email }) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const controls = useFollowUp(email);
  const { task } = controls;
  if (!controls.available || !task) return null;

  const now = displayNow();
  const state = followUpState(task, now);
  const due = followUpDueDay(task);
  const reminder = followUpReminder(task);
  const note = followUpNote(task);
  const Icon = state === "done" ? Check : Flag;
  const sep = <span aria-hidden="true"> · </span>;

  return (
    <div
      data-testid="follow-up-bar"
      data-follow-up={state}
      data-only-me={controls.onlyMe || undefined}
      role="status"
      className={cn("border-b border-border px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm", STATE_CLASSES[state])}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-[12rem]">
        {controls.onlyMe && (
          <>
            <span data-testid="follow-up-bar-only-me" title={t("kept_only_me_tasks")}>{t("only_me")}</span>
            {sep}
          </>
        )}
        {state === "done" ? t("bar_done") : (
          <>
            <b data-testid="follow-up-bar-action">{fmt.action(task) ?? t("bar_action")}</b>
            {sep}
            {due ? (state === "overdue" ? fmt.due(task, now) : t("due_on", { day: fmt.day(due) })) : t("no_date")}
            {reminder && (
              <>
                {sep}
                <span data-testid="follow-up-bar-reminder" className="inline-flex items-center gap-1">
                  <Bell className="h-3.5 w-3.5" aria-label={t("reminder_label")} />
                  {fmt.reminder(reminder, now)}
                </span>
              </>
            )}
            {settlesOnReply(task) && (
              <>
                {sep}
                <span data-testid="follow-up-bar-settles">{t("reply.settles_short")}</span>
              </>
            )}
            {note && (
              <>
                {sep}
                <span data-testid="follow-up-bar-note" className="break-words">{t("bar_note", { note })}</span>
              </>
            )}
          </>
        )}
      </span>
      {state !== "done" && (
        <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => void controls.markDone()}>
          {t("done_button")}
        </button>
      )}
      {state !== "done" && (
        <button
          type="button"
          data-testid="follow-up-bar-change"
          className="underline underline-offset-2 hover:opacity-80"
          onClick={() => controls.openDialog("action")}
        >
          {t("change_button")}
        </button>
      )}
      <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => void controls.remove()}>
        {t("remove_button")}
      </button>
    </div>
  );
}
