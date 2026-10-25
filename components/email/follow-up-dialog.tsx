"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { format, startOfDay } from "date-fns";
import { dayOfIso, isoDay } from "@/lib/task-dates";
import { cn } from "@/lib/utils";
import { Bell, Flag, Lock, Mail, Pencil, Plus, Settings, Users, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFollowUpFormat } from "@/components/email/follow-up";
import { HelpTip, PopoverHeading, PopoverOption, PopoverSeparator, PropertyButton, PropertyPopover } from "@/components/email/follow-up-controls";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import {
  useFollowUp,
  useWorkingTime,
} from "@/hooks/use-follow-ups";
import { useFollowUpDialog, type FollowUpDialogFocus, type GroupDialogTarget } from "@/stores/follow-up-dialog-store";
import { useReminder } from "@/hooks/use-upcoming";
import {
  deleteGroupTask,
  useGroupTask,
  useGroupTaskList,
  useMyAddresses,
  useTaskListSharees,
  writeGroupTask,
} from "@/hooks/use-group-follow-ups";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { groupTaskOwner, type GroupTaskList, type TaskPerson } from "@/lib/group-follow-ups";

/** "For" of a group task that names no one: everyone's, until the user names someone. */
const NOBODY = "\u0000nobody";
/** Whom the form's "For" holds: a colleague, null for the user, or `NOBODY`. */
type PersonChoice = TaskPerson | null | typeof NOBODY;
const isPerson = (choice: PersonChoice): choice is TaskPerson => !!choice && choice !== NOBODY;
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useCalendarStore } from "@/stores/calendar-store";
import { followUpCalendars, isRecurringTask } from "@/lib/calendar-tasks";
import { useSettingsStore } from "@/stores/settings-store";
import { useFollowUpMenu, useOrganizationName } from "@/hooks/use-follow-up-menu";
import { useRouter } from "@/i18n/navigation";
import { buildSettingsPath } from "@/lib/deep-links";
import { displayNow, fromDisplayDate, toDisplayDate } from "@/lib/timezone";
import {
  followUpAction,
  followUpActionKey,
  followUpDueDay,
  followUpNote,
  followUpReminder,
  hasFollowUpMailAlert,
  isHtmlNote,
  mailReminderOffered,
  otherFollowUpAlerts,
  type FollowUpDetails,
} from "@/lib/follow-ups";
import { settlesOnReply } from "@/lib/follow-up-replies";
import {
  FOLLOW_UP_CHOICES,
  proposedFollowUpReminder,
  proposedReminder,
  scheduleFollowUp,
  type FollowUpChoice,
  type WorkingTime,
} from "@/lib/follow-up-schedule";
import { normalizeAction } from "@/lib/follow-up-actions";
import {
  defaultFollowUpAction,
  ownActionProblem,
  withOwnAction,
  type FollowUpActionGroup,
} from "@/lib/follow-up-menu";
import type { CalendarTask, Email } from "@/lib/jmap/types";

/** A day as the date input holds it; "" for none. */
const dayInput = (day: Date | null) => (day ? isoDay(day) : "");

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
 * Where a new task can go besides the user's own list, and for whom:
 * "Visible" (only me / everyone in a group mailbox) and
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
  /** What a new one starts with instead of the defaults (the composer's choice, chosen before). */
  start?: FollowUpDetails;
  /** A line under the mail: the composer's, "set on the sent mail once it is sent". */
  hint?: string;
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
      // "Visible: everyone in sales@" turns a new follow-up into one of the group's list.
      save: (details) => (details.groupAccountId && list ? writeGroup(list, null, details) : own.save(details)),
      place: !own.task && list
        ? { groups: [list], fixed: false, initialGroup: null, initialPerson: null, colleague: false }
        : undefined,
    };
  }
  return <FollowUpForm controls={controls} email={email} focus={focus} onClose={onClose} />;
}

/**
 * The composer's "Follow up: Custom …": the follow-up
 * dialog for a mail not sent yet. It writes nothing: Save hands the choices
 * to the composer (`onChoose`), which keeps them with the draft and has them
 * written on the sent copy once the mail has left. `accountId` is the mail
 * account the mail goes out from: from a group mailbox the follow-up is the
 * user's own ("only me") unless "Visible" puts it into the group's list.
 */
export function SendFollowUpDialog({ email, accountId, onlyMe, start, onChoose, onClose }: {
  /** What the dialog names of the mail: its subject and From. */
  email: Pick<Email, "subject" | "from">;
  accountId: string | null;
  /** The mail goes out of a group mailbox (`accountId` is not the user's own). */
  onlyMe: boolean;
  start: FollowUpDetails;
  onChoose: (details: FollowUpDetails) => void;
  onClose: () => void;
}) {
  const t = useTranslations("follow_up");
  const workingTime = useWorkingTime();
  const list = useGroupTaskList(onlyMe ? accountId : null);
  const mailboxName = useEmailStore((s) => (onlyMe
    ? s.mailboxes.find((m) => m.isShared && m.accountId === accountId && m.accountName)?.accountName ?? null
    : null));
  const inGroup = !!list && !!start.groupAccountId && start.groupAccountId === list.accountId;
  const controls: FormControls = {
    available: true,
    onlyMe,
    mailboxName: mailboxName ?? list?.name ?? null,
    task: null,
    workingTime,
    save: async (details) => {
      onChoose(details);
      return true;
    },
    remove: async () => {},
    place: list
      ? { groups: [list], fixed: false, initialGroup: inGroup ? list.accountId : null, initialPerson: inGroup ? start.person ?? null : null, colleague: false }
      : undefined,
    start: inGroup ? start : { ...start, groupAccountId: null, person: undefined },
    hint: t("send.dialog_hint"),
  };
  // Settings would take the user away from the message being written.
  return <FollowUpForm controls={controls} email={email} focus="action" onClose={onClose} listLink={false} />;
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

/** The due select's entry that shows the date input. */
const PICK = "pick";
type DueChoice = FollowUpChoice | typeof PICK;
/** From this many group lists on, "Visible" offers a search field above them. */
const GROUP_SEARCH_FROM = 6;

const SELECT = "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";
const SMALL_INPUT = "h-8 w-auto px-2 py-1";

function FollowUpForm({ controls, email, title: newTitle = "", focus, onClose, listLink = true }: {
  controls: FormControls;
  /** The mail of a follow-up (what the dialog names of it); none for a reminder without one. */
  email?: Pick<Email, "subject" | "from">;
  title?: string;
  focus: FollowUpDialogFocus;
  onClose: () => void;
  /** "Edit list…" under the actions, to Settings › Follow-ups. */
  listLink?: boolean;
}) {
  const t = useTranslations("follow_up");
  const fmt = useFollowUpFormat();
  const id = useId();
  const { task, workingTime } = controls;
  const isReminder = !email;
  // A series' due day belongs to the task list; an HTML note to the client that wrote it.
  const recurring = !!task && isRecurringTask(task);
  const htmlNote = !!task && isHtmlNote(task);
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const calendars = useCalendarStore((s) => s.calendars);
  const { menu, entries, setMenu } = useFollowUpMenu();
  const defaultRef = useSettingsStore((s) => s.followUpDefaultAction);
  const mailDefault = useSettingsStore((s) => s.followUpMailReminder);
  const [busy, setBusy] = useState(false);

  // A built-in action in the current language, whatever language the task was written in.
  const shownAction = (text: string) => {
    const key = followUpActionKey(text);
    return key ? t(`actions.${key}`) : text;
  };

  // Read once when the dialog opens: a push meanwhile must not overwrite what the user typed.
  const [initial] = useState(() => {
    const now = displayNow();
    const start = task ? undefined : controls.start;
    // A reminder is due today unless it says otherwise, a mail's follow-up tomorrow.
    const due = task
      ? followUpDueDay(task)
      : start ? start.due : isReminder ? startOfDay(now) : scheduleFollowUp("tomorrow", now, workingTime).due;
    const stored = task ? followUpReminder(task) : start?.reminderAt ?? null;
    const propose = isReminder ? proposedReminder : proposedFollowUpReminder;
    const reminder = stored
      ? toDisplayDate(stored)
      : focus === "reminder" ? propose(due, now, workingTime) : null;
    const action = isReminder
      ? (task ? task.title ?? "" : newTitle)
      : task ? shownAction(followUpAction(task)) : start ? shownAction(start.action) : defaultFollowUpAction(entries, defaultRef).text;
    // The due select shows the quick choice whose day it is, else the date itself.
    const choice = FOLLOW_UP_CHOICES.find((c) => dayInput(scheduleFollowUp(c, now, workingTime).due) === dayInput(due)) ?? PICK;
    return {
      action,
      due,
      choice: choice as DueChoice,
      reminder,
      note: task ? followUpNote(task) : start?.note ?? "",
      mail: task ? hasFollowUpMailAlert(task) : start?.mailReminder ?? mailDefault,
      settles: task ? settlesOnReply(task) : start?.settlesOnReply ?? false,
      // Alerts the reminder shown leaves out (relative ones, a second one set on a phone): kept as they are.
      otherAlerts: task ? otherFollowUpAlerts(task) : 0,
    };
  });

  // The menu: the actions the user shows, by where they come from. One the
  // user hid still counts as one of the list, not as typed ("Other …").
  const sections = useMemo(() => {
    const shown = entries.filter((entry) => entry.shown);
    return (["own", "company", "builtin"] as const)
      .map((group) => ({ group, entries: shown.filter((entry) => entry.group === group) }))
      .filter((section) => section.entries.length > 0);
  }, [entries]);

  const [action, setAction] = useState(initial.action);
  const [other, setOther] = useState(() => !isReminder && !entries.some((entry) => entry.text === initial.action));
  // "Add to my actions" beside a typed one, when it could be one.
  const canKeep = other && !!action.trim() && !ownActionProblem(action, entries, menu);
  const [due, setDue] = useState(dayInput(initial.due));
  const [dueChoice, setDueChoice] = useState<DueChoice>(initial.choice);
  const [reminderOn, setReminderOn] = useState(!!initial.reminder);
  // Empty without a reminder, so turning one on proposes a time to come.
  const [reminderDay, setReminderDay] = useState(dayInput(initial.reminder));
  const [reminderTime, setReminderTime] = useState(initial.reminder ? format(initial.reminder, "HH:mm") : "");
  const [reminderPast, setReminderPast] = useState(false);
  const [note, setNote] = useState(initial.note);
  // "＋ Note" until there is one.
  const [noteOpen, setNoteOpen] = useState(!!initial.note);
  const [mailOn, setMailOn] = useState(initial.mail);
  const [settlesOn, setSettlesOn] = useState(initial.settles);
  // The property popover that is open, if any.
  const [popover, setPopover] = useState<"action" | "where" | "for" | null>(null);
  const closePopover = useCallback(() => setPopover(null), []);
  const [groupQuery, setGroupQuery] = useState("");

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
    // Another group's people are others; "only me" is the user's own list, for the user.
    if (accountId !== target?.accountId || accountId === null) setPerson(null);
  };
  const inGroup = !!groupId && !!target;

  const actionRef = useRef<HTMLButtonElement>(null);
  const whereRef = useRef<HTMLButtonElement>(null);
  const forRef = useRef<HTMLButtonElement>(null);
  const whatRef = useRef<HTMLInputElement>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);
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
    setDueChoice(choice.choice);
    setDue(dayInput(choice.due));
    if (choice.reminder) {
      setReminderOn(true);
      setReminderDay(dayInput(choice.reminder));
      setReminderTime(format(choice.reminder, "HH:mm"));
    } else {
      setReminderOn(false);
    }
  };

  const pickDue = (value: string) => {
    const choice = choices.find((c) => c.choice === value);
    if (choice) {
      pickChoice(choice);
      return;
    }
    // "Pick a date…": the date input, with the day chosen so far.
    setDueChoice(PICK);
    setTimeout(() => {
      const input = dueDateRef.current;
      input?.focus();
      try {
        input?.showPicker?.();
      } catch {
        // Not offered without a user gesture in some browsers: the field has the focus.
      }
    }, 0);
  };

  const toggleReminder = (on: boolean) => {
    setReminderOn(on);
    setReminderPast(false);
    if (on && (!reminderDay || !reminderTime)) {
      const proposed = (isReminder ? proposedReminder : proposedFollowUpReminder)(dayOfIso(due), displayNow(), workingTime);
      setReminderDay(dayInput(proposed));
      setReminderTime(format(proposed, "HH:mm"));
    }
  };

  const reminder = reminderOn ? dayOfIso(reminderDay, reminderTime) : null;
  const canSave = !busy && (!reminderOn || !!reminder) && (!due || !!dayOfIso(due)) && (!isReminder || !!action.trim());

  // Where it is kept: the task's own list, else where a new one goes.
  const taskCalendarId = task ? Object.keys(task.calendarIds ?? {})[0] : undefined;
  const list = (taskCalendarId && calendars.find((c) => c.id === taskCalendarId)) || followUpCalendars(calendars)[0];
  // "Settles itself when an answer comes", for a mail's
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
      due: dayOfIso(due),
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
  // What happens, in one sentence: where it is kept, who sees it, who is reminded.
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
  const reminderHelp = mailOffered || initial.otherAlerts > 0;

  const groups = place?.groups ?? [];
  const query = groupQuery.trim().toLocaleLowerCase();
  const shownGroups = query ? groups.filter((g) => g.name.toLocaleLowerCase().includes(query)) : groups;
  const whoName = person === NOBODY ? t("group.nobody") : isPerson(person) ? person.name : t("group.me");

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
        className="w-full max-w-lg max-h-full overflow-y-auto rounded-lg border border-border bg-background shadow-xl animate-in zoom-in-95 duration-200"
      >
        <form onSubmit={save}>
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
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

          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-4 text-sm">
            {isReminder ? (
              <div className="col-span-2">
                <label htmlFor={`${id}-what`} className="sr-only">{t("reminder.what_label")}</label>
                <Input
                  ref={whatRef}
                  id={`${id}-what`}
                  data-testid="reminder-what"
                  value={action}
                  maxLength={200}
                  placeholder={t("reminder.what_placeholder")}
                  onChange={(e) => setAction(e.target.value)}
                  className="h-10 text-base"
                />
              </div>
            ) : (
            <>
            <div className="col-span-2 flex min-w-0 items-center gap-2">
              <PropertyButton
                ref={actionRef}
                id={`${id}-action`}
                data-testid="follow-up-action"
                set
                expanded={popover === "action"}
                aria-label={`${t("action_label")}: ${other ? t("action_other") : action}`}
                icon={<Flag className="h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden="true" />}
                onClick={() => setPopover((p) => (p === "action" ? null : "action"))}
                className="shrink-0 max-w-[60%]"
              >
                {other ? t("action_other") : action}
              </PropertyButton>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={email?.subject || undefined}>
                  {[controls.mailboxName, sender, email?.subject || t("no_subject")].filter(Boolean).join(" · ")}
                </span>
              </span>
              {controls.hint && (
                <HelpTip label={t("help")} testId="follow-up-hint">{controls.hint}</HelpTip>
              )}
              <PropertyPopover anchor={actionRef} open={popover === "action"} onClose={closePopover} label={t("action_label")} testId="follow-up-action-list">
                {sections.map((section) => (
                  <ActionSection key={section.group} group={section.group} headed={sections.length > 1}>
                    {section.entries.map((entry) => (
                      <PopoverOption
                        key={entry.ref}
                        selected={!other && entry.text === action}
                        testId="follow-up-action-option"
                        onSelect={() => { setOther(false); setAction(entry.text); setPopover(null); actionRef.current?.focus(); }}
                      >
                        {entry.text}
                      </PopoverOption>
                    ))}
                  </ActionSection>
                ))}
                <PopoverSeparator />
                <PopoverOption
                  selected={other}
                  testId="follow-up-action-other"
                  icon={<Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  onSelect={() => { if (!other) setAction(""); setOther(true); setPopover(null); }}
                >
                  {t("action_other")}
                </PopoverOption>
                {listLink && <EditListOption onClose={onClose} />}
              </PropertyPopover>
            </div>
            {other && (
              <div className="col-span-2 flex min-w-0 items-center gap-2">
                <Input
                  data-testid="follow-up-action-text"
                  aria-label={t("action_text")}
                  placeholder={t("action_text")}
                  value={action}
                  maxLength={200}
                  autoFocus
                  onChange={(e) => setAction(e.target.value)}
                  className="h-9 min-w-0 flex-1"
                />
                {canKeep && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="follow-up-action-keep"
                    className="h-9 shrink-0 gap-1 text-xs"
                    onClick={() => {
                      const kept = normalizeAction(action);
                      setMenu(withOwnAction(menu, kept));
                      setAction(kept);
                      setOther(false);
                      actionRef.current?.focus();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("add_to_mine")}
                  </Button>
                )}
              </div>
            )}
            </>
            )}

            <label htmlFor={`${id}-due`} className="font-medium text-muted-foreground">{t("due_label")}</label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <select
                id={`${id}-due`}
                data-testid="follow-up-due-choice"
                value={dueChoice}
                disabled={recurring}
                onChange={(e) => pickDue(e.target.value)}
                className={cn(SELECT, "min-w-0 max-w-full")}
              >
                {choices.map((c) => (
                  <option key={c.choice} value={c.choice}>
                    {c.due ? t("choice_with_day", { choice: t(`choices.${c.choice}`), day: fmt.day(c.due) }) : t(`choices.${c.choice}`)}
                  </option>
                ))}
                <option value={PICK}>{t("choices.pick")}</option>
              </select>
              {dueChoice === PICK && (
                <Input
                  ref={dueDateRef}
                  type="date"
                  data-testid="follow-up-due"
                  aria-label={t("due_date")}
                  value={due}
                  disabled={recurring}
                  onChange={(e) => setDue(e.target.value)}
                  className={SMALL_INPUT}
                />
              )}
              {recurring && (
                <HelpTip label={t("help")} testId="follow-up-recurring">{t("recurring")}</HelpTip>
              )}
            </div>

            <span id={`${id}-reminder`} className="font-medium text-muted-foreground">{t("reminder_label")}</span>
            <div role="group" aria-labelledby={`${id}-reminder`} className="flex min-w-0 flex-wrap items-center gap-2">
              <label className="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  role="switch"
                  data-testid="follow-up-reminder-on"
                  aria-label={t("reminder_label")}
                  checked={reminderOn}
                  onChange={(e) => toggleReminder(e.target.checked)}
                  className="peer sr-only"
                />
                <span aria-hidden="true" className="absolute inset-0 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background" />
                <span aria-hidden="true" className="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-3.5" />
              </label>
              <Input
                type="date"
                data-testid="follow-up-reminder-day"
                aria-label={t("reminder_day")}
                value={reminderDay}
                disabled={!reminderOn}
                aria-invalid={reminderPast || undefined}
                onChange={(e) => { setReminderDay(e.target.value); setReminderPast(false); }}
                className={SMALL_INPUT}
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
                className={SMALL_INPUT}
              />
              {mailOffered && (
                <label title={t("reminder_mail")} className={cn("relative inline-flex shrink-0", reminderOn ? "cursor-pointer" : "cursor-not-allowed")}>
                  <input
                    type="checkbox"
                    data-testid="follow-up-reminder-mail"
                    aria-label={t("reminder_mail")}
                    checked={reminderOn && mailOn}
                    disabled={!reminderOn}
                    onChange={(e) => setMailOn(e.target.checked)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-grid h-8 w-8 place-items-center rounded-md border border-border bg-muted text-muted-foreground transition-colors",
                      "hover:text-foreground peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50",
                    )}
                  >
                    <Mail className="h-4 w-4" />
                  </span>
                </label>
              )}
              {reminderHelp && (
                <HelpTip label={t("help")}>
                  {mailOffered && <span className="block">{t("reminder_mail_hint")}</span>}
                  {initial.otherAlerts > 0 && (
                    <span data-testid="follow-up-other-reminders" className="block">
                      {t("other_reminders", { count: initial.otherAlerts })}
                    </span>
                  )}
                </HelpTip>
              )}
            </div>
            {reminderPast && (
              <p id={`${id}-reminder-past`} role="alert" data-testid="follow-up-reminder-past" className="col-start-2 -mt-1 text-xs text-destructive">
                {t("reminder_past")}
              </p>
            )}
            {!isReminder && !inGroup && (
              <div className="col-start-2 -mt-1 flex min-w-0 items-center gap-1.5">
                <label className="flex min-w-0 items-center gap-2 text-foreground">
                  <input
                    type="checkbox"
                    data-testid="follow-up-settles-on-reply"
                    checked={settlesOn}
                    onChange={(e) => setSettlesOn(e.target.checked)}
                    className="rounded border-input"
                  />
                  <span>{t("reply.settles")}</span>
                </label>
                <HelpTip label={t("help")}>{t("reply.settles_hint")}</HelpTip>
              </div>
            )}

            {place && target ? (
              <>
                <span id={`${id}-place`} className="self-start pt-1.5 font-medium text-muted-foreground">{t("group.for_label")}</span>
                <div role="group" aria-labelledby={`${id}-place`} className="grid min-w-0 gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <PropertyButton
                      ref={whereRef}
                      data-testid="follow-up-visible"
                      set={inGroup}
                      expanded={popover === "where"}
                      disabled={place.fixed}
                      aria-label={`${t("group.visible_label")}: ${inGroup ? target.name : t("group.only_for_me")}`}
                      icon={inGroup
                        ? <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        : <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                      onClick={() => setPopover((p) => (p === "where" ? null : "where"))}
                    >
                      {inGroup ? target.name : t("group.only_for_me")}
                    </PropertyButton>
                    {inGroup && (
                      <PropertyButton
                        ref={forRef}
                        data-testid="follow-up-for"
                        expanded={popover === "for"}
                        aria-label={`${t("group.for_label")}: ${whoName}`}
                        icon={<Bell className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        onClick={() => setPopover((p) => (p === "for" ? null : "for"))}
                      >
                        {t("group.to", { name: whoName })}
                      </PropertyButton>
                    )}
                  </div>
                  <p data-testid="follow-up-kept" className="text-xs leading-snug text-muted-foreground">{kept}</p>
                </div>
                <PropertyPopover
                  anchor={whereRef}
                  open={popover === "where"}
                  onClose={closePopover}
                  label={t("group.visible_label")}
                  testId="follow-up-visible-list"
                  header={groups.length >= GROUP_SEARCH_FROM && (
                    <Input
                      type="search"
                      data-testid="follow-up-visible-search"
                      aria-label={t("group.search")}
                      placeholder={t("group.search")}
                      value={groupQuery}
                      onChange={(e) => setGroupQuery(e.target.value)}
                      className="mb-1 h-8"
                    />
                  )}
                >
                  <PopoverOption
                    selected={!groupId}
                    testId="follow-up-visible-me"
                    icon={<Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    onSelect={() => { pickGroup(null); setPopover(null); whereRef.current?.focus(); }}
                  >
                    {t("group.only_for_me")}
                  </PopoverOption>
                  <PopoverSeparator />
                  <PopoverHeading>{t("group.team_heading")}</PopoverHeading>
                  {shownGroups.map((g) => (
                    <PopoverOption
                      key={g.accountId}
                      selected={groupId === g.accountId}
                      testId="follow-up-visible-group"
                      icon={<Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      onSelect={() => { pickGroup(g.accountId); setPopover(null); whereRef.current?.focus(); }}
                    >
                      {g.name}
                    </PopoverOption>
                  ))}
                  {shownGroups.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("group.no_match")}</p>
                  )}
                </PropertyPopover>
                <PropertyPopover anchor={forRef} open={popover === "for" && inGroup} onClose={closePopover} label={t("group.for_label")} testId="follow-up-for-list">
                  <PopoverOption
                    selected={person === null}
                    testId="follow-up-for-me"
                    onSelect={() => { pickPerson(null); setPopover(null); forRef.current?.focus(); }}
                  >
                    {t("group.me")}
                  </PopoverOption>
                  {place.initialPerson === NOBODY && (
                    // Only as the task stands: nobody is never written from here.
                    <PopoverOption selected={person === NOBODY} disabled={person !== NOBODY} testId="follow-up-for-nobody">
                      {t("group.nobody")}
                    </PopoverOption>
                  )}
                  <PopoverSeparator />
                  {people.length > 0 ? (
                    <>
                      <PopoverHeading>{t("group.people_hint", { group: target.name })}</PopoverHeading>
                      {people.map((p) => (
                        <PopoverOption
                          key={p.email}
                          selected={isPerson(person) && person.email === p.email}
                          title={p.email}
                          testId="follow-up-for-person"
                          onSelect={() => { pickPerson(p); setPopover(null); forRef.current?.focus(); }}
                        >
                          {p.name}
                        </PopoverOption>
                      ))}
                    </>
                  ) : (
                    <PopoverOption
                      selected={false}
                      disabled
                      title={t("group.not_shared", { group: target.name })}
                      testId="follow-up-for-hint"
                    >
                      {t("group.colleague")}
                    </PopoverOption>
                  )}
                </PropertyPopover>
              </>
            ) : (
              <p data-testid="follow-up-kept" className="col-span-2 text-xs leading-snug text-muted-foreground">{kept}</p>
            )}

            <div className="col-span-2">
              {noteOpen ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <label htmlFor={`${id}-note`} className="font-medium text-muted-foreground">{t("note_label")}</label>
                    {htmlNote && <HelpTip label={t("help")} testId="follow-up-note-html">{t("note_html")}</HelpTip>}
                  </div>
                  <textarea
                    id={`${id}-note`}
                    data-testid="follow-up-note"
                    rows={2}
                    value={note}
                    placeholder={t("note_placeholder")}
                    readOnly={htmlNote}
                    autoFocus={!initial.note}
                    onChange={(e) => setNote(e.target.value)}
                    className={cn(
                      "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      htmlNote && "bg-muted/40 text-muted-foreground",
                    )}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="follow-up-note-add"
                  onClick={() => setNoteOpen(true)}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 -ml-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("note_label")}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
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

/** One part of the action menu, under its heading when there is more than one. */
function ActionSection({ group, headed, children }: { group: FollowUpActionGroup; headed: boolean; children: React.ReactNode }) {
  const t = useTranslations("follow_up");
  const id = useId();
  if (!headed) return <>{children}</>;
  return (
    <div role="group" aria-labelledby={id}>
      <PopoverHeading>
        <span id={id}>{group === "company" ? <OrganizationName /> : t(group === "own" ? "menu_own" : "menu_builtin")}</span>
      </PopoverHeading>
      {children}
    </div>
  );
}

/** Whose the operator's actions are. */
function OrganizationName() {
  return <>{useOrganizationName()}</>;
}

/** "Edit list…": Settings › Follow-ups, the dialog closed. */
function EditListOption({ onClose }: { onClose: () => void }) {
  const t = useTranslations("follow_up");
  const router = useRouter();
  return (
    <PopoverOption
      selected={false}
      testId="follow-up-action-edit-list"
      icon={<Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      onSelect={() => { onClose(); router.push(buildSettingsPath("follow_ups")); }}
    >
      {t("menu_edit")}
    </PopoverOption>
  );
}
