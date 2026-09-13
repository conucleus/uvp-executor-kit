import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import type { StateMachineHookReady, StateMachineRawLog } from '../../signal/decode.js';
import { ZERO_BYTES32 } from '../../constants.js';
import {
  normalizeAddress,
  normalizeBytes32,
  parseBigNumberish,
  ValidationError,
} from '../../validation.js';
import { asNumberOrString, asString, isNodeError, isRecord } from '../internal.js';
import {
  applyJobPatch,
  cloneJob,
  patchCasMatches,
  stateMachineJobId,
  type StateMachineJobPatch,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from '../jobs/model.js';
import { withJobsFileLock } from './lock.js';

export class FileStateMachineJobStore implements StateMachineJobStore {
  readonly kind = 'file';
  readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || filePath.trim().length === 0) {
      throw new ValidationError('jobs file path is required');
    }
    this.filePath = filePath;
  }

  async upsertDetected(event: StateMachineHookReady, options: {
    readonly now: string;
    readonly maxAttempts: number;
    readonly supplierId?: string;
  }): Promise<StateMachineWatcherJob> {
    return withJobsFileLock(this.filePath, async () => {
      const jobs = await readStateMachineJobsFile(this.filePath);
      const id = stateMachineJobId(event);
      const existing = jobs.get(id);
      if (existing) {
        return cloneJob(existing);
      }

      const job: StateMachineWatcherJob = {
        id,
        eventId: event.eventId,
        ...(event.stateMachineAddress ? { stateMachineAddress: event.stateMachineAddress } : {}),
        orderId: event.orderId,
        // See the in-memory store: the event planId must be persisted at detection
        // so retries can resubmit the plan-scoped submitSignal ABI.
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
      jobs.set(id, cloneJob(job));
      await writeStateMachineJobsFile(this.filePath, jobs);
      return job;
    });
  }

  async update(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob | undefined> {
    return withJobsFileLock(this.filePath, async () => {
      const jobs = await readStateMachineJobsFile(this.filePath);
      const current = jobs.get(jobId);
      if (!current) {
        return undefined;
      }
      if (!patchCasMatches(current, patch)) {
        return undefined;
      }

      const next = applyJobPatch(current, patch);
      jobs.set(jobId, cloneJob(next));
      await writeStateMachineJobsFile(this.filePath, jobs);
      return next;
    });
  }

  async get(jobId: Hex): Promise<StateMachineWatcherJob | undefined> {
    const jobs = await readStateMachineJobsFile(this.filePath);
    const job = jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  async list(): Promise<readonly StateMachineWatcherJob[]> {
    const jobs = await readStateMachineJobsFile(this.filePath);
    return [...jobs.values()]
      .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id))
      .map((job) => cloneJob(job));
  }
}

async function readStateMachineJobsFile(filePath: string): Promise<Map<Hex, StateMachineWatcherJob>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
  if (raw.trim().length === 0) {
    return new Map();
  }

  try {
    return parseStateMachineJobsFile(raw);
  } catch (error) {
    // Quarantine-and-recover instead of throwing forever: an untreated
    // truncated write poisons every later read and aborts the watch loop
    // permanently.
    await quarantineCorruptStateFile(filePath, raw, error, 'jobs');
    return new Map();
  }
}

function parseStateMachineJobsFile(raw: string): Map<Hex, StateMachineWatcherJob> {
  const parsed = JSON.parse(raw) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : undefined;
  if (!values) {
    throw new ValidationError('jobs file must contain a jobs array');
  }

  return new Map(values.map((value) => {
    const job = reviveStoredStateMachineJob(value);
    return [job.id, job] as const;
  }));
}

/**
 * Whole-file persistence must be tmp+rename: a plain writeFile that crashes
 * mid-write leaves a truncated file whose every later parse throws and
 * eventually aborts the watch loop.
 */
export async function writeStateFileAtomically(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Keep the damaged bytes instead of deleting them silently: the operator can
 * still inspect the quarantined file while the process recovers with empty
 * state.
 */
export async function quarantineCorruptStateFile(filePath: string, raw: string, error: unknown, kind: 'jobs' | 'cursor'): Promise<void> {
  const quarantinePath = `${filePath}.corrupt-${new Date().toISOString().replaceAll(/[:.]/g, '')}`;
  try {
    await rename(filePath, quarantinePath);
  } catch {
    return;
  }
  console.error(
    `executor-kit: ${kind} state file ${filePath} was unreadable (${error instanceof Error ? error.message : String(error)});`
    + ` it was moved to ${quarantinePath} and will be recreated from scratch. The raw contents began with: ${raw.slice(0, 120)}`,
  );
}

async function writeStateMachineJobsFile(filePath: string, jobs: ReadonlyMap<Hex, StateMachineWatcherJob>): Promise<void> {
  await writeStateFileAtomically(
    filePath,
    `${JSON.stringify({ version: 1, jobs: [...jobs.values()] }, stateMachineJobJsonReplacer, 2)}\n`,
  );
}

function reviveStoredStateMachineJob(value: unknown): StateMachineWatcherJob {
  if (!isRecord(value)) {
    throw new ValidationError('stored job must be an object');
  }
  const job = value as unknown as StateMachineWatcherJob;
  return {
    ...job,
    id: normalizeBytes32(job.id, 'job.id'),
    eventId: normalizeBytes32(job.eventId, 'job.eventId'),
    ...(job.stateMachineAddress ? { stateMachineAddress: normalizeAddress(job.stateMachineAddress, 'job.stateMachineAddress') } : {}),
    orderId: normalizeBytes32(job.orderId, 'job.orderId'),
    hookId: normalizeBytes32(job.hookId, 'job.hookId'),
    stageId: normalizeBytes32(job.stageId, 'job.stageId'),
    ...(job.planId ? { planId: normalizeBytes32(job.planId, 'job.planId') } : {}),
    ...(isRecord(value.raw) ? { raw: reviveStoredRawLog(value.raw) } : {}),
  };
}

function reviveStoredRawLog(value: Record<string, unknown>): StateMachineRawLog {
  const data = asString(value.data, 'raw.data') as Hex;
  const topics = Array.isArray(value.topics)
    ? value.topics.map((topic, index) => asString(topic, `raw.topics[${index}]`) as Hex)
    : [];
  if (topics.length === 0) {
    throw new ValidationError('raw.topics must include an event topic');
  }
  const blockNumber = value.blockNumber === undefined || value.blockNumber === null
    ? undefined
    : parseBigNumberish(asNumberOrString(value.blockNumber, 'raw.blockNumber'), 'raw.blockNumber');
  const logIndex = value.logIndex === undefined || value.logIndex === null
    ? undefined
    : parseBigNumberish(asNumberOrString(value.logIndex, 'raw.logIndex'), 'raw.logIndex');
  return {
    data,
    topics,
    ...(typeof value.address === 'string' ? { address: value.address } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(typeof value.transactionHash === 'string' ? { transactionHash: value.transactionHash as Hex } : {}),
    ...(logIndex !== undefined ? { logIndex } : {}),
  };
}

function stateMachineJobJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
