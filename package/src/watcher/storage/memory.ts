import type { Hex } from 'viem';
import { ZERO_BYTES32 } from '../../constants.js';
import {
  applyJobPatch,
  cloneJob,
  patchCasMatches,
  stateMachineJobId,
  type StateMachineJobPatch,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from '../jobs/model.js';
import type { StateMachineHookReady } from '../../signal/decode.js';

export class InMemoryStateMachineJobStore implements StateMachineJobStore {
  readonly kind = 'memory';
  private readonly jobs = new Map<Hex, StateMachineWatcherJob>();

  async upsertDetected(event: StateMachineHookReady, options: {
    readonly now: string;
    readonly maxAttempts: number;
    readonly supplierId?: string;
  }): Promise<StateMachineWatcherJob> {
    const id = stateMachineJobId(event);
    const existing = this.jobs.get(id);
    if (existing) {
      return cloneJob(existing);
    }

    const job: StateMachineWatcherJob = {
      id,
      eventId: event.eventId,
      ...(event.stateMachineAddress ? { stateMachineAddress: event.stateMachineAddress } : {}),
      orderId: event.orderId,
      // Persist the event planId from day one: the plan-scoped submitSignal ABI
      // needs it on every (re)submission, and dropping it here forced every
      // config-driven job into dead_letter on the first attempt. The zero
      // sentinel (undecodable-log isolation) is not a known plan and is skipped.
      ...(event.planId && event.planId !== ZERO_BYTES32 ? { planId: event.planId } : {}),
      hookId: event.hookId,
      stageId: event.stageId,
      ...(event.stageIdentifier ? { stageIdentifier: event.stageIdentifier } : {}),
      ...(event.hookName ? { hookName: event.hookName } : {}),
      ...(options.supplierId ? { supplierId: options.supplierId } : {}),
      status: 'detected',
      attempts: 0,
      maxAttempts: options.maxAttempts,
      detectedAt: options.now,
      updatedAt: options.now,
      submissions: [],
      ...(event.raw ? { raw: event.raw } : {}),
    };
    this.jobs.set(id, cloneJob(job));
    return job;
  }

  async update(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob | undefined> {
    const current = this.jobs.get(jobId);
    if (!current) {
      return undefined;
    }
    if (!patchCasMatches(current, patch)) {
      return undefined;
    }
    const next = applyJobPatch(current, patch);
    this.jobs.set(jobId, cloneJob(next));
    return next;
  }

  async get(jobId: Hex): Promise<StateMachineWatcherJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  async list(): Promise<readonly StateMachineWatcherJob[]> {
    return [...this.jobs.values()]
      .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id))
      .map((job) => cloneJob(job));
  }
}
