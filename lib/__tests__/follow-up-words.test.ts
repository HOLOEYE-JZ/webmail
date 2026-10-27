import { describe, expect, it } from 'vitest';
import de from '@/locales/de/common.json';
import en from '@/locales/en/common.json';

/** Every string below `node`, flattened. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts);
  return [];
}

describe('the follow-ups\' words', () => {
  it('say "Nachverfolgung" in German, never "Wiedervorlage" (Outlook\'s word)', () => {
    const all = [...texts(de.follow_up), ...texts(de.settings.follow_ups), de.settings.tabs.follow_ups, de.calendar.tasks.scope_follow_ups];
    expect(all.filter((text) => /wiedervorlage/i.test(text))).toEqual([]);
    expect(de.follow_up.menu_title).toBe('Zur Nachverfolgung');
    expect(de.follow_up.dialog_title).toBe('Nachverfolgung');
    expect(de.follow_up.remove).toBe('Nachverfolgung entfernen');
  });

  it('give no example in the placeholders', () => {
    expect(de.follow_up.upcoming.quick_placeholder).toBe('＋ Erinnerung');
    expect(en.follow_up.upcoming.quick_placeholder).toBe('＋ Reminder');
    for (const text of [
      de.follow_up.reminder.what_placeholder,
      de.settings.follow_ups.actions.new_placeholder,
      en.follow_up.reminder.what_placeholder,
      en.settings.follow_ups.actions.new_placeholder,
    ]) {
      expect(text).not.toMatch(/z\. ?B\.|e\.g\./);
    }
  });
});
