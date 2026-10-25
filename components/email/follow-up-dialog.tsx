"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { format, startOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { Bell, Flag, Mail, Users, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import {
  followUpCalendars,
  useFollowUp,
  useFollowUpDialog,
  type FollowUpDetails,
  type FollowUpDialogFocus,
  type GroupDialogTarget,
} from "@/hooks/use-follow-ups";
import { useReminder } from "@/hooks/use-upcoming";
import {
  deleteGroupTask,
  useGroupTask,
  useMyAddresses,
  useTaskListSharees,
  writeGroupTask,
  type GroupTaskList,
} from "@/hooks/use-group-follow-ups";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { groupTaskOwner, type TaskPerson } from "@/lib/group-follow-ups";

/** "For" of a group task that names no one: everyone's, until the user names someone. */
const NOBODY = "\u0000nobody";
/** Whom the form's "For" holds: a colleague, null for the user, or `NOBODY`. */
type PersonChoice = TaskPerson | null | typeof NOBODY;
const isPerson = (choice: PersonChoice): choice is TaskPerson => !!choice && choice !== NOBODY;
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useCalendarStore } from "@/stores/calendar-store";
import { usePolicyStore } from "@/stores/policy-store";
import { displayNow, fromDisplayDate, toDisplayDate } from "@/lib/timezone";
import {
  FOLLOW_UP_CHOICES,
  followUpAction,
  followUpActionKey,
  followUpDueDay,
  followUpNote,
  isHtmlNote,
  isRecurringTask,
  followUpReminder,
  hasFollowUpMailAlert,
  mailReminderOffered,
  otherFollowUpAlerts,
  proposedFollowUpReminder,
  proposedReminder,
  scheduleFollowUp,
  settlesOnReply,
  type WorkingTime,
} from "@/lib/follow-ups";
import { FOLLOW_UP_ACTIONS, sanitizeFollowUpActions } from "@/lib/follow-up-actions";
import type { CalendarTask, Email } from "@/lib/jmap/types";

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

/**
 * The dialog of the mail view, for the mail or the reminder without a mail
 * `useFollowUpDialog` names. Mounted once.
 */
export function FollowUpDialogHost() {
  const email = useFollowUpDialog((s) => s.email);
  const group = useFollowUpDialog((s) => s.group);
  const reminder = useFollowUpDialog((s) => s.reminder);
  const focus = useFollowUpDialog((s) => s.focus);
  const close = useFollowUpDialog((s) => s.close);
  if (email) {
    return (
      <FollowUpDialog
        key={`${email.id}:${focus}:${group ? group.taskId ?? "new" : "own"}`}
        email={email}
        focus={focus}
        group={group}
        onClose={close}
      />
    );
  }
  if (reminder) {
    return (
      <ReminderDialog
        key={`${reminder.taskId ?? "new"}:${focus}`}
        taskId={reminder.taskId}
        title={reminder.title ?? ""}
        focus={focus}
        onClose={close}
      />
    );
  }
  return null;
}

/**
 * Where a new task can go besides the user's own list, and for whom (plan
 * 037 decision 8): "Visible" (only me / everyone in a group mailbox) and
 * "For" (me / the people the group's task list is shared with).
 */
interface PlaceChoice {
  /** The group lists offered; for an existing group task its own alone. */
  groups: GroupTaskList[];
  /** An existing group task: its list stays. */
  fixed: boolean;
  /** The group list chosen at first, null for the user's own. */
  initialGroup: string | null;
  /** Whom it is for at first, null for the user. */
  initialPerson: PersonChoice;
  /** "For a colleague …": the first colleague is chosen once the list's people are known. */
  colleague: boolean;
}

/** What the form needs of a mail's follow-up or of a reminder. */
interface FormControls {
  available: boolean;
  /** A group mailbox's mail: kept only in the user's own list, nothing set on the mail. */
  onlyMe?: boolean;
  /** The group mailbox's name, when known. */
  mailboxName?: string | null;
  task: CalendarTask | null;
  workingTime: WorkingTime;
  save: (details: FollowUpDetails) => Promise<boolean>;
  remove: () => Promise<void>;
  /** Offered where a group's list can take it; none: the user's own list, for the user. */
  place?: PlaceChoice;
}

/** A group task's owner as the form's "For" holds it: null for the user, `NOBODY` for none. */
function ownerPerson(task: CalendarTask | null, mine: ReadonlySet<string>): PersonChoice {
  if (!task) return null;
  const owner = groupTaskOwner(task);
  if (!owner?.email) return NOBODY;
  if (mine.has(owner.email)) return null;
  return { id: null, name: owner.name || owner.email.split("@")[0], email: owner.email };
}

/** Runs a group write; a failure is said, as the own list's writes do. */
async function guarded(write: () => Promise<boolean>, failed: string): Promise<boolean> {
  try {
    return await write();
  } catch (error) {
    debug.error("group follow-up: not written", error);
    toast.error(failed);
    return false;
  }
}

/**
 * Outlook's "Custom" follow-up: what to do, the due day, the reminder and a
 * note, all kept in the follow-up's task and read back from it.
 */
export function FollowUpDialog({ email, focus, group, onClose }: {
  email: Email;
  focus: FollowUpDialogFocus;
  /** A follow-up in the group's list (an existing one, or a new one for a colleague). */
  group?: GroupDialogTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const own = useFollowUp(email);
  const client = useAuthStore((s) => s.client);
  const mine = useMyAddresses();
  const groupTask = useGroupTask(group?.taskId ?? null);
  const list = own.group;
  const text = useMemo(() => ({
    title: (action: string, subject: string) => t("task_title", { action, subject }),
    noSubject: t("no_subject"),
    followUp: t("actions.follow_up"),
  }), [t]);

  const writeGroup = useCallback((target: GroupTaskList, task: CalendarTask | null, details: FollowUpDetails) => (
    client
      ? guarded(() => writeGroupTask(client, {
        list: target,
        task,
        person: details.person,
        details,
        mail: { email, accountId: target.accountId },
        text,
      }), t("failed"))
      : Promise.resolve(false)
  ), [client, email, text, t]);

  // Read once: the form keeps what the user chose while the lists reload.
  const [initialPerson] = useState(() => ownerPerson(groupTask, mine));

  let controls: FormControls;
  if (group) {
    controls = {
      available: own.available && !!list && (group.taskId === null || !!groupTask),
      // "Only me" here is the own list's, as on any group mailbox's mail.
      onlyMe: own.onlyMe,
      mailboxName: own.mailboxName,
      task: groupTask,
      workingTime: own.workingTime,
      // "Visible: only me" keeps it in the user's own list, as on any group mailbox's mail.
      save: (details) => (details.groupAccountId && list ? writeGroup(list, groupTask, details) : own.save(details)),
      remove: async () => {
        if (client && groupTask) await guarded(() => deleteGroupTask(client, groupTask), t("failed"));
      },
      place: list
        ? { groups: [list], fixed: !!groupTask, initialGroup: list.accountId, initialPerson, colleague: !groupTask }
        : undefined,
    };
  } else {
    controls = {
      ...own,
      // "Visible: everyone in vertrieb@" turns a new follow-up into one of the group's list.
      save: (details) => (details.groupAccountId && list ? writeGroup(list, null, details) : own.save(details)),
      place: !own.task && list
        ? { groups: [list], fixed: false, initialGroup: null, initialPerson: null, colleague: false }
        : undefined,
    };
  }
  return <FollowUpForm controls={controls} email={email} focus={focus} onClose={onClose} />;
}

/**
 * A reminder without a mail ("Check the dunning run"): what, the due day,
 * the reminder and a note, in the user's own task list. Also any task of
 * that list that is not a mail's follow-up, opened from the pane "Upcoming".
 */
export function ReminderDialog({ taskId, title, focus, onClose }: {
  /** The task, or null for a new reminder. */
  taskId: string | null;
  /** What a new reminder says, as typed in the pane. */
  title: string;
  focus: FollowUpDialogFocus;
  onClose: () => void;
}) {
  const reminder = useReminder(taskId);
  const mine = useMyAddresses();
  const [initialPerson] = useState(() => ownerPerson(reminder.group ? reminder.task : null, mine));
  const place: PlaceChoice | undefined = reminder.group
    ? { groups: [reminder.group], fixed: true, initialGroup: reminder.group.accountId, initialPerson, colleague: false }
    : !reminder.task && reminder.groups.length > 0
      ? { groups: reminder.groups, fixed: false, initialGroup: null, initialPerson: null, colleague: false }
      : undefined;
  return <FollowUpForm controls={{ ...reminder, place }} title={title} focus={focus} onClose={onClose} />;
}

function FollowUpForm({ controls, email, title: newTitle = "", focus, onClose }: {
  controls: FormControls;
  /** The mail of a follow-up; none for a reminder without one. */
  email?: Email;
  title?: string;
  focus: FollowUpDialogFocus;
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const id = useId();
  const { task, workingTime } = controls;
  const isReminder = !email;
  // A series' due day belongs to the task list; an HTML note to the client that wrote it.
  const recurring = !!task && isRecurringTask(task);
  const htmlNote = !!task && isHtmlNote(task);
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
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
    // A reminder is due today unless it says otherwise, a mail's follow-up tomorrow.
    const due = task
      ? followUpDueDay(task)
      : isReminder ? startOfDay(now) : scheduleFollowUp("tomorrow", now, workingTime).due;
    const stored = task ? followUpReminder(task) : null;
    const propose = isReminder ? proposedReminder : proposedFollowUpReminder;
    const reminder = stored
      ? toDisplayDate(stored)
      : focus === "reminder" ? propose(due, now, workingTime) : null;
    const action = isReminder
      ? (task ? task.title ?? "" : newTitle)
      : task ? shownAction(followUpAction(task)) : t("actions.follow_up");
    return {
      action,
      due,
      reminder,
      note: task ? followUpNote(task) : "",
      mail: task ? hasFollowUpMailAlert(task) : false,
      settles: task ? settlesOnReply(task) : false,
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
  const [other, setOther] = useState(() => !isReminder && !actions.includes(initial.action));
  const [due, setDue] = useState(isoDay(initial.due));
  const [reminderOn, setReminderOn] = useState(!!initial.reminder);
  // Empty without a reminder, so turning one on proposes a time to come.
  const [reminderDay, setReminderDay] = useState(isoDay(initial.reminder));
  const [reminderTime, setReminderTime] = useState(initial.reminder ? format(initial.reminder, "HH:mm") : "");
  const [reminderPast, setReminderPast] = useState(false);
  const [note, setNote] = useState(initial.note);
  const [mailOn, setMailOn] = useState(initial.mail);
  const [settlesOn, setSettlesOn] = useState(initial.settles);

  // "Visible" and "For": the group list chosen (null: the user's own) and
  // whom it is for (null: the user). A colleague only in a group's list.
  const place = controls.place;
  const [groupId, setGroupId] = useState<string | null>(place?.initialGroup ?? null);
  const [person, setPerson] = useState<PersonChoice>(place?.initialPerson ?? null);
  // Whom an existing group task is for changes only when the user picks someone.
  const [personPicked, setPersonPicked] = useState(false);
  // The group whose people "For" offers: the one chosen, else the first offered.
  const target = place ? place.groups.find((g) => g.accountId === groupId) ?? place.groups[0] ?? null : null;
  const sharees = useTaskListSharees(target?.list ?? null);
  const people = useMemo(() => {
    const listed = [...sharees];
    // Whom an existing task is for stays offered, also once the list is no longer shared with them.
    if (isPerson(person) && !listed.some((p) => p.email === person.email)) listed.unshift(person);
    return listed;
  }, [sharees, person]);
  const chosen = useRef(false);
  useEffect(() => {
    // "For a colleague …": the first one, once known, unless the user chose already.
    if (!place?.colleague || chosen.current || sharees.length === 0 || !target) return;
    chosen.current = true;
    setPerson(sharees[0]);
    setGroupId(target.accountId);
  }, [place?.colleague, sharees, target]);
  const pickPerson = (p: TaskPerson | null) => {
    chosen.current = true;
    setPersonPicked(true);
    setPerson(p);
    // A colleague is only possible in the group's list.
    if (p && !groupId && target) setGroupId(target.accountId);
  };
  const pickGroup = (accountId: string | null) => {
    chosen.current = true;
    if (accountId === groupId) return;
    setGroupId(accountId);
    // Another group's people are others.
    if (accountId !== target?.accountId) setPerson(null);
  };
  const inGroup = !!groupId && !!target;

  const actionRef = useRef<HTMLSelectElement>(null);
  const whatRef = useRef<HTMLInputElement>(null);
  const reminderTimeRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });

  useEffect(() => {
    const timer = setTimeout(() => {
      if (focus === "reminder") reminderTimeRef.current?.focus();
      else (whatRef.current ?? actionRef.current)?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [focus]);

  // The mail could leave the user's mailbox, the task be deleted elsewhere, or
  // follow-ups be turned off while the dialog is open.
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
      const proposed = (isReminder ? proposedReminder : proposedFollowUpReminder)(displayDateOf(due), displayNow(), workingTime);
      setReminderDay(isoDay(proposed));
      setReminderTime(format(proposed, "HH:mm"));
    }
  };

  const reminder = reminderOn ? displayDateOf(reminderDay, reminderTime) : null;
  const canSave = !busy && (!reminderOn || !!reminder) && (!due || !!displayDateOf(due)) && (!isReminder || !!action.trim());

  // Where it is kept: the task's own list, else where a new one goes.
  const taskCalendarId = task ? Object.keys(task.calendarIds ?? {})[0] : undefined;
  const list = (taskCalendarId && calendars.find((c) => c.id === taskCalendarId)) || followUpCalendars(calendars)[0];
  // "Settles itself when an answer comes" (plan 037 decision 9), for a mail's
  // follow-up only: the server would send the alarm mail all the same, so it
  // is not offered then (and taken off a task that has one).
  // Neither is offered for a group's list: the alarm mail would go to the
  // group's inbox, and settling on an answer would be the group's reminder.
  const settles = !isReminder && !inGroup && settlesOn;
  const mailOffered = mailReminderOffered(inGroup ? target.list : list, settles);

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
      // Not offered: the task's alarm mail stays as it is (settling on an answer takes it off).
      mailReminder: mailOffered ? reminderOn && mailOn : undefined,
      ...(isReminder || inGroup ? {} : { settlesOnReply: settles }),
      groupAccountId: inGroup ? target.accountId : null,
      // An existing task's owner only when picked; a new one's always (null: the user).
      person: inGroup && (personPicked || !task) ? (isPerson(person) ? person : null) : undefined,
    });
    setBusy(false);
    if (written) onClose();
  };

  const remove = async () => {
    // Deleting a task cannot be undone, and it may have come from the task list or a phone: asked first.
    // One of a group's list too: colleagues see it.
    const fromGroup = place?.fixed && target;
    if ((isReminder || fromGroup) && !(await confirm({
      title: fromGroup ? t("group.remove_title") : t("reminder.delete_title"),
      message: fromGroup
        ? t("group.remove_confirm", { group: target.name })
        : t("reminder.delete_confirm", { title: task?.title?.trim() || t("upcoming.no_title") }),
      confirmText: isReminder ? t("reminder.delete") : t("remove_button"),
      variant: "destructive",
    }))) return;
    setBusy(true);
    await controls.remove();
    setBusy(false);
    onClose();
  };

  const sender = email?.from?.[0]?.name || email?.from?.[0]?.email;
  // On a group mailbox's mail the follow-up is the user's alone ("only me"): the list says so.
  const kept = inGroup
    ? (person === NOBODY
      ? t("group.kept_nobody", { group: target.name })
      : isPerson(person)
      ? t(isReminder ? "group.kept_reminder_colleague" : "group.kept_colleague", { group: target.name, name: person.name })
      : t(isReminder ? "group.kept_reminder_me" : "group.kept_me", { group: target.name }))
    : isReminder
    ? (list?.name ? t("reminder.kept_in", { list: list.name }) : t("reminder.kept_in_tasks"))
    : controls.onlyMe
      ? (list?.name ? t("kept_only_me", { list: list.name }) : t("kept_only_me_tasks"))
      : (list?.name ? t("kept_in", { list: list.name }) : t("kept_in_tasks"));
  const heading = isReminder
    ? (task ? t("reminder.dialog_title_edit") : t("reminder.dialog_title"))
    : (task ? t("dialog_title_edit") : t("dialog_title"));
  const HeadIcon = isReminder ? Bell : Flag;

  return (
    <>
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
            <HeadIcon className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
            <h2 id={`${id}-title`} className="flex-1 text-base font-semibold text-foreground">
              {heading}
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
            {isReminder ? (
              <div className="space-y-1.5">
                <label htmlFor={`${id}-what`} className="block font-medium text-foreground">{t("reminder.what_label")}</label>
                <Input
                  ref={whatRef}
                  id={`${id}-what`}
                  data-testid="reminder-what"
                  value={action}
                  maxLength={200}
                  placeholder={t("reminder.what_placeholder")}
                  onChange={(e) => setAction(e.target.value)}
                />
              </div>
            ) : (
            <>
            <p className="flex items-center gap-1.5 truncate text-muted-foreground">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {[controls.mailboxName, sender, email?.subject || t("no_subject")].filter(Boolean).join(" · ")}
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
            </>
            )}

            {place && target && (
              <PlaceFields
                id={id}
                groups={place.groups}
                fixed={place.fixed}
                target={target}
                groupId={groupId}
                person={person}
                nobody={place.initialPerson === NOBODY}
                people={people}
                onPerson={pickPerson}
                onGroup={pickGroup}
              />
            )}

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
                      disabled={recurring}
                      onClick={() => pickChoice(c)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
                disabled={recurring}
                aria-describedby={recurring ? `${id}-recurring` : undefined}
                onChange={(e) => setDue(e.target.value)}
                className="w-auto"
              />
              {recurring && (
                <p id={`${id}-recurring`} data-testid="follow-up-recurring" className="text-xs text-muted-foreground">
                  {t("recurring")}
                </p>
              )}
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
              {mailOffered && (
                <label className="flex w-fit items-start gap-2 text-foreground">
                  <input
                    type="checkbox"
                    data-testid="follow-up-reminder-mail"
                    checked={reminderOn && mailOn}
                    disabled={!reminderOn}
                    onChange={(e) => setMailOn(e.target.checked)}
                    aria-describedby={`${id}-reminder-mail-hint`}
                    className="mt-0.5 rounded border-input disabled:cursor-not-allowed"
                  />
                  <span className={cn(!reminderOn && "text-muted-foreground")}>
                    {t("reminder_mail")}{" "}
                    <span id={`${id}-reminder-mail-hint`} className="text-xs text-muted-foreground">{t("reminder_mail_hint")}</span>
                  </span>
                </label>
              )}
              {!isReminder && !inGroup && (
                <label className="flex w-fit items-start gap-2 text-foreground">
                  <input
                    type="checkbox"
                    data-testid="follow-up-settles-on-reply"
                    checked={settlesOn}
                    onChange={(e) => setSettlesOn(e.target.checked)}
                    aria-describedby={`${id}-settles-hint`}
                    className="mt-0.5 rounded border-input"
                  />
                  <span>
                    {t("reply.settles")}{" "}
                    <span id={`${id}-settles-hint`} className="text-xs text-muted-foreground">{t("reply.settles_hint")}</span>
                  </span>
                </label>
              )}
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
                readOnly={htmlNote}
                aria-describedby={htmlNote ? `${id}-note-html` : undefined}
                onChange={(e) => setNote(e.target.value)}
                className={cn(
                  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  htmlNote && "bg-muted/40 text-muted-foreground",
                )}
              />
              {htmlNote && (
                <p id={`${id}-note-html`} data-testid="follow-up-note-html" className="text-xs text-muted-foreground">
                  {t("note_html")}
                </p>
              )}
            </div>

            <p data-testid="follow-up-kept" className="text-xs text-muted-foreground">
              {kept}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            {task && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()} data-testid="follow-up-dialog-remove">
                {isReminder ? t("reminder.delete") : t("remove_button")}
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
            <Button type="submit" disabled={!canSave} data-testid="follow-up-dialog-save">{t("save")}</Button>
          </div>
        </form>
      </div>
    </div>
    <ConfirmDialog {...confirmProps} />
    </>
  );
}

const PILL = "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PILL_ON = "border-orange-500 bg-orange-500/10 text-orange-700 dark:text-orange-300";
const PILL_OFF = "border-border text-muted-foreground hover:bg-muted hover:text-foreground";

/**
 * "For" (me, or one of the people the group's task list is shared with) and
 * "Visible" (only me, or everyone in the group mailbox). A colleague is
 * possible only in the group's list; an existing group task stays there.
 */
function PlaceFields({ id, groups, fixed, target, groupId, person, nobody, people, onPerson, onGroup }: {
  id: string;
  groups: GroupTaskList[];
  fixed: boolean;
  target: GroupTaskList;
  groupId: string | null;
  person: PersonChoice;
  /** The task names no one: "nobody / everyone" is offered as it stands. */
  nobody: boolean;
  people: TaskPerson[];
  onPerson: (person: TaskPerson | null) => void;
  onGroup: (accountId: string | null) => void;
}) {
  const t = useTranslations("follow_up");
  return (
    <>
      <div className="space-y-1.5">
        <span id={`${id}-for`} className="block font-medium text-foreground">{t("group.for_label")}</span>
        <div role="group" aria-labelledby={`${id}-for`} data-testid="follow-up-for" className="flex flex-wrap gap-1.5">
          {nobody && (
            <button
              type="button"
              aria-pressed={person === NOBODY}
              data-testid="follow-up-for-nobody"
              disabled={person !== NOBODY}
              className={cn(PILL, person === NOBODY ? PILL_ON : PILL_OFF)}
            >
              {t("group.nobody")}
            </button>
          )}
          <button
            type="button"
            aria-pressed={person === null}
            data-testid="follow-up-for-me"
            onClick={() => onPerson(null)}
            className={cn(PILL, person === null ? PILL_ON : PILL_OFF)}
          >
            {t("group.me")}
          </button>
          {people.map((p) => {
            const pressed = isPerson(person) && person.email === p.email;
            return (
              <button
                key={p.email}
                type="button"
                aria-pressed={pressed}
                data-testid="follow-up-for-person"
                title={p.email}
                onClick={() => onPerson(p)}
                className={cn(PILL, pressed ? PILL_ON : PILL_OFF)}
              >
                {p.name}
              </button>
            );
          })}
        </div>
        <p data-testid="follow-up-for-hint" className="text-xs text-muted-foreground">
          {people.length === 0 ? t("group.not_shared", { group: target.name }) : t("group.people_hint", { group: target.name })}
        </p>
      </div>

      <div className="space-y-1.5">
        <span id={`${id}-visible`} className="block font-medium text-foreground">{t("group.visible_label")}</span>
        <div role="group" aria-labelledby={`${id}-visible`} data-testid="follow-up-visible" className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={!groupId}
            data-testid="follow-up-visible-me"
            disabled={fixed || isPerson(person)}
            title={isPerson(person) ? t("group.colleague_needs_group") : undefined}
            onClick={() => onGroup(null)}
            className={cn(PILL, !groupId ? PILL_ON : PILL_OFF)}
          >
            {t("group.visible_me")}
          </button>
          {groups.map((g) => {
            const pressed = groupId === g.accountId;
            return (
              <button
                key={g.accountId}
                type="button"
                aria-pressed={pressed}
                data-testid="follow-up-visible-group"
                disabled={fixed && !pressed}
                onClick={() => onGroup(g.accountId)}
                className={cn(PILL, "inline-flex items-center gap-1", pressed ? PILL_ON : PILL_OFF)}
              >
                <Users className="h-3 w-3" aria-hidden="true" />
                {t("group.visible_group", { group: g.name })}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
