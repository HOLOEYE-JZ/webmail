import { describe, it, expect } from 'vitest';
import { emailKeyFor } from '@/lib/thread-utils';
import {
  groupMailAccountOf,
  groupMailFolder,
  messageLinkAccount,
  reachesMailAccount,
  groupMailAsListed,
  stampMailAccount,
} from '@/lib/group-mail-links';
import type { Mailbox } from '@/lib/jmap/types';

describe('groupMailAccountOf', () => {
  const client = {
    getAccountId: () => 'me',
    hasAccountCapability: (capability: string, accountId?: string) =>
      capability === 'urn:ietf:params:jmap:mail' && (accountId === 'me' || accountId === 'group'),
  };

  it('names a group mailbox\'s account the login reaches', () => {
    expect(groupMailAccountOf('group', client)).toBe('group');
  });

  it('is undefined for the own account, none named, or an account the login does not reach', () => {
    expect(groupMailAccountOf('me', client)).toBeUndefined();
    expect(groupMailAccountOf(undefined, client)).toBeUndefined();
    expect(groupMailAccountOf('', client)).toBeUndefined();
    expect(groupMailAccountOf('elsewhere', client)).toBeUndefined();
  });
});

describe('groupMailFolder', () => {
  const mailboxes = [
    { id: 'inbox', originalId: 'inbox', name: 'Inbox' },
    { id: 'grp:inbox', originalId: 'inbox', name: 'Inbox', accountId: 'grp', isShared: true },
    { id: 'grp:done', originalId: 'done', name: 'Done', accountId: 'grp', isShared: true },
    { id: 'other:done', originalId: 'done', name: 'Done', accountId: 'other', isShared: true },
  ] as Mailbox[];

  it('is the group\'s folder holding the mail, by its namespaced id', () => {
    expect(groupMailFolder({ 'grp:done': true }, mailboxes, 'grp')?.id).toBe('grp:done');
  });

  it('is null for a folder of another account or none listed', () => {
    expect(groupMailFolder({ 'other:done': true }, mailboxes, 'grp')).toBeNull();
    expect(groupMailFolder({ inbox: true }, mailboxes, 'grp')).toBeNull();
    expect(groupMailFolder(undefined, mailboxes, 'grp')).toBeNull();
  });
});

describe('messageLinkAccount', () => {
  const client = {
    getAccountId: () => 'me',
    hasAccountCapability: (capability: string, accountId?: string) =>
      capability === 'urn:ietf:params:jmap:mail' && (accountId === 'me' || accountId === 'grp'),
  };

  it('is the own account for none named or the own one, a group mailbox the login reaches as such', () => {
    expect(messageLinkAccount(undefined, client)).toEqual({ kind: 'own' });
    expect(messageLinkAccount('me', client)).toEqual({ kind: 'own' });
    expect(messageLinkAccount('grp', client)).toEqual({ kind: 'group', accountId: 'grp' });
  });

  it('is unreachable for an account the login does not reach, never the own one', () => {
    expect(messageLinkAccount('elsewhere', client)).toEqual({ kind: 'unreachable' });
  });

  it('tells whether the login reaches the account (reachesMailAccount)', () => {
    expect(reachesMailAccount(client, null)).toBe(true);
    expect(reachesMailAccount(client, 'grp')).toBe(true);
    expect(reachesMailAccount(client, 'elsewhere')).toBe(false);
    expect(reachesMailAccount(null, 'me')).toBe(false);
  });
});

describe('stampMailAccount', () => {
  it('stamps the mail with its account and the login it was reached through', () => {
    expect(stampMailAccount({ id: 'M1' } as { id: string; sourceAccountId?: string }, 'grp', 'login')).toEqual({ id: 'M1', sourceAccountId: 'grp', sourceClientAccountId: 'login' });
    expect(stampMailAccount({ id: 'M1' } as { id: string; sourceAccountId?: string }, 'grp', null)).toEqual({ id: 'M1', sourceAccountId: 'grp' });
  });
});

describe('groupMailAsListed', () => {
  const found = { id: 'M1', mailboxIds: { 'grp:inbox': true } } as { id: string; mailboxIds: Record<string, boolean>; sourceAccountId?: string; sourceClientAccountId?: string };

  it('takes the key of the group folder\'s row: an unstamped row stays unstamped', () => {
    const rows: { id: string; mailboxIds: Record<string, boolean> }[] = [{ id: 'M1', mailboxIds: { inbox: true } }, { id: 'M1', mailboxIds: { 'grp:inbox': true } }];
    const shown = groupMailAsListed(found, 'grp', 'login', rows);
    expect(emailKeyFor(shown)).toBe(emailKeyFor(rows[1]));
    expect(shown.sourceAccountId).toBeUndefined();
  });

  it('takes a stamped row\'s stamps', () => {
    const rows = [{ id: 'M1', sourceAccountId: 'grp', sourceClientAccountId: 'login' }];
    expect(emailKeyFor(groupMailAsListed(found, 'grp', 'login', rows))).toBe('login/grp:M1');
  });

  it('is stamped when no row holds it, never matched to the own mail of the same id', () => {
    const shown = groupMailAsListed(found, 'grp', 'login', [{ id: 'M1', mailboxIds: { inbox: true } }]);
    expect(shown).toMatchObject({ sourceAccountId: 'grp', sourceClientAccountId: 'login' });
  });
});
