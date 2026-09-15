import type { Hex } from 'viem';
import type { ClassifiedExecutorKitError } from '../../errors.js';
import type { StateMachineJobStatus, StateMachineJobSubmission } from '../jobs/model.js';
import { SubmitSignalReceiptError } from '../../signal/submit.js';
import type { SubmitStateMachineSignalResult } from '../../signal/submit.js';
import type { StateMachineSignal } from '../../signal/build.js';
import type { StateMachineHookReadyHandlerResult } from './handler.js';

export class ClassifiedStateMachineError extends Error {
  readonly classified: ClassifiedExecutorKitError;

  constructor(classified: ClassifiedExecutorKitError, options?: { readonly cause?: unknown }) {
    super(classified.message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ClassifiedStateMachineError';
    this.classified = classified;
  }
}

export function normalizeHandlerResult(result: StateMachineHookReadyHandlerResult): readonly StateMachineSignal[] {
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result as readonly StateMachineSignal[] : [result as StateMachineSignal];
}

export function toJobSubmission(
  signalIndex: number,
  attempt: number,
  result: SubmitStateMachineSignalResult,
): StateMachineJobSubmission {
  return {
    signalIndex,
    attempt,
    dryRun: result.dryRun,
    request: result.request,
    ...(!result.dryRun ? { txHash: result.txHash } : {}),
    // Persist the receipt outcome so a later scan can tell an observed success
    // from a broadcast whose outcome was never known.
    ...(!result.dryRun && result.confirmed ? { confirmed: true } : {}),
  };
}

/**
 * Recovers the hash of an already-broadcast transaction from a submission
 * failure. Mirrors the classified-code walk in errors.ts: any Error along the
 * cause chain may carry a `txHash` hex property (e.g. SubmitSignalReceiptError
 * thrown after a successful broadcast whose receipt never confirmed).
 */
export function broadcastTxHashFromError(error: unknown): Hex | undefined {
  for (const current of walkSubmissionErrorChain(error)) {
    const txHash = (current as { readonly txHash?: unknown }).txHash;
    if (typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return txHash as Hex;
    }
  }
  return undefined;
}

function* walkSubmissionErrorChain(error: unknown): Generator<Error> {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    yield current;
    current = current.cause;
  }
}

/**
 * Terminal status for a run that processed (or resumed) its signals, over both
 * submission lanes:
 *
 * - `confirmed`: every signal — returned and handler-context — is delivered by
 *   evidence (an observed success receipt, or the chain's own
 *   `SignalAlreadyExists` verdict on the four-tuple), and no recorded
 *   broadcast is left without such evidence — an unobserved receipt never
 *   counts, not even from this run;
 * - `submitted`: any real broadcast happened or remains unresolved — including
 *   a handler that stopped emitting signals an earlier run had already
 *   broadcast (an unresolved broadcast keeps the job in the revisit lane
 *   whatever the handler now returns) and runs whose delivery evidence is a
 *   duplicate fact plus nothing else observed this run;
 * - `matched`: dry-runs and handler-only runs with nothing to broadcast.
 */
export function statusForCompletedRun(input: {
  readonly dryRun: boolean;
  readonly deliveredSignalIndexes: ReadonlySet<number>;
  readonly signals: readonly StateMachineSignal[];
  readonly jobSubmissions: readonly StateMachineJobSubmission[];
  readonly thisRunSubmissions: readonly StateMachineJobSubmission[];
}): StateMachineJobStatus {
  if (input.dryRun) {
    return 'matched';
  }
  // Delivery evidence is recomputed from the records, not taken from the
  // in-run index set: that set also marks merely-sent signals (a
  // waitForReceipt:false broadcast) which are not evidence of anything.
  const provenDelivered = deliveredSignalIndexesFromSubmissions(input.jobSubmissions);
  const contextSignalCount = new Set(
    input.jobSubmissions.filter((submission) => submission.signalIndex < 0).map((submission) => submission.signalIndex),
  ).size;
  const deliveredContextCount = [...provenDelivered].filter((index) => index < 0).length;
  const returnedComplete = input.signals.every((_signal, index) => provenDelivered.has(index));
  const contextComplete = deliveredContextCount >= contextSignalCount;
  const unprovenBroadcasts = input.jobSubmissions.filter((submission) =>
    submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.confirmed !== true
    && submission.error?.kind !== 'duplicate_signal'
    && !provenDelivered.has(submission.signalIndex),
  ).length;
  const hasRealBroadcast = input.jobSubmissions.some((submission) => submission.dryRun !== true);
  if (
    returnedComplete
    && contextComplete
    && input.signals.length + contextSignalCount > 0
    && unprovenBroadcasts === 0
  ) {
    return 'confirmed';
  }
  if (input.thisRunSubmissions.length > 0 || input.deliveredSignalIndexes.size > 0 || hasRealBroadcast) {
    return 'submitted';
  }
  return 'matched';
}

/**
 * Signal indexes that must not be (re)submitted: each has a prior real
 * (non-dry-run) submission whose delivery is evidenced — a duplicate_signal
 * response proving the chain already carries the signal, or a broadcast whose
 * receipt was observed as success. A broadcast without an observed receipt
 * (waitForReceipt:false) and a reverted receipt do NOT count: they are exactly
 * the facts later scans must re-check instead of trusting. Dry-run submissions
 * never count — flipping dry-run off must still broadcast everything.
 */
export function deliveredSignalIndexesFromSubmissions(
  submissions: readonly StateMachineJobSubmission[],
): Set<number> {
  const delivered = new Set<number>();
  for (const submission of submissions) {
    if (submission.error?.kind === 'duplicate_signal'
      || (!submission.error && submission.dryRun === false && submission.confirmed === true)) {
      delivered.add(submission.signalIndex);
    }
  }
  return delivered;
}

/** A real broadcast of this signal whose outcome is still unknown. */
export function isUnconfirmedBroadcast(submission: StateMachineJobSubmission, signalIndex: number): boolean {
  return submission.signalIndex === signalIndex
    && submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.error?.kind !== 'duplicate_signal'
    && submission.confirmed !== true;
}

/**
 * Broadcast-but-unconfirmed attempts for one signal — both attempts that
 * failed after broadcasting (receipt wait threw) and attempts that returned
 * without a receipt (waitForReceipt:false). These are the recheck/resend
 * candidates: resolved by the receipt first, rebroadcast under backoff second.
 */
export function unconfirmedBroadcastCount(
  submissions: readonly StateMachineJobSubmission[],
  signalIndex: number,
): number {
  return submissions.filter((submission) => isUnconfirmedBroadcast(submission, signalIndex)).length;
}

/**
 * Append a submission record to the audit trail. Dry-run records are
 * simulations of one deterministic request per signal: a replayed dry-run must
 * not append a duplicate (the record list grew once per signal per rescan).
 * Real broadcasts are never deduped — each is a distinct on-chain fact.
 */
export function appendJobSubmission(
  submissions: StateMachineJobSubmission[],
  candidate: StateMachineJobSubmission,
): void {
  if (candidate.dryRun === true) {
    const duplicate = submissions.some((submission) =>
      submission.dryRun === true
      && submission.signalIndex === candidate.signalIndex
      && submission.request?.data === candidate.request?.data);
    if (duplicate) {
      return;
    }
  }
  submissions.push(candidate);
}

/** Next per-signal attempt ordinal for a recovered/replayed record. */
export function nextSubmissionAttempt(
  submissions: readonly StateMachineJobSubmission[],
  signalIndex: number,
): number {
  return submissions.filter((submission) => submission.signalIndex === signalIndex).length + 1;
}

export function jobStatusForError(error: ClassifiedExecutorKitError): StateMachineJobStatus {
  if (error.kind === 'missing_handler' || error.kind === 'duplicate_signal') {
    return 'ignored';
  }
  // Transient failures keep the retry channel open: after the in-run retries are
  // exhausted the job lands in `failed`, which `jobs retry` accepts. Deterministic
  // non-retryable failures dead-letter for human triage instead of parking in the
  // retryable lane where automatic or manual retries would pointlessly re-run them.
  return error.retryable ? 'failed' : 'dead_letter';
}

/**
 * Terminal status for a run that failed. A failure recorded together with a
 * broadcast whose outcome is unknown must not terminalize the job — `failed`
 * and `dead_letter` both end the automatic receipt rechecks, and the tx may
 * still mine. The job stays in the open `submitted` lane instead, and later
 * scans settle it by receipt (a mined revert then dead-letters with a known
 * outcome). A receipt actually observed as reverted is a known outcome and
 * still terminalizes normally.
 */
export function statusForTerminalError(
  error: unknown,
  classified: ClassifiedExecutorKitError,
  jobSubmissions: readonly StateMachineJobSubmission[],
): StateMachineJobStatus {
  if (!carriesKnownRevert(error) && hasUnresolvedBroadcast(jobSubmissions)) {
    return 'submitted';
  }
  return jobStatusForError(classified);
}

function hasUnresolvedBroadcast(submissions: readonly StateMachineJobSubmission[]): boolean {
  const provenDelivered = deliveredSignalIndexesFromSubmissions(submissions);
  return submissions.some((submission) =>
    submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.confirmed !== true
    && submission.error?.kind !== 'duplicate_signal'
    && !provenDelivered.has(submission.signalIndex));
}

/** True when the error chain proves a receipt was observed as 'reverted'. */
export function carriesKnownRevert(error: unknown): boolean {
  return [...walkSubmissionErrorChain(error)].some(
    (current) => current instanceof SubmitSignalReceiptError && current.reverted,
  );
}
