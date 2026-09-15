import {
  ExecutorKitError,
  normalizeBytes32,
  ValidationError,
} from '../../validation.js';
import type { Hex } from 'viem';
import { asNonEmptyString } from '../internal.js';
import {
  appendManualAction,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from './model.js';
import { isHeldRunClaim } from './claim.js';

export interface StateMachineJobDeadLetterOptions {
  readonly operator: string;
  readonly reason: string;
  readonly now?: () => string;
}

export async function deadLetterStateMachineJob(
  jobStore: StateMachineJobStore,
  jobId: Hex | string,
  options: StateMachineJobDeadLetterOptions,
): Promise<StateMachineWatcherJob> {
  const normalizedJobId = normalizeBytes32(jobId, 'jobId');
  const job = await jobStore.get(normalizedJobId);
  if (!job) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  if (job.status === 'confirmed' || job.status === 'submitted') {
    throw new ValidationError(`job ${normalizedJobId} cannot be dead-lettered from status ${job.status}`);
  }
  if (isHeldRunClaim(job.claim)) {
    // dead_letter 附带 claim:null：在一个运行中的任务上落它会清掉执行者的
    // 活认领，等于把进行中的 handler 变成无主运行。与 retry 入口同一条闸。
    throw new ExecutorKitError(
      `job ${normalizedJobId} is being processed by executor pid ${job.claim?.pid}` +
        ` (claimed at ${job.claim?.at}); wait for that run to finish or stop its process, then dead-letter`,
    );
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  const reason = asNonEmptyString(options.reason, 'reason');
  const updated = await jobStore.update(normalizedJobId, {
    status: 'dead_letter',
    updatedAt: at,
    lastError: {
      kind: 'unknown',
      message: reason,
      retryable: false,
    },
    manualActions: appendManualAction(job, {
      action: 'dead_letter',
      operator: asNonEmptyString(options.operator, 'operator'),
      at,
      reason,
    }),
    claim: null,
    expectStatus: job.status,
    expectClaimPid: job.claim?.pid ?? null,
  });
  if (!updated) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} changed state while dead-lettering was being applied; re-check the job and retry`,
    );
  }
  return updated;
}
