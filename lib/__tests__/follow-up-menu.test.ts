import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLLOW_UP_ACTION,
  EMPTY_FOLLOW_UP_MENU,
  builtInRef,
  defaultFollowUpAction,
  followUpMenu,
  ownActionProblem,
  sanitizeFollowUpMenu,
  textRef,
  withOrder,
  withOwnAction,
  withRenamedAction,
  withShown,
  withoutAction,
  type FollowUpMenuSetting,
} from '../follow-up-menu';
import { MAX_EXTRA_FOLLOW_UP_ACTIONS, MAX_FOLLOW_UP_ACTION_LENGTH, type FollowUpActionKey } from '../follow-up-actions';

const NAMES: Partial<Record<FollowUpActionKey, string>> = { follow_up: 'Follow up', reply: 'Reply', call: 'Call', forward: 'Forward' };
const name = (key: FollowUpActionKey) => NAMES[key] ?? key;
const menuOf = (menu: Partial<FollowUpMenuSetting> = {}, company: string[] = []) =>
  followUpMenu({ menu: { ...EMPTY_FOLLOW_UP_MENU, ...menu }, company, name });
const texts = (entries: ReturnType<typeof menuOf>) => entries.map((e) => e.text);

describe('followUpMenu', () => {
  it('lists the own actions, the operator\'s and the built-in ones, every built-in one shown', () => {
    const entries = menuOf({ own: ['Send samples'] }, ['Write a quote']);
    expect(entries.slice(0, 4).map((e) => [e.group, e.text, e.shown])).toEqual([
      ['own', 'Send samples', true],
      ['company', 'Write a quote', true],
      ['builtin', 'Follow up', true],
      ['builtin', 'Reply', true],
    ]);
    expect(entries.filter((e) => e.group === 'builtin')).toHaveLength(10);
  });

  it('keeps the user\'s order within each group, the rest after it', () => {
    const entries = menuOf({ own: ['A', 'B'], order: [builtInRef('call'), textRef('B'), builtInRef('reply')] });
    expect(texts(entries).slice(0, 5)).toEqual(['B', 'A', 'Call', 'Reply', 'Follow up']);
  });

  it('leaves out an operator\'s or own action named as a built-in one in any language, and own ones the operator has', () => {
    const entries = menuOf({ own: ['write a QUOTE', 'Anrufen', 'Mine'] }, ['Write a quote', 'Nachverfolgen']);
    expect(entries.filter((e) => e.group !== 'builtin').map((e) => [e.group, e.text])).toEqual([
      ['own', 'Mine'],
      ['company', 'Write a quote'],
    ]);
  });

  it('shows the built-in ones the operator picks until the user switches them', () => {
    const entries = followUpMenu({
      menu: { ...EMPTY_FOLLOW_UP_MENU, shown: { [builtInRef('forward')]: true, [builtInRef('reply')]: false } },
      company: [],
      name,
      builtInShown: ['follow_up', 'reply'],
    });
    expect(entries.filter((e) => e.shown).map((e) => e.text)).toEqual(['Follow up', 'Forward']);
  });
});

describe('changing the menu', () => {
  it('switches an action off and back on', () => {
    const off = withShown(EMPTY_FOLLOW_UP_MENU, builtInRef('call'), false);
    expect(menuOf(off).find((e) => e.key === 'call')?.shown).toBe(false);
    expect(menuOf(withShown(off, builtInRef('call'), true)).find((e) => e.key === 'call')?.shown).toBe(true);
  });

  it('keeps the order the entries stand in', () => {
    const entries = menuOf();
    const moved = [entries[1], entries[0], ...entries.slice(2)];
    expect(texts(menuOf(withOrder(EMPTY_FOLLOW_UP_MENU, moved))).slice(0, 2)).toEqual(['Reply', 'Follow up']);
  });

  it('adds, renames and deletes an own action, its place and switch going with it', () => {
    let menu = withOwnAction(EMPTY_FOLLOW_UP_MENU, '  Send   samples ');
    menu = withOwnAction(menu, 'Visit');
    menu = withOrder(menu, menuOf(menu));
    menu = withShown(menu, textRef('Send samples'), false);
    menu = withRenamedAction(menu, 'Send samples', 'Send a sample');
    expect(menu.own).toEqual(['Send a sample', 'Visit']);
    expect(menu.shown).toEqual({ [textRef('Send a sample')]: false });
    expect(menu.order).toContain(textRef('Send a sample'));
    expect(menu.order).not.toContain(textRef('Send samples'));
    menu = withoutAction(menu, 'send a SAMPLE');
    expect(menu.own).toEqual(['Visit']);
    expect(menu.shown).toEqual({});
    expect(menu.order).not.toContain(textRef('Send a sample'));
  });
});

describe('ownActionProblem', () => {
  const entries = menuOf({ own: ['Send samples'] }, ['Write a quote']);
  const menu = { ...EMPTY_FOLLOW_UP_MENU, own: ['Send samples'] };

  it('takes a new name', () => {
    expect(ownActionProblem('Visit the customer', entries, menu)).toBeNull();
  });

  it('refuses nothing, too long, and a name the menu has (ignoring case and spaces) or a built-in one in any language', () => {
    expect(ownActionProblem('   ', entries, menu)).toBe('empty');
    expect(ownActionProblem('x'.repeat(MAX_FOLLOW_UP_ACTION_LENGTH + 1), entries, menu)).toBe('too_long');
    expect(ownActionProblem('send  SAMPLES', entries, menu)).toBe('exists');
    expect(ownActionProblem('write a quote', entries, menu)).toBe('exists');
    expect(ownActionProblem('Anrufen', entries, menu)).toBe('exists');
  });

  it('refuses one more than the operator\'s limit', () => {
    const own = Array.from({ length: MAX_EXTRA_FOLLOW_UP_ACTIONS }, (_, i) => `Action ${i}`);
    const full = { ...EMPTY_FOLLOW_UP_MENU, own };
    expect(ownActionProblem('One more', menuOf(full), full)).toBe('full');
  });

  it('lets a rename keep its own name in another case', () => {
    expect(ownActionProblem('SEND samples', entries, menu, 'Send samples')).toBeNull();
    expect(ownActionProblem('Write a quote', entries, menu, 'Send samples')).toBe('exists');
  });
});

describe('defaultFollowUpAction', () => {
  it('is the entry its ref names, else "Follow up"', () => {
    const entries = menuOf({ own: ['Send samples'] });
    expect(defaultFollowUpAction(entries, textRef('Send samples')).text).toBe('Send samples');
    expect(defaultFollowUpAction(entries, textRef('Deleted since')).ref).toBe(DEFAULT_FOLLOW_UP_ACTION);
    expect(defaultFollowUpAction(entries, builtInRef('call')).text).toBe('Call');
  });
});

describe('sanitizeFollowUpMenu', () => {
  it('keeps a well-formed setting', () => {
    const menu = { own: ['Send samples'], order: [builtInRef('call')], shown: { [builtInRef('read')]: false } };
    expect(sanitizeFollowUpMenu(menu)).toEqual(menu);
  });

  it('drops what is malformed', () => {
    expect(sanitizeFollowUpMenu('x')).toEqual(EMPTY_FOLLOW_UP_MENU);
    expect(sanitizeFollowUpMenu({ own: [' a ', 'A', 3], order: ['x', 'x', 4], shown: { y: 'no', z: true } })).toEqual({
      own: ['a'],
      order: ['x'],
      shown: { z: true },
    });
  });
});
