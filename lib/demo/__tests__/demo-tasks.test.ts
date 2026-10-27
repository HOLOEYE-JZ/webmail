import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '../demo-client';
import type { CalendarTask } from '@/lib/jmap/types';

const alert = (when: string) => ({
  '@type': 'Alert' as const,
  trigger: { '@type': 'AbsoluteTrigger' as const, when },
  action: 'display' as const,
  acknowledged: null,
  relatedTo: null,
});

describe('demo client tasks', () => {
  it('applies a patch that names members by path, as the server does', async () => {
    const client = new DemoJMAPClient();
    const calendarId = (await client.getCalendars())[0].id;
    const task = await client.createCalendarTask({
      title: 'Call back',
      calendarIds: { [calendarId]: true },
      alerts: { a: alert('2026-10-20T08:00:00Z'), b: alert('2026-10-21T08:00:00Z') },
    });

    await client.updateCalendarTask(task.id, {
      progress: 'completed',
      'alerts/a/acknowledged': '2026-10-20T09:00:00Z',
      'alerts/b': null,
    } as Partial<CalendarTask>);

    const [stored] = (await client.getCalendarTasks()).filter((t) => t.id === task.id);
    expect(Object.keys(stored).filter((key) => key.includes('/'))).toEqual([]);
    expect(stored.progress).toBe('completed');
    expect(stored.alerts).toEqual({ a: { ...alert('2026-10-20T08:00:00Z'), acknowledged: '2026-10-20T09:00:00Z' } });
  });

  it('keeps what a follow-up writes beside the task fields (its links)', async () => {
    const client = new DemoJMAPClient();
    const calendarId = (await client.getCalendars())[0].id;
    const links = { mail: { '@type': 'Link' as const, href: '/mail/message/e1', cid: null, contentType: null, size: null, rel: 'describedby', display: null, title: 'Hi' } };
    const task = await client.createCalendarTask({ title: 'Follow up: Hi', calendarIds: { [calendarId]: true }, links });
    const [stored] = (await client.getCalendarTasks()).filter((t) => t.id === task.id);
    expect(stored.links).toEqual(links);
  });

  it('lists the tasks as read in full, so a task missing from the list was deleted', async () => {
    const client = new DemoJMAPClient();
    const calendarId = (await client.getCalendars())[0].id;
    await client.createCalendarTask({ title: 'One', calendarIds: { [calendarId]: true } });
    const list = await client.getCalendarTaskList([calendarId]);
    expect(list.complete).toBe(true);
    expect(list.tasks.map((t) => t.title)).toContain('One');
    expect(await client.getCalendarTaskList(['no-such-calendar'])).toEqual({ tasks: [], complete: true });
  });
});
