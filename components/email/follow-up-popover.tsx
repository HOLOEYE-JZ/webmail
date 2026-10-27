"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { isSameDay } from "date-fns";
import { Check, Flag, Pencil, Trash2, Users } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuHeader,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { completeTask, useFollowUp, type FollowUpControls } from "@/hooks/use-follow-ups";
import { deleteGroupTask, updateAnyTask, updateGroupTask, useGroupTask } from "@/hooks/use-group-follow-ups";
import { useReminder } from "@/hooks/use-upcoming";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { useFollowUpDialog } from "@/stores/follow-up-dialog-store";
import { useFollowUpPopover } from "@/stores/follow-up-popover-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { rescheduleFollowUpTask } from "@/lib/follow-ups";
import { FOLLOW_UP_CHOICES, scheduleFollowUp } from "@/lib/follow-up-schedule";
import type { Email } from "@/lib/jmap/types";
import { useFollowUpFormat } from "./follow-up";

/**
 * The popover "Follow up" for the mail `useFollowUpPopover` names, as a
 * menu: the quick choices, Custom …, For a colleague …, done and remove;
 * for a follow-up in a group mailbox's task list, the same on that one;
 * for a task without a mail (a reminder), the quick choices, Change …, done
 * and delete. A choice closes it, as do Escape, Tab and a click outside.
 * Mounted once.
 */
export function FollowUpPopoverHost() {
  const email = useFollowUpPopover((s) => s.email);
  const groupTaskId = useFollowUpPopover((s) => s.groupTaskId);
  const taskId = useFollowUpPopover((s) => s.taskId);
  const position = useFollowUpPopover((s) => s.position);
  const trigger = useFollowUpPopover((s) => s.trigger);
  const close = useFollowUpPopover((s) => s.close);
  const { dialogProps, confirm } = useConfirmDialog();
  const own = useFollowUp(email);
  const group = useGroupFollowUpControls(own, email, groupTaskId, confirm);
  const reminder = useReminderControls(taskId, confirm);
  const controls = taskId ? reminder : groupTaskId ? group : own;
  const isOpen = (!!email || !!taskId) && controls.available;

  const triggerRef = useRef<HTMLElement | null>(null);
  triggerRef.current = trigger;
  const { menuRef, onKeyDown } = useMenuNavigation<HTMLDivElement>({ open: isOpen, onClose: close, triggerRef });
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Closes on Escape, a press outside, a scroll and leaving the window, as a context menu does.
  useEffect(() => {
    if (!isOpen) return;
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onPress = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (boxRef.current && e.target instanceof Node && boxRef.current.contains(e.target)) return;
      close();
    };
    // Not the press that opened it.
    const timer = setTimeout(() => {
      document.addEventListener("keydown", onEscape);
      document.addEventListener("mousedown", onPress);
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("blur", close);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", close);
    };
  }, [isOpen, close]);

  return (
    <>
      <ContextMenu ref={boxRef} isOpen={isOpen} position={position} onClose={close}>
        <div ref={menuRef} onKeyDown={onKeyDown} data-testid="follow-up-popover" className="w-72 max-w-full">
          {isOpen && <FollowUpPopoverItems controls={controls} withoutMail={!!taskId} onClose={close} />}
        </div>
      </ContextMenu>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}

type Confirm = ReturnType<typeof useConfirmDialog>["confirm"];

/**
 * The popover's handle on a follow-up in a group mailbox's task list, which
 * every member sees and anyone may move, complete or remove: written there,
 * never a flag on the mail; removing it is asked first.
 */
function useGroupFollowUpControls(own: FollowUpControls, email: Email | null, taskId: string | null, confirm: Confirm): FollowUpControls {
  const t = useTranslations("follow_up");
  const client = useAuthStore((s) => s.client);
  const task = useGroupTask(taskId);

  const write = async (change: () => Promise<boolean>) => {
    try {
      await change();
    } catch (error) {
      debug.error("group follow-up: not written", error);
      toast.error(t("failed"));
    }
  };

  return {
    ...own,
    available: own.available && !!own.group && !!task,
    // Not the user's own: every member sees it.
    onlyMe: false,
    task,
    apply: async (choice) => {
      if (!client || !task) return;
      const { due, reminder } = scheduleFollowUp(choice, displayNow(), own.workingTime);
      await write(() => updateGroupTask(client, task, rescheduleFollowUpTask(task, due, reminder ? fromDisplayDate(reminder) : null)));
    },
    openDialog: (focus) => {
      if (email && task) useFollowUpDialog.getState().open(email, focus, { taskId: task.id });
    },
    markDone: async () => {
      if (client && task) await completeTask(client, task, { failed: t("failed"), flagFailed: t("flag_failed") });
    },
    remove: async () => {
      if (!client || !task) return;
      // Colleagues see it too: asked first.
      if (!(await confirm({
        title: t("group.remove_title"),
        message: t("group.remove_confirm", { group: own.group?.name ?? "" }),
        confirmText: t("remove_button"),
        variant: "destructive",
      }))) return;
      await write(() => deleteGroupTask(client, task));
    },
  };
}

/**
 * The popover's handle on a task without a mail, the user's own or a group
 * list's: moved, completed or deleted there, nothing set on any mail;
 * deleting it is asked first, as the dialog does.
 */
function useReminderControls(taskId: string | null, confirm: Confirm): FollowUpControls {
  const t = useTranslations("follow_up");
  const client = useAuthStore((s) => s.client);
  const reminder = useReminder(taskId);
  const { task, group, workingTime } = reminder;

  const write = async (change: () => Promise<boolean>) => {
    try {
      await change();
    } catch (error) {
      debug.error("reminder: not written", error);
      toast.error(t("reminder.failed"));
    }
  };

  const markDone = async () => {
    if (client && task) await completeTask(client, task, { failed: t("reminder.failed"), flagFailed: t("flag_failed") });
  };

  return {
    available: !!taskId && reminder.available && !!task,
    onlyMe: false,
    mailboxName: null,
    group,
    openGroupDialog: () => {},
    task,
    workingTime,
    apply: async (choice) => {
      if (!client || !task) return;
      const { due, reminder: at } = scheduleFollowUp(choice, displayNow(), workingTime);
      await write(() => updateAnyTask(client, task, rescheduleFollowUpTask(task, due, at ? fromDisplayDate(at) : null)));
    },
    save: reminder.save,
    openDialog: () => {
      if (task) useFollowUpDialog.getState().openReminder({ taskId: task.id });
    },
    markDone,
    remove: async () => {
      if (!task) return;
      if (!(await confirm(group
        ? {
          title: t("group.remove_title"),
          message: t("group.remove_confirm", { group: group.name }),
          confirmText: t("remove_button"),
          variant: "destructive",
        }
        : {
          title: t("reminder.delete_title"),
          message: t("reminder.delete_confirm", { title: task.title ?? "" }),
          confirmText: t("reminder.delete"),
          variant: "destructive",
        }))) return;
      await reminder.remove();
    },
    quickClick: markDone,
  };
}

/** The entries: each quick choice with its due day and reminder on the right. */
function FollowUpPopoverItems({ controls, withoutMail, onClose }: {
  controls: FollowUpControls;
  /** A task without a mail: headed by its title, no colleague, deleted rather than cleared. */
  withoutMail: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const now = displayNow();
  const { task, workingTime } = controls;
  const open = !!task && task.progress !== "completed";
  const heading = withoutMail
    ? task?.title?.trim() || t("upcoming.no_title")
    : controls.onlyMe ? t("menu_title_only_me") : t("menu_title");

  return (
    <>
      <ContextMenuHeader>{heading}</ContextMenuHeader>
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
        label={withoutMail ? t("change_button") : t("custom")}
        testId="follow-up-custom"
        onClick={() => { onClose(); controls.openDialog("action"); }}
      />
      {/* A colleague only in a group mailbox's list: they could not read a mail of the user's own. */}
      {withoutMail ? null : controls.group ? (
        <ContextMenuItem
          icon={Users}
          label={t("group.menu_colleague", { group: controls.group.name })}
          testId="follow-up-colleague"
          onClick={() => { onClose(); controls.openGroupDialog(); }}
        />
      ) : controls.onlyMe ? (
        <ContextMenuItem
          icon={Users}
          label={t("group.menu_colleague_short")}
          hint={t("group.no_list")}
          testId="follow-up-colleague"
          disabled
          onClick={() => {}}
        />
      ) : (
        <ContextMenuItem
          icon={Users}
          label={t("group.menu_colleague_short")}
          shortcut={t("group.group_mailbox")}
          title={t("group.only_in_group")}
          testId="follow-up-colleague"
          disabled
          onClick={() => {}}
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Check}
        label={t("mark_done")}
        testId="follow-up-done"
        disabled={!open}
        onClick={() => { onClose(); void controls.markDone(); }}
      />
      <ContextMenuItem
        icon={withoutMail ? Trash2 : Flag}
        label={withoutMail ? t("reminder.delete") : t("remove")}
        testId="follow-up-remove"
        disabled={!task}
        onClick={() => { onClose(); void controls.remove(); }}
      />
    </>
  );
}
