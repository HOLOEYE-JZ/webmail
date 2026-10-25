import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRA_FOLLOW_UP_ACTIONS,
  MAX_FOLLOW_UP_ACTION_LENGTH,
  sanitizeFollowUpActions,
} from '../follow-up-actions';

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
