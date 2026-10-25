"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useFollowUpMenu, useOrganizationName } from "@/hooks/use-follow-up-menu";
import {
  defaultFollowUpAction,
  ownActionProblem,
  textRef,
  withOrder,
  withOwnAction,
  withRenamedAction,
  withShown,
  withoutAction,
  type FollowUpMenuEntry,
  type OwnActionProblem,
} from "@/lib/follow-up-menu";
import { MAX_EXTRA_FOLLOW_UP_ACTIONS, MAX_FOLLOW_UP_ACTION_LENGTH } from "@/lib/follow-up-actions";
import { SettingsSection, SettingItem, ToggleSwitch, Select } from "./settings-section";
import { RowNameField, RowProblem, RowTools, SortableRow, useRowDrag } from "./sortable-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Settings › Follow-ups: the actions the follow-up dialog offers (the user's
 * own, the operator's, the built-in ones), their order and which of them the
 * menu shows, and what a new follow-up starts with.
 */
export function FollowUpSettings() {
  const t = useTranslations("settings.follow_ups");
  const { menu, entries, ownAllowed, setMenu } = useFollowUpMenu();
  const organization = useOrganizationName();
  const problemText = useProblemText();
  const defaultRef = useSettingsStore((s) => s.followUpDefaultAction);
  const mailReminder = useSettingsStore((s) => s.followUpMailReminder);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const { isSettingLocked, isSettingHidden } = usePolicyStore();
  const chosen = defaultFollowUpAction(entries, defaultRef);

  // Built-in actions off when the page opened wait behind "n more"; one
  // switched off here stays in sight.
  const [folded] = useState(() => new Set(entries.filter((e) => e.group === "builtin" && !e.shown).map((e) => e.ref)));
  const [unfolded, setUnfolded] = useState(false);
  const hidden = (entry: FollowUpMenuEntry) => !unfolded && !entry.shown && folded.has(entry.ref);
  const hiddenCount = entries.filter(hidden).length;

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || entries[from].group !== entries[to].group) return;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setMenu(withOrder(menu, next));
  };
  const rowDrag = useRowDrag(move, (from, to) => entries[from].group === entries[to].group);

  const add = () => {
    if (ownActionProblem(draft, entries, menu)) return;
    setMenu(withOwnAction(menu, draft));
    setDraft("");
  };
  const rename = (from: string, to: string) => {
    if (ownActionProblem(to, entries, menu, from)) return;
    setMenu(withRenamedAction(menu, from, to));
    if (defaultRef === textRef(from)) updateSetting("followUpDefaultAction", textRef(to));
    setEditing(null);
  };

  const draftProblem = draft.trim() ? ownActionProblem(draft, entries, menu) : null;
  const full = menu.own.length >= MAX_EXTRA_FOLLOW_UP_ACTIONS;
  const defaultOptions = entries
    .filter((entry) => entry.shown || entry.ref === chosen.ref)
    .map((entry) => ({ value: entry.ref, label: entry.text }));
  const actionLocked = isSettingLocked("followUpDefaultAction");
  const mailLocked = isSettingLocked("followUpMailReminder");

  return (
    <div className="space-y-8">
      <SettingsSection id="actions" title={t("actions.title")} description={t("actions.description")}>
        <div className="space-y-1.5" data-testid="follow-up-actions">
          {entries.map((entry, index) => hidden(entry) ? null : (
            <SortableRow
              key={entry.ref}
              drag={rowDrag(index)}
              onMoveBy={(delta) => move(index, index + delta)}
              moveLabel={t("actions.move", { action: entry.text })}
              data-testid="follow-up-action-row"
              data-ref={entry.ref}
            >
              {editing === entry.ref ? (
                <RowNameField
                  initial={entry.text}
                  problem={(text) => problemText(ownActionProblem(text, entries, menu, entry.text))}
                  onSave={(text) => rename(entry.text, text)}
                  onCancel={() => setEditing(null)}
                  fieldLabel={t("actions.rename_field", { action: entry.text })}
                  saveLabel={t("actions.save")}
                  cancelLabel={t("actions.cancel")}
                  testId="follow-up-action-rename"
                />
              ) : (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    !entry.shown && "text-muted-foreground line-through decoration-muted-foreground/50",
                  )}
                >
                  {entry.text}
                </span>
              )}
              {entry.ref === chosen.ref && editing !== entry.ref && (
                <span className="shrink-0 text-[11px] font-semibold text-primary">{t("actions.default_mark")}</span>
              )}
              {entry.group === "own" && editing !== entry.ref && (
                <>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-accent text-accent-foreground">{t("actions.own")}</span>
                  <RowTools
                    onEdit={() => setEditing(entry.ref)}
                    onDelete={() => setMenu(withoutAction(menu, entry.text))}
                    editLabel={t("actions.rename", { action: entry.text })}
                    deleteLabel={t("actions.delete", { action: entry.text })}
                  />
                </>
              )}
              {entry.group === "company" && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] bg-muted text-muted-foreground"
                  title={t("actions.company_title")}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  <span className="hidden max-w-32 truncate sm:inline">{organization}</span>
                </span>
              )}
              <ToggleSwitch
                checked={entry.shown}
                onChange={(shown) => setMenu(withShown(menu, entry.ref, shown))}
                ariaLabel={t("actions.in_menu", { action: entry.text })}
                testId="follow-up-action-shown"
              />
            </SortableRow>
          ))}
        </div>
        {hiddenCount > 0 && (
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setUnfolded(true)} data-testid="follow-up-actions-unfold">
            {t("actions.show_off", { count: hiddenCount })}
          </Button>
        )}
        {ownAllowed && (
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => { e.preventDefault(); add(); }}
          >
            <div className="min-w-0 flex-1 basis-48">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("actions.new_placeholder")}
                aria-label={t("actions.new_field")}
                aria-invalid={draftProblem ? true : undefined}
                disabled={full}
                data-testid="follow-up-action-new"
                className="h-9"
              />
              {problemText(full ? "full" : draftProblem) && (
              <RowProblem testId="follow-up-action-problem">{problemText(full ? "full" : draftProblem)}</RowProblem>
            )}
            </div>
            <Button type="submit" variant="outline" className="h-9" disabled={full || !draft.trim() || !!draftProblem} data-testid="follow-up-action-add">
              {t("actions.add")}
            </Button>
          </form>
        )}
      </SettingsSection>

      <SettingsSection id="defaults" title={t("defaults.title")} description={t("defaults.description")}>
        {!isSettingHidden("followUpDefaultAction") && (
          <SettingItem label={t("defaults.action.label")} description={t("defaults.action.description")} locked={actionLocked}>
            <Select
              value={chosen.ref}
              onChange={(ref) => updateSetting("followUpDefaultAction", ref)}
              options={defaultOptions}
              disabled={actionLocked}
            />
          </SettingItem>
        )}
        {!isSettingHidden("followUpMailReminder") && (
          <SettingItem label={t("defaults.mail.label")} description={t("defaults.mail.description")} locked={mailLocked}>
            <ToggleSwitch
              checked={mailReminder}
              onChange={(on) => updateSetting("followUpMailReminder", on)}
              disabled={mailLocked}
            />
          </SettingItem>
        )}
      </SettingsSection>
    </div>
  );
}

/** Why a name cannot be taken, in words; "" for nothing typed. */
function useProblemText() {
  const t = useTranslations("settings.follow_ups.problems");
  return (problem: OwnActionProblem | null): string | null => {
    if (!problem) return null;
    if (problem === "empty") return "";
    if (problem === "exists") return t("exists");
    return problem === "too_long" ? t("too_long", { max: MAX_FOLLOW_UP_ACTION_LENGTH }) : t("full", { max: MAX_EXTRA_FOLLOW_UP_ACTIONS });
  };
}
