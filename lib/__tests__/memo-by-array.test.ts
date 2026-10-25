import { describe, expect, it, vi } from 'vitest';
import { memoByArray } from '../utils';

describe('memoByArray', () => {
  it('computes once per list object and key', () => {
    const compute = vi.fn((list: number[], key: string) => `${key}:${list.length}`);
    const memo = memoByArray(compute);
    const list = [1, 2];
    expect(memo(list, 'a')).toBe('a:2');
    expect(memo(list, 'a')).toBe('a:2');
    expect(memo(list, 'b')).toBe('b:2');
    expect(memo([1, 2, 3], 'a')).toBe('a:3');
    expect(compute).toHaveBeenCalledTimes(3);
  });
});
