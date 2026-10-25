"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Flag } from "@/components/icons";
import { SendFollowUpDialog } from "@/components/email/follow-up-dialog";
import { useFollowUpFormat } from "@/components/email/follow-up";
import { useFollowUpsEnabled, useWorkingTime } from "@/hooks/use-follow-ups";
import { useGroupTaskList } from "@/hooks/use-group-follow-ups";
import { useEmailStore } from "@/stores/email-store";
import { displayNow, fromDisplayDate } from "@/lib/timezone";
import { NO_ANSWER_CHOICES, scheduleNoAnswer, type NoAnswerChoice } from "@/lib/follow-up-schedule";
import { detailsOf, sendFollowUpDetails, storedDetails, type SendFollowUp } from "@/lib/send-follow-up";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

const NONE = "none";
const CUSTOM = "custom";

/**
 * The JMAP account a mail from `fromEmail` goes out of (a group mailbox's for
 * a group identity), as the send resolves it; null while unknown.
 */
function useFromAccount(client: IJMAPClient | null, fromEmail: string | undefined): string | null {
  const [resolved, setResolved] = useState<{ key: string; accountId: string | null }>({ key: "", accountId: null });
  const key = `${client?.getAccountId() ?? ""}\u0000${fromEmail ?? ""}`;
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const resolve = client.resolveSendAccountId
      ? client.resolveSendAccountId(fromEmail).catch(() => client.getAccountId())
      : Promise.resolve(client.getAccountId());
    void resolve.then((accountId) => { if (!cancelled) setResolved({ key, accountId }); });
    return () => { cancelled = true; };
  }, [client, fromEmail, key]);
  return resolved.key === key ? resolved.accountId : null;
}

/**
 * "⚑ Follow up" under the message being written:
 * none, "Remind me if no answer by <day>" three working days or a week on,
 * or "Custom …" (the follow-up dialog, its choices kept until sending). Once
 * the mail has left, the follow-up stands on its sent copy, for the user
 * (hooks/use-send-follow-up.ts). Shown while follow-ups are on.
 */
export function ComposeFollowUp({ value, onChange, client, fromEmail, fromName, subject }: {
  value: SendFollowUp | null;
  onChange: (value: SendFollowUp | null) => void;
  /** The client of the login the mail goes out through. */
  client: IJMAPClient | null;
  fromEmail?: string;
  fromName?: string;
  subject: string;
}) {
  const t = useTranslations("follow_up");
  const id = useId();
  const enabled = useFollowUpsEnabled();
  const work = useWorkingTime();
  const format = useFollowUpFormat();
  const accountId = useFromAccount(enabled ? client : null, fromEmail);
  const fromGroup = !!client && !!accountId && accountId !== client.getAccountId();
  const group = useGroupTaskList(fromGroup ? accountId : null);
  const mailboxName = useEmailStore((s) => (fromGroup
    ? s.mailboxes.find((m) => m.isShared && m.accountId === accountId && m.accountName)?.accountName ?? null
    : null));
  const [dialog, setDialog] = useState(false);

  const now = displayNow();
  const today = now.toDateString();
  const days = useMemo(() => Object.fromEntries(NO_ANSWER_CHOICES.map((choice) => [
    choice,
    scheduleNoAnswer(choice, displayNow(), work).due,
  ])) as Record<NoAnswerChoice, Date>, [work, today]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled) return null;

  const pick = (choice: string) => {
    if (choice === CUSTOM) {
      setDialog(true);
      return;
    }
    onChange((NO_ANSWER_CHOICES as readonly string[]).includes(choice) ? { choice: choice as NoAnswerChoice } : null);
  };

  // The dialog starts with what was chosen: a custom choice as it was, a
  // no-answer one (or none) as three working days with settling on an answer.
  const start = () => (value?.choice === CUSTOM
    ? detailsOf(value.details)
    : sendFollowUpDetails(value ?? { choice: "three-workdays" }, displayNow(), work, t("actions.follow_up"), fromDisplayDate));

  const custom = value?.choice === CUSTOM ? detailsOf(value.details) : null;
  const customSummary = custom
    ? [
      custom.action.trim() || t("actions.follow_up"),
      custom.due ? t("due_on", { day: format.day(custom.due) }) : t("no_date"),
      custom.reminderAt ? t("bar_reminder", { when: format.reminder(custom.reminderAt, displayNow()) }) : null,
      custom.groupAccountId && group ? t("group.list_of", { group: group.name }) : null,
    ].filter(Boolean).join(" · ")
    : null;

  const hint = !value
    ? null
    : value.choice === CUSTOM
      ? customSummary
      : t("send.hint_no_answer");
  const where = !value
    ? null
    : fromGroup
      ? t("send.where_group", { group: mailboxName ?? group?.name ?? fromEmail ?? "", custom: t("custom") })
      : t("send.where_own");

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-1.5 bg-background shrink-0 text-sm"
      data-testid="composer-follow-up"
    >
      <Flag className="h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden="true" />
      <label htmlFor={`${id}-choice`} className="text-muted-foreground">{t("send.label")}</label>
      <select
        id={`${id}-choice`}
        data-testid="composer-follow-up-choice"
        value={value?.choice ?? NONE}
        onChange={(e) => pick(e.target.value)}
        className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value={NONE}>{t("send.none")}</option>
        {NO_ANSWER_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {t("send.no_answer_by", { day: format.day(days[choice]) })}
          </option>
        ))}
        <option value={CUSTOM}>{t("custom")}</option>
      </select>
      {value?.choice === CUSTOM && (
        <button
          type="button"
          data-testid="composer-follow-up-change"
          onClick={() => setDialog(true)}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:bg-muted hover:text-foreground hover:underline"
        >
          {t("change_button")}
        </button>
      )}
      {(hint || where) && (
        <span data-testid="composer-follow-up-hint" className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">
          {[hint, where].filter(Boolean).join(" ")}
        </span>
      )}
      {dialog && typeof document !== "undefined" && createPortal(
        <SendFollowUpDialog
          email={{ subject, from: fromEmail ? [{ name: fromName ?? "", email: fromEmail }] : undefined }}
          accountId={accountId}
          onlyMe={fromGroup}
          start={start()}
          onChoose={(details) => onChange({ choice: CUSTOM, details: storedDetails(details) })}
          onClose={() => setDialog(false)}
        />,
        document.body,
      )}
    </div>
  );
}
