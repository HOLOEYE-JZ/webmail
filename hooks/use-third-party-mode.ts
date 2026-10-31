"use client";

import { useSyncExternalStore } from 'react';
import { noThirdPartyTraffic, subscribeThirdPartyMode } from '@/lib/third-party-mode';
import { usePolicyStore } from '@/stores/policy-store';

/**
 * Whether the browser must stay off built-in outside hosts (#903), as React
 * state: components re-render when the config arrives. True while the config
 * is still unknown, so nothing reaches out before it says it may.
 */
export function useNoThirdPartyTraffic(): boolean {
  return useSyncExternalStore(subscribeThirdPartyMode, noThirdPartyTraffic, () => true);
}

type PolicyState = ReturnType<typeof usePolicyStore.getState>;

/** The external content setting locked to "block" by the organisation. */
function externalContentLockedToBlock(state: PolicyState): boolean {
  const restriction = state.getRestriction('externalContentPolicy');
  if (restriction?.locked !== true) return false;
  // A lock without a value locks the organisation's default (as the
  // settings store applies it).
  const value = Object.prototype.hasOwnProperty.call(restriction, 'value')
    ? restriction.value
    : state.getEffectiveDefault('externalContentPolicy');
  return value === 'block';
}

/**
 * Whether the organisation keeps remote content in mail from loading at all:
 * no third-party traffic, or the external content setting locked to "block".
 * Then neither a one-off load nor a trusted sender lets it through.
 */
export function useRemoteContentBlockedByOrg(): boolean {
  const noThirdParty = useNoThirdPartyTraffic();
  const lockedToBlock = usePolicyStore(externalContentLockedToBlock);
  return noThirdParty || lockedToBlock;
}

/** useRemoteContentBlockedByOrg, read once outside React. */
export function remoteContentBlockedByOrg(): boolean {
  return noThirdPartyTraffic() || externalContentLockedToBlock(usePolicyStore.getState());
}
