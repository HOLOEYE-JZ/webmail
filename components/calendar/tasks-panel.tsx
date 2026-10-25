"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Plus } from "@/components/icons";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useTaskStore } from "@/stores/task-store";
import { defaultTaskCalendar } from "@/lib/calendar-tasks";

/**
 * The task list beside the mail: what is still open, a box to tick it off,
 * and a line to add one. The host draws the frame and the header around it
 * (Mountain View's side panel).
 */
export function TasksPanel() {
  const tCal = useTranslations("calendar");
  const client = useAuthStore((s) => s.client);
  const calendars = useCalendarStore((s) => s.calendars);
  const fetchCalendars = useCalendarStore((s) => s.fetchCalendars);
  const tasks = useTaskStore((s) => s.tasks);
  const fetchTasks = useTaskStore((s) => s.fetchTasks);
  const createTask = useTaskStore((s) => s.createTask);
  const toggleTaskComplete = useTaskStore((s) => s.toggleTaskComplete);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!client) return;
    if (calendars.length === 0) void fetchCalendars(client);
    void fetchTasks(client);
  }, [client, calendars.length, fetchCalendars, fetchTasks]);

  const pending = tasks.filter((task) => task.progress !== "completed" && task.progress !== "cancelled");
  const taskCalendar = defaultTaskCalendar(calendars);

  return (
    <>
      {client && taskCalendar && (
        <form
          className="px-4 pb-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const title = draft.trim();
            if (!title) return;
            setDraft("");
            // null: a plugin stopped it; give the user their text back.
            const created = await createTask(client, { "@type": "Task", title, progress: "needs-action", calendarIds: { [taskCalendar.id]: true } });
            if (!created) setDraft(title);
          }}
        >
          <label className="flex items-center gap-3 rounded-full px-1 py-1.5 text-sm text-primary hover:bg-muted/60">
            <Plus className="h-5 w-5 shrink-0" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={tCal("tasks.create")}
              className="min-w-0 flex-1 bg-transparent text-foreground placeholder:text-primary focus:outline-none"
            />
          </label>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pending.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tCal("tasks.no_tasks")}</p>}
        {pending.map((task) => (
          <div key={task.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50" data-mv-panel-task="">
            <button
              type="button"
              onClick={() => client && void toggleTaskComplete(client, task)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-muted-foreground/60 hover:border-primary"
              aria-label={tCal("tasks.mark_complete")}
              title={tCal("tasks.mark_complete")}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{task.title || tCal("tasks.no_title")}</div>
              {task.due && <div className="text-xs text-muted-foreground">{format(new Date(task.due), "PP")}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
