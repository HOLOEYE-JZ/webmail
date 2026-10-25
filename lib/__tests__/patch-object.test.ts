import { describe, expect, it } from 'vitest';
import { applyPatchObject, patchPath, patchedProperties } from '../jmap/patch-object';

describe('patchedProperties', () => {
  const task = { title: 'Call', alerts: { a: { acknowledged: null, action: 'display' }, 'x/y': { acknowledged: null } } };

  it('gives each property a path changes whole, as it is after the patch', () => {
    const patch = { [`alerts/${patchPath('x/y')}/acknowledged`]: '2026-10-25T08:00:00Z', 'alerts/a': null, title: 'Call back' };
    expect(patchedProperties(task, patch)).toEqual({
      title: 'Call back',
      alerts: { 'x/y': { acknowledged: '2026-10-25T08:00:00Z' } },
    });
    expect(applyPatchObject(task, patch).alerts).toEqual({ 'x/y': { acknowledged: '2026-10-25T08:00:00Z' } });
  });

  it('names a property the patch removes as null', () => {
    expect(patchedProperties(task, { alerts: null })).toEqual({ alerts: null });
  });
});
