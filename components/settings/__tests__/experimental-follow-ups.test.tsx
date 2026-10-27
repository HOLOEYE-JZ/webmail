import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentalSection } from '../layout-settings';
import { useSettingsStore } from '@/stores/settings-store';

// Follow-ups are an experimental switch beside the Pro interface, off by
// default (hooks/use-follow-ups.ts: off, nothing of them shows or is written).

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

beforeEach(() => {
  useSettingsStore.setState({ enableFollowUps: false, proInterface: false });
});

describe('the experimental follow-ups switch', () => {
  it('is off by default', () => {
    expect(useSettingsStore.getInitialState().enableFollowUps).toBe(false);
  });

  it('sits beside the Pro interface and turns follow-ups on and off', () => {
    render(<ExperimentalSection />);
    expect(screen.getByText('follow_ups_experimental.label')).toBeTruthy();
    fireEvent.click(screen.getByTestId('setting-follow-ups'));
    expect(useSettingsStore.getState().enableFollowUps).toBe(true);
    fireEvent.click(screen.getByTestId('setting-follow-ups'));
    expect(useSettingsStore.getState().enableFollowUps).toBe(false);
  });
});
