import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_ACTIONS } from '../follow-up-actions';
import { FOLLOW_UP_ACTION_NAMES, FOLLOW_UP_NO_SUBJECT } from '../follow-up-action-names';
import { OUTPUT, renderFollowUpActionNames } from '../../scripts/follow-up-actions/generate.mjs';

// The texts a follow-up is read back by in any language must be the locales'.
const LOCALES = join(__dirname, '../../locales');
const followUp = readdirSync(LOCALES).map((locale) => (
  JSON.parse(readFileSync(join(LOCALES, locale, 'common.json'), 'utf8')).follow_up as {
    actions: Record<string, string>;
    no_subject: string;
  }
));

describe('FOLLOW_UP_ACTION_NAMES', () => {
  it('is the file the generator writes from the locales (node scripts/follow-up-actions/generate.mjs)', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(renderFollowUpActionNames());
  });

  it('holds every locale\'s text of every built-in action, and no other', () => {
    for (const key of FOLLOW_UP_ACTIONS) {
      expect(new Set(FOLLOW_UP_ACTION_NAMES[key])).toEqual(new Set(followUp.map((f) => f.actions[key])));
    }
  });

  it('holds every locale\'s subject of a mail without one', () => {
    expect(new Set(FOLLOW_UP_NO_SUBJECT)).toEqual(new Set(followUp.map((f) => f.no_subject)));
  });

  it('names no text for two actions', () => {
    const owner = new Map<string, string>();
    for (const key of FOLLOW_UP_ACTIONS) {
      for (const name of FOLLOW_UP_ACTION_NAMES[key]) {
        const text = name.toLocaleLowerCase();
        expect(owner.get(text) ?? key, `"${name}"`).toBe(key);
        owner.set(text, key);
      }
    }
  });
});
