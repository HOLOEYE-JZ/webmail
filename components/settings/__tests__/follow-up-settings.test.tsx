import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpSettings } from '../follow-up-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_FOLLOW_UP_ACTION, EMPTY_FOLLOW_UP_MENU, builtInRef, textRef } from '@/lib/follow-up-menu';
import { MAX_EXTRA_FOLLOW_UP_ACTIONS } from '@/lib/follow-up-actions';

const TEXTS: Record<string, string> = {
  'actions.follow_up': 'Follow up',
  'actions.reply': 'Reply',
  'actions.call': 'Call',
  'actions.forward': 'Forward',
};
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    TEXTS[key] ?? (values ? `${key}${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ loginCompanyName: 'Holoeye' }) }));

const rows = () => screen.getAllByTestId('follow-up-action-row');
const names = () => rows().map((row) => row.querySelector('span')?.textContent);
const row = (text: string) => rows().find((r) => r.querySelector('span')?.textContent === text)!;
const menu = () => useSettingsStore.getState().followUpMenu;

function add(text: string) {
  fireEvent.change(screen.getByTestId('follow-up-action-new'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('follow-up-action-add'));
}

beforeEach(() => {
  useSettingsStore.setState({
    followUpMenu: EMPTY_FOLLOW_UP_MENU,
    followUpDefaultAction: DEFAULT_FOLLOW_UP_ACTION,
    followUpMailReminder: false,
    explicitSettings: [],
  });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: ['Write a quote'] } });
});

describe('FollowUpSettings: the actions', () => {
  it('lists the operator\'s actions with the organisation and the built-in ones, "Follow up" preselected', () => {
    render(<FollowUpSettings />);
    expect(names().slice(0, 3)).toEqual(['Write a quote', 'Follow up', 'Reply']);
    expect(within(row('Write a quote')).getByText('Holoeye')).toBeInTheDocument();
    expect(within(row('Follow up')).getByText('actions.default_mark')).toBeInTheDocument();
    // The operator's can be switched off, not edited.
    expect(within(row('Write a quote')).queryByRole('button', { name: /actions.rename/ })).toBeNull();
  });

  it('adds an own action at the top, refusing one the list has in another case', () => {
    render(<FollowUpSettings />);
    add('Send samples');
    expect(menu().own).toEqual(['Send samples']);
    expect(names()[0]).toBe('Send samples');
    expect(within(row('Send samples')).getByText('actions.own')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('follow-up-action-new'), { target: { value: 'write a QUOTE' } });
    expect(screen.getByTestId('follow-up-action-problem')).toHaveTextContent('exists');
    expect(screen.getByTestId('follow-up-action-add')).toBeDisabled();
    fireEvent.change(screen.getByTestId('follow-up-action-new'), { target: { value: 'Anrufen' } });
    expect(screen.getByTestId('follow-up-action-problem')).toHaveTextContent('exists');
  });

  it('stops at the operator\'s limit', () => {
    useSettingsStore.setState({
      followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, own: Array.from({ length: MAX_EXTRA_FOLLOW_UP_ACTIONS }, (_, i) => `Own ${i}`) },
    });
    render(<FollowUpSettings />);
    expect(screen.getByTestId('follow-up-action-new')).toBeDisabled();
    expect(screen.getByTestId('follow-up-action-problem')).toHaveTextContent('full');
  });

  it('renames an own action in its row, the default following it, and deletes it', () => {
    useSettingsStore.setState({
      followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, own: ['Send samples'] },
      followUpDefaultAction: textRef('Send samples'),
    });
    render(<FollowUpSettings />);
    fireEvent.click(within(row('Send samples')).getByRole('button', { name: /actions.rename/ }));
    const field = screen.getByTestId('follow-up-action-rename');
    fireEvent.change(field, { target: { value: 'Reply' } });
    expect(screen.getByTestId('follow-up-action-rename-problem')).toHaveTextContent('exists');
    fireEvent.change(field, { target: { value: 'Send a sample' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(menu().own).toEqual(['Send a sample']);
    expect(useSettingsStore.getState().followUpDefaultAction).toBe(textRef('Send a sample'));

    fireEvent.click(within(row('Send a sample')).getByRole('button', { name: /actions.delete/ }));
    expect(menu().own).toEqual([]);
    expect(names()).not.toContain('Send a sample');
  });

  it('switches an action out of the menu', () => {
    render(<FollowUpSettings />);
    fireEvent.click(within(row('Reply')).getByTestId('follow-up-action-shown'));
    expect(menu().shown).toEqual({ [builtInRef('reply')]: false });
    // Switched off here, it stays in sight.
    expect(names()).toContain('Reply');
  });

  it('folds the built-in ones that were off when the page opened', () => {
    useSettingsStore.setState({
      followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, shown: { [builtInRef('read')]: false, [builtInRef('review')]: false } },
    });
    render(<FollowUpSettings />);
    expect(names()).not.toContain('actions.read');
    fireEvent.click(screen.getByTestId('follow-up-actions-unfold'));
    expect(names()).toContain('actions.read');
    expect(names()).toContain('actions.review');
  });

  it('reorders by the keyboard and by dragging, within a group only', () => {
    useSettingsStore.setState({ followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, own: ['A', 'B'] } });
    render(<FollowUpSettings />);
    fireEvent.keyDown(within(row('B')).getByRole('button', { name: /actions.move/ }), { key: 'ArrowUp' });
    expect(names().slice(0, 4)).toEqual(['B', 'A', 'Write a quote', 'Follow up']);
    // Out of its group: no move.
    fireEvent.keyDown(within(row('A')).getByRole('button', { name: /actions.move/ }), { key: 'ArrowDown' });
    expect(names().slice(0, 3)).toEqual(['B', 'A', 'Write a quote']);

    fireEvent.dragStart(row('Call'));
    fireEvent.dragOver(row('Follow up'));
    fireEvent.drop(row('Follow up'));
    expect(names().slice(3, 6)).toEqual(['Call', 'Follow up', 'Reply']);
    fireEvent.dragStart(row('Call'));
    fireEvent.drop(row('A'));
    expect(names().slice(0, 4)).toEqual(['B', 'A', 'Write a quote', 'Call']);
  });
});

describe('FollowUpSettings: the operator\'s policy', () => {
  it('shows the built-in actions the operator picks until the user switches them', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, followUpActions: [], followUpBuiltInActions: ['follow_up', 'call'] } });
    render(<FollowUpSettings />);
    // The others wait behind "n more", off.
    expect(names()).toEqual(['Follow up', 'Call']);
    expect(screen.getByTestId('follow-up-actions-unfold')).toBeInTheDocument();
  });

  it('hides the own actions and the field to add one when the operator allows none', () => {
    useSettingsStore.setState({ followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, own: ['Send samples'] } });
    usePolicyStore.setState({
      policy: { ...DEFAULT_POLICY, followUpActions: [], features: { ...DEFAULT_POLICY.features, customFollowUpActionsEnabled: false } },
    });
    render(<FollowUpSettings />);
    expect(names()).not.toContain('Send samples');
    expect(screen.queryByTestId('follow-up-action-new')).toBeNull();
  });
});

describe('FollowUpSettings: the defaults', () => {
  it('offers the actions shown as the preselected one, and the mail', () => {
    useSettingsStore.setState({ followUpMenu: { ...EMPTY_FOLLOW_UP_MENU, shown: { [builtInRef('call')]: false } } });
    render(<FollowUpSettings />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toContain('Write a quote');
    expect(options).not.toContain('Call');
    fireEvent.change(select, { target: { value: textRef('Write a quote') } });
    expect(useSettingsStore.getState().followUpDefaultAction).toBe(textRef('Write a quote'));

    fireEvent.click(screen.getByRole('switch', { name: 'defaults.mail.label' }));
    expect(useSettingsStore.getState().followUpMailReminder).toBe(true);
  });

  it('cannot be changed while the administrator locks them', () => {
    usePolicyStore.setState({
      policy: {
        ...DEFAULT_POLICY,
        followUpActions: ['Write a quote'],
        restrictions: { followUpDefaultAction: { locked: true }, followUpMailReminder: { locked: true } },
      },
    });
    render(<FollowUpSettings />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'defaults.mail.label' })).toBeDisabled();
  });
});
