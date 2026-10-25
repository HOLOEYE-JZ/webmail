'use client';

import { useState } from 'react';
import { Lock } from '@/components/icons';
import type { SettingsPolicy } from '@/lib/admin/types';
import {
  FOLLOW_UP_ACTIONS,
  MAX_EXTRA_FOLLOW_UP_ACTIONS,
  MAX_FOLLOW_UP_ACTION_LENGTH,
  normalizeAction,
  sanitizeBuiltInFollowUpActions,
  type FollowUpActionKey,
} from '@/lib/follow-up-actions';
import { DEFAULT_FOLLOW_UP_ACTION, builtInRef, namesBuiltInAction, textRef } from '@/lib/follow-up-menu';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from '@/components/settings/settings-section';
import { RowNameField, RowProblem, RowTools, SortableRow, useRowDrag } from '@/components/settings/sortable-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** The built-in actions as English users read them (the admin pages are in English). */
const BUILT_IN_NAMES: Record<FollowUpActionKey, string> = {
  follow_up: 'Follow up',
  reply: 'Reply',
  reply_all: 'Reply to All',
  call: 'Call',
  forward: 'Forward',
  read: 'Read',
  review: 'Review',
  for_your_information: 'For Your Information',
  no_response_necessary: 'No Response Necessary',
  do_not_forward: 'Do not Forward',
};

/** The users' settings whose default and lock this section sets (stores/settings-store.ts). */
const DEFAULT_ACTION = 'followUpDefaultAction';
const MAIL_REMINDER = 'followUpMailReminder';

const subLabelClass = 'mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground';

type Update = (change: (prev: SettingsPolicy) => SettingsPolicy) => void;

/** Why an action cannot be one of the company's: null takes it, "" is nothing typed. */
function actionProblem(text: string, others: readonly string[]): string | null {
  const action = normalizeAction(text);
  if (!action) return '';
  if (action.length > MAX_FOLLOW_UP_ACTION_LENGTH) return `At most ${MAX_FOLLOW_UP_ACTION_LENGTH} characters.`;
  const key = action.toLocaleLowerCase();
  if (namesBuiltInAction(action) || others.some((other) => normalizeAction(other).toLocaleLowerCase() === key)) {
    return 'This action exists already.';
  }
  return null;
}

/**
 * The follow-up policy: the company's actions every user gets, the built-in
 * ones users see before they change their list, what a new follow-up starts
 * with (a default each, locked or not), and whether users may add their own.
 */
export function FollowUpPolicySection({ policy, update }: { policy: SettingsPolicy; update: Update }) {
  const company = policy.followUpActions ?? [];
  const builtIn = sanitizeBuiltInFollowUpActions(policy.followUpBuiltInActions);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<number | null>(null);

  const setCompany = (change: (actions: string[]) => string[], from?: string, to?: string) => update((prev) => {
    const actions = change(prev.followUpActions ?? []);
    const defaults = { ...prev.defaults };
    // The default follows its action's rename, and falls back to "Follow up" when it goes.
    if (from !== undefined && defaults[DEFAULT_ACTION] === textRef(from)) {
      defaults[DEFAULT_ACTION] = to === undefined ? DEFAULT_FOLLOW_UP_ACTION : textRef(to);
    }
    return { ...prev, followUpActions: actions, defaults };
  });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= company.length) return;
    setCompany((actions) => {
      const next = [...actions];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const rowDrag = useRowDrag(move);
  const full = company.length >= MAX_EXTRA_FOLLOW_UP_ACTIONS;
  const draftProblem = full ? `At most ${MAX_EXTRA_FOLLOW_UP_ACTIONS} actions.` : draft.trim() ? actionProblem(draft, company) : null;
  const add = () => {
    if (full || actionProblem(draft, company) !== null) return;
    setCompany((actions) => [...actions, normalizeAction(draft)]);
    setDraft('');
  };

  const toggleBuiltIn = (key: FollowUpActionKey) => update((prev) => {
    const shown = sanitizeBuiltInFollowUpActions(prev.followUpBuiltInActions);
    return {
      ...prev,
      followUpBuiltInActions: shown.includes(key) ? shown.filter((k) => k !== key) : FOLLOW_UP_ACTIONS.filter((k) => k === key || shown.includes(k)),
    };
  });

  const defaultAction = typeof policy.defaults[DEFAULT_ACTION] === 'string' ? policy.defaults[DEFAULT_ACTION] as string : DEFAULT_FOLLOW_UP_ACTION;
  const mailReminder = policy.defaults[MAIL_REMINDER] === true;
  const actionOptions = [
    ...company.map((action) => ({ value: textRef(action), label: action })),
    ...FOLLOW_UP_ACTIONS.map((key) => ({ value: builtInRef(key), label: BUILT_IN_NAMES[key] })),
  ];
  const shownDefault = actionOptions.some((option) => option.value === defaultAction) ? defaultAction : DEFAULT_FOLLOW_UP_ACTION;
  const setDefault = (key: string, value: unknown) => update((prev) => ({ ...prev, defaults: { ...prev.defaults, [key]: value } }));
  // A lock pins the default shown, so it is written with it.
  const toggleLock = (key: string, value: unknown) => update((prev) => {
    const restrictions = { ...prev.restrictions };
    if (restrictions[key]?.locked) {
      delete restrictions[key];
      return { ...prev, restrictions };
    }
    restrictions[key] = { ...restrictions[key], locked: true };
    return { ...prev, restrictions, defaults: { ...prev.defaults, [key]: value } };
  });
  const lockBox = (key: string, value: unknown) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={!!policy.restrictions[key]?.locked}
        onChange={() => toggleLock(key, value)}
        className="rounded border-input"
        data-testid={`follow-up-lock-${key}`}
      />
      <Lock className="h-3 w-3" /> Lock
    </label>
  );

  return (
    <SettingsSection
      id="follow-ups"
      title="Follow-ups"
      description="Applies to every user (Settings > Follow-ups). What you lock, users cannot change."
    >
      <div>
        <p className={subLabelClass}>Company actions</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Offered to every user beside the built-in ones (Follow up, Reply, Call and so on), e.g. a step in your own systems. Users can switch them off, not change them.
        </p>
      </div>
      <div className="space-y-1.5" data-testid="follow-up-company-actions">
        {company.map((action, index) => (
          <SortableRow
            key={`${index}:${action}`}
            drag={rowDrag(index)}
            onMoveBy={(delta) => move(index, index + delta)}
            moveLabel={`Move "${action}" (arrow keys)`}
            data-testid="follow-up-company-action"
          >
            {editing === index ? (
              <RowNameField
                initial={action}
                problem={(text) => actionProblem(text, company.filter((_, i) => i !== index))}
                onSave={(text) => {
                  const renamed = normalizeAction(text);
                  setCompany((actions) => actions.map((a, i) => (i === index ? renamed : a)), action, renamed);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                fieldLabel={`New name for "${action}"`}
                saveLabel="Save"
                cancelLabel="Cancel"
                testId="follow-up-company-rename"
              />
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-sm">{action}</span>
                <RowTools
                  onEdit={() => setEditing(index)}
                  onDelete={() => setCompany((actions) => actions.filter((_, i) => i !== index), action)}
                  editLabel={`Rename "${action}"`}
                  deleteLabel={`Delete "${action}"`}
                />
              </>
            )}
          </SortableRow>
        ))}
        {company.length === 0 && (
          <p className="py-1 text-xs text-muted-foreground">No company actions. Users see the built-in ones and their own.</p>
        )}
      </div>
      <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="min-w-0 flex-1 basis-48">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="New action for everyone"
            aria-label="New action for everyone"
            disabled={full}
            data-testid="follow-up-company-new"
            className="h-9"
          />
          {draftProblem && <RowProblem testId="follow-up-company-problem">{draftProblem}</RowProblem>}
        </div>
        <Button type="submit" variant="outline" className="h-9" disabled={full || !draft.trim() || draftProblem !== null} data-testid="follow-up-company-add">
          Add
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        At most {MAX_EXTRA_FOLLOW_UP_ACTIONS}, each up to {MAX_FOLLOW_UP_ACTION_LENGTH} characters. Not translated: write them in your users&apos; language.
      </p>

      <p className={subLabelClass}>Built-in actions users see first</p>
      <div className="grid gap-1.5 sm:grid-cols-2" data-testid="follow-up-builtin-actions">
        {FOLLOW_UP_ACTIONS.map((key) => (
          <div key={key} className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
            <span className={builtIn.includes(key) ? 'min-w-0 flex-1 truncate text-sm' : 'min-w-0 flex-1 truncate text-sm text-muted-foreground line-through decoration-muted-foreground/50'}>
              {BUILT_IN_NAMES[key]}
            </span>
            <ToggleSwitch checked={builtIn.includes(key)} onChange={() => toggleBuiltIn(key)} ariaLabel={`Users see "${BUILT_IN_NAMES[key]}" first`} />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Until a user switches them in their own list; each user can switch any of them back on.</p>

      <p className={subLabelClass}>Defaults</p>
      <div>
        <SettingItem label="Preselected action" description="The action a new follow-up starts with, for users who have not chosen one. Locked, for everyone.">
          <div className="flex items-center gap-3">
            <Select value={shownDefault} onChange={(value) => setDefault(DEFAULT_ACTION, value)} options={actionOptions} />
            {lockBox(DEFAULT_ACTION, shownDefault)}
          </div>
        </SettingItem>
        <SettingItem label="Also remind by mail" description="Whether a new reminder also comes as a mail to the user's inbox, for users who have not chosen. Locked, for everyone.">
          <div className="flex items-center gap-3">
            <ToggleSwitch checked={mailReminder} onChange={(on) => setDefault(MAIL_REMINDER, on)} />
            {lockBox(MAIL_REMINDER, mailReminder)}
          </div>
        </SettingItem>
        <SettingItem label="Users may add their own actions" description="Off hides the users' own actions, in their settings and in the dialog's menu.">
          <ToggleSwitch
            checked={policy.features.customFollowUpActionsEnabled !== false}
            onChange={(on) => update((prev) => ({ ...prev, features: { ...prev.features, customFollowUpActionsEnabled: on } }))}
          />
        </SettingItem>
      </div>
    </SettingsSection>
  );
}
