import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FollowUpPolicySection } from '../_pages/follow-up-policy';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { builtInRef, textRef } from '@/lib/follow-up-menu';

let current: SettingsPolicy;

function Harness({ start }: { start: Partial<SettingsPolicy> }) {
  const [policy, setPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY, ...start });
  current = policy;
  return <FollowUpPolicySection policy={policy} update={(change) => setPolicy(change)} />;
}

const rows = () => screen.getAllByTestId('follow-up-company-action');
const names = () => rows().map((row) => row.querySelector('span')?.textContent);
const row = (text: string) => rows().find((r) => r.querySelector('span')?.textContent === text)!;

function add(text: string) {
  fireEvent.change(screen.getByTestId('follow-up-company-new'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('follow-up-company-add'));
}

beforeEach(() => {
  current = DEFAULT_POLICY;
});

describe('FollowUpPolicySection: the company actions', () => {
  it('adds one, refusing one the list or the built-in ones have', () => {
    render(<Harness start={{ followUpActions: ['Write a quote'] }} />);
    add('  Create   an ERP document ');
    expect(current.followUpActions).toEqual(['Write a quote', 'Create an ERP document']);
    fireEvent.change(screen.getByTestId('follow-up-company-new'), { target: { value: 'WRITE a quote' } });
    expect(screen.getByTestId('follow-up-company-problem')).toHaveTextContent('exists already');
    fireEvent.change(screen.getByTestId('follow-up-company-new'), { target: { value: 'Anrufen' } });
    expect(screen.getByTestId('follow-up-company-add')).toBeDisabled();
  });

  it('renames one, the default following it, and deletes one, the default falling back on "Follow up"', () => {
    render(<Harness start={{ followUpActions: ['Write a quote', 'Call back'], defaults: { followUpDefaultAction: textRef('Write a quote') } }} />);
    fireEvent.click(within(row('Write a quote')).getByRole('button', { name: /^Rename/ }));
    const field = screen.getByTestId('follow-up-company-rename');
    fireEvent.change(field, { target: { value: 'Send a quote' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(current.followUpActions).toEqual(['Send a quote', 'Call back']);
    expect(current.defaults.followUpDefaultAction).toBe(textRef('Send a quote'));

    fireEvent.click(within(row('Send a quote')).getByRole('button', { name: /^Delete/ }));
    expect(current.followUpActions).toEqual(['Call back']);
    expect(current.defaults.followUpDefaultAction).toBe(builtInRef('follow_up'));
  });

  it('reorders them', () => {
    render(<Harness start={{ followUpActions: ['A', 'B', 'C'] }} />);
    fireEvent.keyDown(within(row('C')).getByRole('button', { name: /^Move/ }), { key: 'ArrowUp' });
    expect(names()).toEqual(['A', 'C', 'B']);
    fireEvent.dragStart(row('B'));
    fireEvent.dragOver(row('A'));
    fireEvent.drop(row('A'));
    expect(current.followUpActions).toEqual(['B', 'A', 'C']);
  });
});

describe('FollowUpPolicySection: what users start with', () => {
  it('switches the built-in actions users see first', () => {
    render(<Harness start={{}} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Users see "Read" first' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Users see "Review" first' }));
    expect(current.followUpBuiltInActions).not.toContain('read');
    expect(current.followUpBuiltInActions).toHaveLength(8);
    fireEvent.click(screen.getByRole('switch', { name: 'Users see "Read" first' }));
    expect(current.followUpBuiltInActions).toContain('read');
  });

  it('sets the defaults, a lock writing the value it pins', () => {
    render(<Harness start={{ followUpActions: ['Write a quote'] }} />);
    fireEvent.click(screen.getByTestId('follow-up-lock-followUpMailReminder'));
    expect(current.restrictions.followUpMailReminder).toEqual({ locked: true });
    expect(current.defaults.followUpMailReminder).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Also remind by mail' }));
    expect(current.defaults.followUpMailReminder).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Preselected action' }), { target: { value: textRef('Write a quote') } });
    expect(current.defaults.followUpDefaultAction).toBe(textRef('Write a quote'));
    fireEvent.click(screen.getByTestId('follow-up-lock-followUpDefaultAction'));
    expect(current.restrictions.followUpDefaultAction).toEqual({ locked: true });
    fireEvent.click(screen.getByTestId('follow-up-lock-followUpDefaultAction'));
    expect(current.restrictions.followUpDefaultAction).toBeUndefined();
  });

  it('lets users keep own actions unless switched off', () => {
    render(<Harness start={{}} />);
    const own = screen.getByRole('switch', { name: 'Users may add their own actions' });
    expect(own).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(own);
    expect(current.features.customFollowUpActionsEnabled).toBe(false);
  });
});
