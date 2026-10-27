"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Plus, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PluginActions } from "@/components/plugins/plugin-actions";
import type { TaskViewFilter } from "@/stores/task-store";
import { TASK_LIST_SCOPES, groupScope, type TaskListScope } from "@/lib/task-list";

/** A group mailbox's task list the scope can name. */
export interface TaskScopeList {
  accountId: string;
  name: string;
}

interface TaskToolbarProps {
  filter: TaskViewFilter;
  showCompleted: boolean;
  onFilterChange: (filter: TaskViewFilter) => void;
  onShowCompletedChange: (show: boolean) => void;
  onCreateTask: () => void;
  /** The tasks the list shows, in order: what plugin buttons here act on. */
  taskIds?: string[];
  /** Icon-only plugin buttons (phones). */
  compact?: boolean;
  /** Which tasks the list shows (lib/task-list.ts); without it, no choice is offered. */
  scope?: TaskListScope;
  onScopeChange?: (scope: TaskListScope) => void;
  /** The group mailboxes' task lists, one choice each. */
  groupLists?: readonly TaskScopeList[];
}

const NO_LISTS: readonly TaskScopeList[] = [];

const SCOPE_KEYS: Record<(typeof TASK_LIST_SCOPES)[number], string> = {
  all: "scope_all",
  mine: "scope_mine",
  "follow-ups": "scope_follow_ups",
  reminders: "scope_reminders",
};

const NO_IDS: string[] = [];

const FILTERS: TaskViewFilter[] = ["all", "pending", "completed", "overdue"];

export function TaskToolbar({
  filter,
  showCompleted,
  onFilterChange,
  onShowCompletedChange,
  onCreateTask,
  taskIds = NO_IDS,
  compact,
  scope,
  onScopeChange,
  groupLists = NO_LISTS,
}: TaskToolbarProps) {
  const t = useTranslations("calendar");
  const pluginContext = useMemo(() => ({ taskIds }), [taskIds]);

  const scopeButton = (value: TaskListScope, label: React.ReactNode, title?: string) => (
    <button
      key={value}
      type="button"
      data-testid={`task-scope-${value}`}
      aria-pressed={value === scope}
      title={title}
      onClick={() => onScopeChange?.(value)}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        value === scope
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted"
      )}
    >
      {label}
    </button>
  );

  return (
    // The scope row wraps the toolbar onto two lines: then it is padded, not one row high.
    <div className={cn("flex items-center gap-2 px-4 border-b border-border flex-wrap", scope && onScopeChange ? "py-2" : "min-h-14 box-content")}>
      {scope && onScopeChange && (
        <div role="group" aria-label={t("tasks.scope_label")} className="flex w-full flex-wrap items-center gap-1.5 pb-1">
          {TASK_LIST_SCOPES.map((value) => scopeButton(value, t(`tasks.${SCOPE_KEYS[value]}`)))}
          {groupLists.map((list) => scopeButton(
            groupScope(list.accountId),
            <>
              <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t("tasks.scope_group", { group: list.name })}
            </>,
            t("tasks.scope_group_title", { group: list.name }),
          ))}
        </div>
      )}
      <div className="flex border border-border rounded-md overflow-hidden">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => onFilterChange(f)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              f === filter
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted text-muted-foreground"
            )}
          >
            {t(`tasks.filter_${f}`)}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none ms-2">
        <input
          type="checkbox"
          checked={showCompleted}
          onChange={(e) => onShowCompletedChange(e.target.checked)}
          className="rounded border-border"
        />
        {t("tasks.show_completed")}
      </label>

      <div className="flex-1" />

      <Button size="sm" onClick={onCreateTask}>
        <Plus className="w-4 h-4 me-1" />
        {t("tasks.create")}
      </Button>

      <PluginActions surface="task-list-actions" context={pluginContext} compact={compact} />
    </div>
  );
}
