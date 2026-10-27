import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// getCalendarTaskList says whether every task was read: follow-ups take a
// task missing from a complete list for deleted, so a list read only in part
// must not pass for complete. The own account failing fails the list, as
// getCalendarTasks does; a shared account failing only makes it incomplete.

function makeSession(withShared = false) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} },
    accounts: {
      'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
      ...(withShared ? { grp: { name: 'Sales', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } } } : {}),
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1', 'urn:ietf:params:jmap:calendars': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

const task = (id: string) => ({ id, '@type': 'Task', title: id, progress: 'needs-action', calendarIds: { cal: true } });

type Answer = 'ok' | 'error' | 'throw';

let client: JMAPClient;
let query: Answer;
let get: Answer[];
let sharedQuery: Answer;

beforeEach(() => {
  query = 'ok';
  get = [];
  sharedQuery = 'ok';
  client = new JMAPClient('https://mail.example.com', 'test', 'pass');
  const c = client as unknown as Record<string, unknown>;
  c.session = makeSession();
  c.accountId = 'acct-1';
  c.apiUrl = 'https://mail.example.com/jmap/api';
  c.accounts = makeSession().accounts;
  // One object per get batch, so a second batch exists.
  vi.spyOn(client as unknown as { getMaxObjectsInGet: () => number }, 'getMaxObjectsInGet').mockReturnValue(1);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    const [[method, args, tag]] = body.methodCalls as [string, Record<string, unknown>, string][];
    let answer: Answer = 'ok';
    let response: [string, Record<string, unknown>, string];
    if (method === 'CalendarEvent/query') {
      answer = args.accountId === 'grp' ? sharedQuery : query;
      response = ['CalendarEvent/query', { ids: ['t1', 't2'] }, tag];
    } else {
      answer = get.shift() ?? 'ok';
      response = ['CalendarEvent/get', { list: (args.ids as string[]).map(task) }, tag];
    }
    if (answer === 'throw') throw new TypeError('network down');
    if (answer === 'error') response = ['error', { type: 'serverFail' }, tag];
    return new Response(JSON.stringify({ methodResponses: [response], sessionState: 's' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JMAPClient.getCalendarTaskList', () => {
  it('is complete when every query and get answered', async () => {
    const list = await client.getCalendarTaskList();
    expect(list.complete).toBe(true);
    expect(list.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('fails when the query of the own account fails', async () => {
    query = 'error';
    await expect(client.getCalendarTaskList()).rejects.toThrow();
    await expect(client.getCalendarTasks()).rejects.toThrow();
  });

  it('fails when a get batch of the own account fails', async () => {
    get = ['ok', 'error'];
    await expect(client.getCalendarTaskList()).rejects.toThrow();
  });

  it('fails when the server cannot be reached', async () => {
    // The client retries a failed request; it keeps failing.
    get = Array(20).fill('throw');
    await expect(client.getCalendarTaskList()).rejects.toThrow();
  });

  it('is not complete when a shared account fails, keeping the own tasks', async () => {
    const c = client as unknown as Record<string, unknown>;
    c.session = makeSession(true);
    c.accounts = makeSession(true).accounts;
    sharedQuery = 'error';
    const list = await client.getCalendarTaskList();
    expect(list.complete).toBe(false);
    expect(list.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
