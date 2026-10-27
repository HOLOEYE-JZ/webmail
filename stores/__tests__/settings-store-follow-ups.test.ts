import { beforeEach, describe, expect, it } from 'vitest';
import { adminPolicyPatch, useSettingsStore } from '../settings-store';
import { DEFAULT_FOLLOW_UP_ACTION, EMPTY_FOLLOW_UP_MENU, builtInRef, textRef } from '@/lib/follow-up-menu';

const settings = () => useSettingsStore.getState();

beforeEach(() => {
  useSettingsStore.setState({
    followUpMenu: EMPTY_FOLLOW_UP_MENU,
    followUpDefaultAction: DEFAULT_FOLLOW_UP_ACTION,
    followUpMailReminder: false,
    explicitSettings: [],
  });
});

describe('the follow-up settings', () => {
  it('travel with the synced settings and come back sanitized', () => {
    const menu = { own: ['Send samples'], order: [builtInRef('call')], shown: { [builtInRef('read')]: false } };
    useSettingsStore.setState({ followUpMenu: menu, followUpDefaultAction: textRef('Send samples'), followUpMailReminder: true });
    const blob = JSON.parse(settings().exportSettings({ forSync: true }));
    expect(blob.followUpMenu).toEqual(menu);
    expect(blob.followUpDefaultAction).toBe(textRef('Send samples'));
    expect(blob.followUpMailReminder).toBe(true);

    settings().importSettings(JSON.stringify({ followUpMenu: { own: ['  A ', 'a', 42], order: 'x', shown: { [builtInRef('call')]: 'no' } } }));
    expect(settings().followUpMenu).toEqual({ own: ['A'], order: [], shown: {} });
  });

  it('take the operator\'s defaults until the user chooses, and a locked one whatever they chose', () => {
    const policy = {
      defaults: { followUpDefaultAction: builtInRef('call'), followUpMailReminder: true },
      restrictions: { followUpMailReminder: { locked: true } },
    };
    expect(adminPolicyPatch(settings() as unknown as Record<string, unknown>, policy)).toEqual({
      followUpDefaultAction: builtInRef('call'),
      followUpMailReminder: true,
    });
    const chosen = { ...settings(), followUpDefaultAction: builtInRef('reply'), explicitSettings: ['followUpDefaultAction', 'followUpMailReminder'] };
    expect(adminPolicyPatch(chosen as unknown as Record<string, unknown>, policy)).toEqual({ followUpMailReminder: true });
  });
});
