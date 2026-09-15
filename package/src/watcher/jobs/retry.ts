import { classifyExecutorKitError } from '../../errors.js';
import {
  ExecutorKitError,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../../validation.js';
import type { Hex } from 'viem';
import { asNonEmptyString, asNumberOrString, parseNonNegativeSafeInteger } from '../internal.js';
import {
  appendManualAction,
  latestSubmissionTxHash,
  type StateMachineJobStatus,
} from './model.js';
import { isHeldRunClaim } from './claim.js';
import type { StateMachineLogProcessResult, StateMachineWatcher } from '../watcher.js';

export interface StateMachineRetryConfig {
  readonly maxAttempts?: number | string;
  readonly baseDelayMs?: number | string;
}

/**
 * Backoff for rebroadcasting a signal whose prior broadcast was never
 * confirmed. The rescan keeps re-triggering every poll round; without a
 * growing wait the same signal went out once per round (the chain's
 * idempotency key absorbs it, at gas cost).
 */
export interface StateMachineResendBackoffConfig {
  readonly baseDelayMs?: number | string;
  readonly maxDelayMs?: number | string;
}

/**
 * First wait before rebroadcasting a signal whose earlier broadcast was
 * never confirmed (job-level resend backoff base).
 */
export const DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS = 30_000;
/** Ceiling of the resend backoff so an unconfirmed signal cannot starve forever. */
export const DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS = 600_000;

export interface StateMachineJobRetryOptions {
  readonly operator: string;
  readonly reason?: string;
  readonly now?: () => string;
}

export async function retryStateMachineJob(
  watcher: StateMachineWatcher,
  jobId: Hex | string,
  options: StateMachineJobRetryOptions,
): Promise<StateMachineLogProcessResult> {
  const normalizedJobId = normalizeBytes32(jobId, 'jobId');
  const job = await watcher.config.jobStore.get(normalizedJobId);
  if (!job) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  if (!isRetriableStateMachineJobStatus(job.status)) {
    throw new ValidationError(`job ${normalizedJobId} cannot be retried from status ${job.status}`);
  }
  if (isHeldRunClaim(job.claim)) {
    // matched 的可重试性是崩溃恢复通道：只有持有者已死才可接管。被持有的
    // 认领下重试等于第二个执行器并发跑同一 handler——链上幂等键挡不住
    // handler 的链外副作用。
    throw new ExecutorKitError(
      `job ${normalizedJobId} is being processed by executor pid ${job.claim?.pid}` +
        ` (claimed at ${job.claim?.at}); wait for that run to finish or stop its process, then retry`,
    );
  }
  if (!job.raw) {
    throw new ValidationError(`job ${normalizedJobId} cannot be retried because its raw HookReady log was not stored`);
  }

  const at = (options.now ?? watcher.config.now)();
  const manualActions = appendManualAction(job, {
    action: 'retry',
    operator: asNonEmptyString(options.operator, 'operator'),
    at,
    ...(options.reason ? { reason: options.reason } : {}),
  });

  // `maxAttempts` limits one automatic processing run.  A manual retry is an
  // explicit new run, so an exhausted retryable failure must get a fresh
  // budget; otherwise every failed job is immediately dead-lettered and the
  // documented `jobs retry` escape hatch is a dead channel.
  if (job.attempts >= job.maxAttempts && job.status !== 'failed' && job.status !== 'confirmed') {
    if (job.status === 'submitted') {
      // Same refusal caliber as deadLetterStateMachineJob: a broadcast without
      // a confirmed receipt must be neither retried (blind replay risks a
      // second on-chain transaction) nor dead-lettered (the tx may still
      // confirm). Verify the receipt before acting on this job.
      const txHash = latestSubmissionTxHash(job.submissions);
      throw new ValidationError(
        `job ${normalizedJobId} was broadcast without a confirmed receipt (status submitted)`
        + `${txHash ? `: check the receipt for ${txHash}` : ''} before retrying`,
      );
    }
    const error = classifyExecutorKitError(
      new Error(`retry limit reached for job ${normalizedJobId}: ${job.attempts}/${job.maxAttempts}`),
    );
    const deadLetter = await watcher.config.jobStore.update(normalizedJobId, {
      status: 'dead_letter',
      updatedAt: at,
      manualActions,
      lastError: error,
      claim: null,
      expectStatus: job.status,
      expectClaimPid: job.claim?.pid ?? null,
    });
    if (!deadLetter) {
      throw await conflictRetryError(normalizedJobId, watcher);
    }
    return {
      status: 'ignored',
      submissions: [],
      job: deadLetter,
      error,
    };
  }

  // CAS 重开：仅当任务仍处于读取时的状态与认领时才写回 detected。读取与
  // 写入之间若 watcher 已推进（认领了运行），这里失败而不是覆盖——覆盖
  // 会把进行中的运行打回 detected，形成同一 handler 的并发二次执行。
  const reopened = await watcher.config.jobStore.update(normalizedJobId, {
    status: 'detected',
    updatedAt: at,
    ...(job.status === 'failed' ? { attempts: 0 } : {}),
    manualActions,
    clearLastError: true,
    claim: null,
    expectStatus: job.status,
    expectClaimPid: job.claim?.pid ?? null,
  });
  if (!reopened) {
    throw await conflictRetryError(normalizedJobId, watcher);
  }
  // Retrying out of `confirmed` is the manual recovery channel for a
  // reorg-invalidated confirmation: the operator explicitly declares the prior
  // outcome invalid, so the run resubmits everything instead of treating the
  // old broadcasts as delivered. Manual retries also skip the resend backoff —
  // the operator asked for the attempt now, not after the throttle window.
  return watcher.handleLog(job.raw, {
    resubmitDelivered: job.status === 'confirmed',
    bypassResendBackoff: true,
  });
}

async function conflictRetryError(
  jobId: Hex,
  watcher: StateMachineWatcher,
): Promise<ExecutorKitError> {
  const current = await watcher.config.jobStore.get(jobId);
  return new ExecutorKitError(
    `job ${jobId} changed state while the retry was being applied (now ${current?.status ?? 'missing'});` +
      ' re-check the job and run the retry again',
  );
}

export interface NormalizedStateMachineRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export interface NormalizedStateMachineResendBackoffConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function normalizeRetryConfig(config: StateMachineRetryConfig | Record<string, unknown> | undefined): NormalizedStateMachineRetryConfig {
  const maxAttempts = config?.maxAttempts;
  const baseDelayMs = config?.baseDelayMs;
  return {
    maxAttempts: maxAttempts !== undefined
      ? parsePositiveInteger(asNumberOrString(maxAttempts, 'retry.maxAttempts'), 'retry.maxAttempts')
      : 3,
    baseDelayMs: baseDelayMs !== undefined
      ? parseNonNegativeSafeInteger(asNumberOrString(baseDelayMs, 'retry.baseDelayMs'), 'retry.baseDelayMs')
      : 0,
  };
}

function isRetriableStateMachineJobStatus(status: StateMachineJobStatus): boolean {
  // `confirmed` is retriable as the manual recovery channel: a reorg can flip
  // a confirmation off the canonical chain while the job stays terminal
  // forever otherwise. The retry resubmits and the on-chain idempotency key
  // absorbs a duplicate when the signal actually survived.
  // `detected` is the crash-recovery channel: a process death between
  // upsertDetected and processing left the job with no run at all — refusing
  // it here (and only the later-scan pass being able to revive it) made a
  // stranded detected job unreachable even for a manual retry.
  return status === 'detected'
    || status === 'failed'
    || status === 'matched'
    || status === 'submitted'
    || status === 'confirmed';
}

/** Exponential resend delay capped at maxDelayMs. */
export function resendBackoffDelayMs(
  config: NormalizedStateMachineResendBackoffConfig,
  priorUnconfirmedBroadcasts: number,
): number {
  const exponent = Math.min(Math.max(priorUnconfirmedBroadcasts - 1, 0), 16);
  return Math.min(config.baseDelayMs * 2 ** exponent, config.maxDelayMs);
}
