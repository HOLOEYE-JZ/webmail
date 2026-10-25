"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { isSameDay } from "date-fns";
import { Check, Flag, Pencil, Users } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuHeader,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { useFollowUp, type FollowUpControls } from "@/hooks/use-follow-ups";
import { useFollowUpPopover } from "@/stores/follow-up-popover-store";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { FOLLOW_UP_CHOICES, scheduleFollowUp } from "@/lib/follow-up-schedule";
import { useFollowUpFormat } from "./follow-up";

/**
 * The popover "Follow up" for the mail `useFollowUpPopover` names, as a
 * menu: the quick choices, Custom …, For a colleague …, done and remove.
 * A choice closes it, as do Escape, Tab and a click outside. Mounted once.
 */
export function FollowUpPopoverHost() {
  const email = useFollowUpPopover((s) => s.email);
  const position = useFollowUpPopover((s) => s.position);
  const trigger = useFollowUpPopover((s) => s.trigger);
  const close = useFollowUpPopover((s) => s.close);
  const controls = useFollowUp(email);
  const isOpen = !!email && controls.available;

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
    <ContextMenu ref={boxRef} isOpen={isOpen} position={position} onClose={close}>
      <div ref={menuRef} onKeyDown={onKeyDown} data-testid="follow-up-popover" className="w-72 max-w-full">
        {isOpen && <FollowUpPopoverItems controls={controls} onClose={close} />}
      </div>
    </ContextMenu>
  );
}

/** The entries: each quick choice with its due day and reminder on the right. */
function FollowUpPopoverItems({ controls, onClose }: { controls: FollowUpControls; onClose: () => void }) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const now = displayNow();
  const { task, workingTime } = controls;
  const open = !!task && task.progress !== "completed";

  return (
    <>
      <ContextMenuHeader>{controls.onlyMe ? t("menu_title_only_me") : t("menu_title")}</ContextMenuHeader>
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
      {/* A colleague only in a group mailbox's list: they could not read a mail of the user's own. */}
      {controls.group ? (
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
        icon={Flag}
        label={t("remove")}
        testId="follow-up-remove"
        disabled={!task}
        onClick={() => { onClose(); void controls.remove(); }}
      />
    </>
  );
}
