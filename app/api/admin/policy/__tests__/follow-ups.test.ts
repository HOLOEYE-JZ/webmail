/**
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-follow-up-policy-'));
  process.env.ADMIN_CONFIG_DIR = dir;
});
afterAll(async () => {
  delete process.env.ADMIN_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function put(body: Record<string, unknown>) {
  const { PUT } = await import('../route');
  return PUT(new NextRequest('http://localhost/api/admin/policy', {
    method: 'PUT',
    body: JSON.stringify({ restrictions: {}, features: {}, ...body }),
    headers: { 'content-type': 'application/json' },
  }));
}

describe('PUT /api/admin/policy: the follow-up policy', () => {
  it('refuses built-in actions that are no list', async () => {
    const res = await put({ followUpBuiltInActions: 'call' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/followUpBuiltInActions/);
  });

  it('keeps the company actions, the built-in ones, the defaults and their locks as users get them', async () => {
    const res = await put({
      followUpActions: ['  Write a  quote ', 'write a QUOTE', ''],
      followUpBuiltInActions: ['call', 'nonsense', 'follow_up', 'call'],
      defaults: { followUpDefaultAction: 'text:write a quote', followUpMailReminder: true, broken: { x: 1 } },
      restrictions: { followUpMailReminder: { locked: true } },
      features: { customFollowUpActionsEnabled: false },
    });
    expect(res.status).toBe(200);
    const { configManager } = await import('@/lib/admin/config-manager');
    const policy = configManager.getPolicy();
    expect(policy.followUpActions).toEqual(['Write a quote']);
    expect(policy.followUpBuiltInActions).toEqual(['follow_up', 'call']);
    expect(policy.defaults).toEqual({ followUpDefaultAction: 'text:write a quote', followUpMailReminder: true });
    expect(policy.restrictions).toEqual({ followUpMailReminder: { locked: true } });
    expect(policy.features.customFollowUpActionsEnabled).toBe(false);
  });

  it('shows every built-in action when the policy names none', async () => {
    await put({ followUpBuiltInActions: undefined });
    const { configManager } = await import('@/lib/admin/config-manager');
    expect(configManager.getPolicy().followUpBuiltInActions).toHaveLength(10);
    expect(configManager.getPolicy().features.customFollowUpActionsEnabled).toBe(true);
  });
});
