/**
 * A reschedule canceled the original submission, could not create the
 * replacement, and put the original back. The message still goes out at its
 * old time, under a new submission id.
 */
export class RescheduleRestoredError extends Error {
  constructor(message: string, readonly restoredSubmissionId: string, readonly restoredSendAt?: string) {
    super(message);
    this.name = 'RescheduleRestoredError';
  }
}

/**
 * A reschedule canceled the original submission and neither the replacement
 * nor the original could be created again: the message is not scheduled any
 * more and was put back into Drafts.
 */
export class RescheduleUnscheduledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RescheduleUnscheduledError';
  }
}

const unscheduledErrors = new WeakSet<object>();

/**
 * Marks an error a reschedule rethrows as it is (a refused recipient, a used
 * up quota) after the message stopped being scheduled.
 */
export function markUnscheduled<E extends Error>(error: E): E {
  unscheduledErrors.add(error);
  return error;
}

/** Whether a failed reschedule left the message unscheduled, back in Drafts. */
export function leftUnscheduled(error: unknown): boolean {
  return error instanceof RescheduleUnscheduledError
    || (typeof error === 'object' && error !== null && unscheduledErrors.has(error));
}
