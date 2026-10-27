/**
 * Bumped whenever the account-scoped stores are emptied for another account
 * (an account switch, a sign-out). A fetch captures it before awaiting the
 * server and drops its result if it has changed since: the data belongs to
 * an account that is no longer on screen, and writing it would show - and
 * let the user act on - one account's folders or filters in another.
 */
let epoch = 0;

export function currentStoreEpoch(): number {
  return epoch;
}

export function bumpStoreEpoch(): void {
  epoch++;
}

/**
 * State kept for the accounts on screen (what the user did this session, by
 * ids that only mean something in those accounts): `make` gives it, and it
 * is made afresh at the first use after a switch or a sign-out. Returns the
 * getter.
 */
export function perStoreEpoch<T>(make: () => T): () => T {
  let value = make();
  let madeAt = epoch;
  return () => {
    if (madeAt !== epoch) {
      value = make();
      madeAt = epoch;
    }
    return value;
  };
}
