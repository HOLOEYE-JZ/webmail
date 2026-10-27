import type { Mailbox } from '@/lib/jmap/types';

// Which JMAP account a message link's mail lies in, as the login sees it:
// its own, a group mailbox's it reaches, or one it does not reach; and how a
// group mailbox's mail fetched by a link is shown in the folder list.

/**
 * The JMAP account a message link names when it is another than the login's
 * own and the login reaches it (a group mailbox the user is a member of):
 * the mail is opened there. Undefined for the own account, none named, or
 * one the login does not reach.
 */
export function groupMailAccountOf(
  mailAccountId: string | null | undefined,
  client: { getAccountId(): string; hasAccountCapability(capability: string, accountId?: string): boolean },
): string | undefined {
  if (!mailAccountId || mailAccountId === client.getAccountId()) return undefined;
  return client.hasAccountCapability('urn:ietf:params:jmap:mail', mailAccountId) ? mailAccountId : undefined;
}

/**
 * Where a message link's mail is, by the JMAP account it names: the login's
 * own (none named, or its own), a group mailbox's the login reaches, or one
 * it does not reach, whose mail is never looked for in the own account (ids
 * mean nothing across accounts).
 */
export function messageLinkAccount(
  mailAccountId: string | null | undefined,
  client: { getAccountId(): string; hasAccountCapability(capability: string, accountId?: string): boolean },
): { kind: 'own' } | { kind: 'group'; accountId: string } | { kind: 'unreachable' } {
  if (!mailAccountId || mailAccountId === client.getAccountId()) return { kind: 'own' };
  const group = groupMailAccountOf(mailAccountId, client);
  return group ? { kind: 'group', accountId: group } : { kind: 'unreachable' };
}

/**
 * Whether the login reaches a mail account: its own (also none named), or a
 * group mailbox's it is a member of.
 */
export function reachesMailAccount(
  client: { getAccountId(): string; hasAccountCapability(capability: string, accountId?: string): boolean } | null,
  mailAccountId: string | null | undefined,
): boolean {
  return !!client && messageLinkAccount(mailAccountId, client).kind !== 'unreachable';
}

/**
 * A mail fetched in a group mailbox's account, stamped with that account and
 * the login it was reached through, so every action and the follow-up name
 * that account rather than derive it from the folder on screen.
 */
export function stampMailAccount<T extends { sourceAccountId?: string; sourceClientAccountId?: string }>(
  email: T,
  accountId: string,
  loginId: string | null | undefined,
): T {
  return { ...email, sourceAccountId: accountId, ...(loginId ? { sourceClientAccountId: loginId } : {}) };
}

/**
 * A group mailbox's mail fetched by a message link, as the folder list beside
 * it holds it: when a row of the list is that mail (same id, same account by
 * its stamp or its namespaced folders), it carries the row's stamps, so its
 * key (`emailKeyFor`) is the row's and selection anchors find it; else it is
 * stamped with its account and login (`stampMailAccount`).
 */
export function groupMailAsListed<T extends { id: string; mailboxIds?: Record<string, boolean>; sourceAccountId?: string; sourceClientAccountId?: string }>(
  email: T,
  accountId: string,
  loginId: string | null | undefined,
  rows: readonly { id: string; mailboxIds?: Record<string, boolean>; sourceAccountId?: string; sourceClientAccountId?: string }[],
): T {
  const inAccount = (row: (typeof rows)[number]) => {
    if (row.sourceAccountId) return row.sourceAccountId === accountId;
    const ids = Object.keys(row.mailboxIds ?? {});
    return ids.length > 0 && ids.every((id) => id.startsWith(`${accountId}:`));
  };
  const row = rows.find((r) => r.id === email.id && inAccount(r));
  if (!row) return stampMailAccount(email, accountId, loginId);
  return { ...email, sourceAccountId: row.sourceAccountId, sourceClientAccountId: row.sourceClientAccountId };
}

/**
 * The group mailbox's folder a mail of `accountId` lies in, as the folder
 * list holds it (namespaced `accountId:id`, as `getEmail` namespaces the
 * mail's own), so the list can show it there; null when none is listed.
 */
export function groupMailFolder(
  mailboxIds: Record<string, boolean> | null | undefined,
  mailboxes: Mailbox[],
  accountId: string,
): Mailbox | null {
  return mailboxes.find((mb) => mb.isShared && mb.accountId === accountId && !!mailboxIds?.[mb.id]) ?? null;
}
