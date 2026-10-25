import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_ACTIONS,
  MAX_EXTRA_FOLLOW_UP_ACTIONS,
  MAX_FOLLOW_UP_ACTION_LENGTH,
  normalizeAction,
  sanitizeBuiltInFollowUpActions,
  sanitizeFollowUpActions,
} from '../follow-up-actions';

describe('normalizeAction', () => {
  it('collapses whitespace and falls back on the default for nothing', () => {
    expect(normalizeAction('  Call\t back ')).toBe('Call back');
    expect(normalizeAction('   ', 'Follow up')).toBe('Follow up');
    expect(normalizeAction('')).toBe('');
  });
});

describe('sanitizeFollowUpActions', () => {
  it('keeps the operator\'s actions trimmed, each once, in their order', () => {
    expect(sanitizeFollowUpActions(['  Write a quote ', 'Create  ERP\tdocument', '', 'write a QUOTE', 'Call back'])).toEqual([
      'Write a quote',
      'Create ERP document',
      'Call back',
    ]);
  });

  it('drops what is no list of strings, and entries too long', () => {
    expect(sanitizeFollowUpActions(undefined)).toEqual([]);
    expect(sanitizeFollowUpActions('Write a quote')).toEqual([]);
    expect(sanitizeFollowUpActions([42, null, { label: 'x' }, 'x'.repeat(MAX_FOLLOW_UP_ACTION_LENGTH + 1), 'Ok'])).toEqual(['Ok']);
  });

  it('keeps at most the limit', () => {
    const many = Array.from({ length: MAX_EXTRA_FOLLOW_UP_ACTIONS + 5 }, (_, i) => `Action ${i}`);
    expect(sanitizeFollowUpActions(many)).toHaveLength(MAX_EXTRA_FOLLOW_UP_ACTIONS);
  });
});

describe('sanitizeBuiltInFollowUpActions', () => {
  it('keeps the known keys once, in the built-in order', () => {
    expect(sanitizeBuiltInFollowUpActions(['call', 'x', 'follow_up', 'call', 3])).toEqual(['follow_up', 'call']);
    expect(sanitizeBuiltInFollowUpActions([])).toEqual([]);
  });

  it('shows all of them without a list', () => {
    expect(sanitizeBuiltInFollowUpActions(undefined)).toEqual([...FOLLOW_UP_ACTIONS]);
    expect(sanitizeBuiltInFollowUpActions('call')).toEqual([...FOLLOW_UP_ACTIONS]);
  });
});
