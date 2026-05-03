import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  classifyExecutorKitError,
  type ClassifiedExecutorKitError,
} from './errors.js';
import { ZERO_BYTES32 } from './constants.js';
import { DEFAULT_SIGNING_KEY_ENV, loadPrivateKeyFromEnv } from './signing.js';
import {
  ValidationError,
  normalizeAddress,
  normalizeBytes32,
  parseBigNumberish,
  parsePositiveInteger,
} from './validation.js';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';

export { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';

export const DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV = DEFAULT_SIGNING_KEY_ENV;
export const DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS = 4_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const HOOK_READY_TOPIC = keccak256(stringToBytes('HookReady(bytes32,bytes32,bytes32,bytes32)'));

export interface StateMachineRawLog {
  readonly data: Hex;
  readonly topics: readonly Hex[];
  readonly address?: Address | string;
  readonly blockNumber?: bigint | null;
  readonly transactionHash?: Hex | null;
  readonly logIndex?: number | bigint | null;
}

export interface StateMachineHookReady {
  readonly type: 'HookReady';
  readonly eventId: Hex;
  readonly stateMachineAddress?: Address;
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly hookNameId: Hex;
  readonly stageIdentifier?: string;
  readonly hookName?: string;
  readonly blockNumber?: bigint;
  readonly transactionHash?: Hex;
  readonly logIndex?: bigint;
  readonly raw?: StateMachineRawLog;
}

export interface StateMachineSignal {
  readonly orderId: Hex | string;
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  readonly payloadRef?: string;
  readonly readyEventId?: Hex | string;
  readonly idempotencyKey?: string;
}

export interface StateMachineSignalCallArgs {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
}

export interface SubmitStateMachineSignalCall {
  readonly address: Address;
  readonly abi: typeof STATE_MACHINE_ABI;
  readonly functionName: 'submitSignal';
  readonly args: readonly [Hex, Hex, Hex, Hex, Hex];
  readonly data: Hex;
  readonly chainId: number;
  readonly from?: Address;
}

export interface SubmitStateMachineSignalConfig {
  readonly stateMachineAddress?: Address | string;
  readonly rpcUrl: string;
  readonly chainId: number | string;
  readonly walletAddress?: Address | string;
  readonly privateKeyEnv?: string;
  readonly dryRun?: boolean;
  readonly waitForReceipt?: boolean;
  readonly publicClient?: StateMachinePublicClient;
}

export type SubmitStateMachineSignalResult =
  | {
    readonly dryRun: true;
    readonly request: SubmitStateMachineSignalCall;
  }
  | {
    readonly dryRun: false;
    readonly request: SubmitStateMachineSignalCall;
    readonly txHash: Hex;
    readonly confirmed?: boolean;
  };

export interface StateMachineWatchHandle {
  stop(): Promise<void> | void;
}

export interface StateMachineHookReadyHandlerContext {
  readonly matchedKey: string;
  readonly submitSignal: (
    signal: StateMachineSignal,
    overrides?: Partial<SubmitStateMachineSignalConfig>,
  ) => Promise<SubmitStateMachineSignalResult>;
}

export type StateMachineHookReadyHandlerResult =
  | void
  | StateMachineSignal
  | readonly StateMachineSignal[];

export type StateMachineHookReadyHandler = (
  event: StateMachineHookReady,
  context: StateMachineHookReadyHandlerContext,
) => StateMachineHookReadyHandlerResult | Promise<StateMachineHookReadyHandlerResult>;

export interface StateMachineWatcherConfig extends SubmitStateMachineSignalConfig {
  readonly supplierId?: string;
  readonly stateMachines?: readonly StateMachineDeploymentWatcherConfig[];
  readonly handlers: Readonly<Record<string, StateMachineHookReadyHandler>>;
  readonly artifact?: StateMachineArtifactIndex;
  readonly fromBlock?: bigint | number | string;
  readonly pollIntervalMs?: number | string;
  readonly retry?: StateMachineRetryConfig;
  readonly jobStore?: StateMachineJobStore;
  readonly now?: () => string;
  readonly onPoll?: (result: StateMachinePollResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface StateMachineDeploymentWatcherConfig {
  readonly stateMachineAddress: Address | string;
  readonly deploymentId?: Hex | string;
  readonly status?: 'active' | 'deprecated' | 'canary' | 'candidate' | 'retired';
}

export interface StateMachinePublicClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    readonly address: Address;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly StateMachineRawLog[]>;
  waitForTransactionReceipt?(args: {
    readonly hash: Hex;
  }): Promise<{ readonly status?: 'success' | 'reverted' | string }>;
}

export interface StateMachineLogProcessResult {
  readonly status: 'skipped' | 'ignored' | 'handled';
  readonly event?: StateMachineHookReady;
  readonly matchedKey?: string;
  readonly submissions: readonly SubmitStateMachineSignalResult[];
  readonly job?: StateMachineWatcherJob;
  readonly error?: ClassifiedExecutorKitError;
}

export interface StateMachinePollResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly scannedLogs: number;
  readonly results: readonly StateMachineLogProcessResult[];
}

export interface StateMachineStaticHandlerDefinition {
  readonly signals: readonly StateMachineStaticSignalDefinition[];
}

export interface StateMachineStaticSignalDefinition {
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  readonly readyEventId?: Hex | string;
  readonly idempotencyKey?: string;
}

export interface StateMachineHandlerConfig {
  readonly supplierId?: string;
  readonly executorId?: string;
  readonly walletAddress?: Address;
  readonly chainId?: number;
  readonly stateMachineAddress?: Address;
  readonly stateMachines?: readonly StateMachineDeploymentWatcherConfig[];
  readonly chainServicesUrl?: string;
  readonly stages?: readonly string[];
  readonly callbackMode?: ExecutorCallbackMode;
  readonly dryRun?: boolean;
  readonly authTokenRef?: string;
  readonly artifact?: StateMachineArtifactIndex;
  readonly handlers: Readonly<Record<string, StateMachineStaticHandlerDefinition>>;
  readonly retry?: StateMachineRetryConfig;
}

export interface StateMachineRetryConfig {
  readonly maxAttempts?: number | string;
  readonly baseDelayMs?: number | string;
}

export interface StateMachineArtifactIndex {
  readonly hooksByHookId?: Readonly<Record<string, StateMachineHookMetadata>>;
  readonly signals?: Readonly<Record<string, StateMachineSignalMetadata>>;
}

export interface StateMachineHookMetadata {
  readonly stageIdentifier: string;
  readonly hookName: string;
}

export interface StateMachineSignalMetadata {
  readonly sourceId: Hex | string;
  readonly signalId: Hex | string;
}

export type ExecutorCallbackMode = 'manual' | 'auto' | 'webhook';

export interface ExecutorConfigDTO {
  readonly supplierId?: string;
  readonly walletAddress?: Address;
  readonly chainId?: number;
  readonly stateMachineAddress?: Address;
  readonly stateMachines?: readonly { readonly stateMachineAddress: Address; readonly deploymentId?: Hex; readonly status?: string }[];
  readonly chainServicesUrl?: string;
  readonly stages: readonly string[];
  readonly signals: readonly string[];
  readonly callbackMode: ExecutorCallbackMode;
  readonly dryRun: boolean;
  readonly authTokenRef?: string;
}

export type ExecutorJobStatusDTO =
  | 'queued'
  | 'running'
  | 'callback_pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'dead_letter';

export interface ExecutorJobDTO {
  readonly jobId: Hex;
  readonly orderId: Hex;
  readonly stateMachineAddress?: Address;
  readonly planId?: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier?: string;
  readonly hookName?: string;
  readonly supplierId?: string;
  readonly status: ExecutorJobStatusDTO;
  readonly attempts: number;
  readonly lastError?: ClassifiedExecutorKitError;
  readonly txHash?: Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierOpsSummaryDTO {
  readonly supplierId: string;
  readonly walletAddress?: Address;
  readonly attestationStatus: 'not_checked' | 'attested' | 'not_attested' | 'unknown';
  readonly activeJobs: number;
  readonly failedJobs: number;
  readonly confirmedSignals: number;
  readonly reputationSnapshot: Readonly<Record<string, unknown>>;
}

export type StateMachineJobStatus =
  | 'detected'
  | 'matched'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'ignored'
  | 'dead_letter';

export interface StateMachineJobSubmission {
  readonly signalIndex: number;
  readonly attempt: number;
  readonly dryRun?: boolean;
  readonly txHash?: Hex;
  readonly request?: SubmitStateMachineSignalCall;
  readonly error?: ClassifiedExecutorKitError;
}

export interface StateMachineWatcherJob {
  readonly id: Hex;
  readonly eventId: Hex;
  readonly stateMachineAddress?: Address;
  readonly orderId: Hex;
  readonly planId?: Hex;
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly stageIdentifier?: string;
  readonly hookName?: string;
  readonly supplierId?: string;
  readonly status: StateMachineJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly detectedAt: string;
  readonly updatedAt: string;
  readonly matchedKey?: string;
  readonly submissions: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  readonly manualActions?: readonly StateMachineJobManualAction[];
  readonly raw?: StateMachineRawLog;
}

export interface StateMachineJobManualAction {
  readonly action: 'retry' | 'dead_letter';
  readonly operator: string;
  readonly at: string;
  readonly reason?: string;
}

export interface StateMachineJobStore {
  upsertDetected(event: StateMachineHookReady, options: {
    readonly now: string;
    readonly maxAttempts: number;
    readonly supplierId?: string;
  }): Promise<StateMachineWatcherJob>;
  update(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob | undefined>;
  get(jobId: Hex): Promise<StateMachineWatcherJob | undefined>;
  list(): Promise<readonly StateMachineWatcherJob[]>;
}

export interface StateMachineJobPatch {
  readonly status?: StateMachineJobStatus;
  readonly updatedAt: string;
  readonly attempts?: number;
  readonly matchedKey?: string;
  readonly submissions?: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  readonly clearLastError?: boolean;
  readonly manualActions?: readonly StateMachineJobManualAction[];
}

export class InMemoryStateMachineJobStore implements StateMachineJobStore {
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
    const { lastError: currentLastError, ...currentWithoutLastError } = current;
    const next: StateMachineWatcherJob = {
      ...currentWithoutLastError,
      ...(patch.status ? { status: patch.status } : {}),
      updatedAt: patch.updatedAt,
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.matchedKey !== undefined ? { matchedKey: patch.matchedKey } : {}),
      ...(patch.submissions ? { submissions: patch.submissions } : {}),
      ...(patch.clearLastError ? {} : currentLastError ? { lastError: currentLastError } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.manualActions ? { manualActions: patch.manualActions } : {}),
    };
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

export class FileStateMachineJobStore implements StateMachineJobStore {
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
  }

  async update(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob | undefined> {
    const jobs = await readStateMachineJobsFile(this.filePath);
    const current = jobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const { lastError: currentLastError, ...currentWithoutLastError } = current;
    const next: StateMachineWatcherJob = {
      ...currentWithoutLastError,
      ...(patch.status ? { status: patch.status } : {}),
      updatedAt: patch.updatedAt,
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.matchedKey !== undefined ? { matchedKey: patch.matchedKey } : {}),
      ...(patch.submissions ? { submissions: patch.submissions } : {}),
      ...(patch.clearLastError ? {} : currentLastError ? { lastError: currentLastError } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.manualActions ? { manualActions: patch.manualActions } : {}),
    };
    jobs.set(jobId, cloneJob(next));
    await writeStateMachineJobsFile(this.filePath, jobs);
    return next;
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

export class StateMachineWatcher {
  readonly config: NormalizedStateMachineWatcherConfig;
  private nextBlock: bigint | undefined;

  constructor(config: StateMachineWatcherConfig) {
    this.config = normalizeStateMachineWatcherConfig(config);
    this.nextBlock = this.config.fromBlock;
  }

  describe(): Record<string, unknown> {
    return {
      rpcUrl: this.config.rpcUrl,
      stateMachineAddress: this.config.stateMachineAddress,
      stateMachines: this.config.stateMachines,
      chainId: this.config.chainId,
      supplierId: this.config.supplierId,
      walletAddress: this.config.walletAddress,
      privateKeyEnv: this.config.privateKeyEnv,
      fromBlock: this.config.fromBlock?.toString(),
      nextBlock: this.nextBlock?.toString(),
      pollIntervalMs: this.config.pollIntervalMs,
      handlerKeys: Object.keys(this.config.handlers),
      dryRun: this.config.dryRun,
      retry: this.config.retry,
    };
  }

  async pollOnce(): Promise<StateMachinePollResult> {
    const client = getPublicClient(this.config);
    await ensureChainId(client, this.config.chainId);

    const toBlock = await client.getBlockNumber();
    const fromBlock = this.nextBlock ?? this.config.fromBlock ?? toBlock;
    if (fromBlock > toBlock) {
      return {
        fromBlock,
        toBlock,
        scannedLogs: 0,
        results: [],
      };
    }

    const logBatches = await Promise.all(
      this.config.stateMachines.map(async (deployment) => {
        const logs = await client.getLogs({
          address: deployment.stateMachineAddress,
          fromBlock,
          toBlock,
        });
        return logs.map((log) => log.address ? log : { ...log, address: deployment.stateMachineAddress });
      }),
    );
    const logs = logBatches.flat().sort(compareRawLogs);
    const results: StateMachineLogProcessResult[] = [];
    for (const log of logs) {
      try {
        results.push(await this.handleLog(log));
      } catch (error) {
        results.push({
          status: 'skipped',
          submissions: [],
          error: classifyExecutorKitError(error),
        });
      }
    }
    this.nextBlock = toBlock + 1n;

    return {
      fromBlock,
      toBlock,
      scannedLogs: logs.length,
      results,
    };
  }

  async handleLog(log: StateMachineRawLog): Promise<StateMachineLogProcessResult> {
    const event = decodeHookReadyLog(log, this.config.artifact);
    if (!event) {
      return {
        status: 'skipped',
        submissions: [],
      };
    }

    const detectedAt = this.config.now();
    const job = await this.config.jobStore.upsertDetected(event, {
      now: detectedAt,
      maxAttempts: this.config.retry.maxAttempts,
      ...(this.config.supplierId ? { supplierId: this.config.supplierId } : {}),
    });
    if (isTerminalJobStatus(job.status)) {
      return {
        status: 'ignored',
        event,
        submissions: [],
        job,
      };
    }

    const resolved = resolveStateMachineHandler(this.config.handlers, event);
    if (!resolved) {
      const error = classifyExecutorKitError(
        new Error(`no state machine handler for ${event.stageIdentifier && event.hookName ? `${event.stageIdentifier}#${event.hookName}` : event.hookId}`),
        'missing_handler',
      );
      const ignored = await this.updateJob(job.id, {
        status: 'ignored',
        updatedAt: this.config.now(),
        lastError: error,
      });
      return {
        status: 'ignored',
        event,
        submissions: [],
        job: ignored,
        error,
      };
    }

    let currentJob = await this.updateJob(job.id, {
      status: 'matched',
      updatedAt: this.config.now(),
      matchedKey: resolved.key,
    });
    let attempts = currentJob.attempts;
    const jobSubmissions: StateMachineJobSubmission[] = [...currentJob.submissions];
    const submitSignalWithJobRetry = async (
      signal: StateMachineSignal,
      signalIndex: number,
    ): Promise<SubmitStateMachineSignalResult> => {
      let lastError: ClassifiedExecutorKitError | undefined;
      for (let attemptForSignal = 1; attemptForSignal <= this.config.retry.maxAttempts; attemptForSignal += 1) {
        attempts += 1;
        try {
          const result = await submitStateMachineSignal({
            ...this.config,
            stateMachineAddress: event.stateMachineAddress ?? this.config.stateMachineAddress,
          }, signal);
          jobSubmissions.push(toJobSubmission(signalIndex, attempts, result));
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            attempts,
            submissions: jobSubmissions,
          });
          return result;
        } catch (error) {
          const classified = classifyExecutorKitError(error);
          lastError = classified;
          jobSubmissions.push({
            signalIndex,
            attempt: attempts,
            error: classified,
          });
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            attempts,
            submissions: jobSubmissions,
            lastError: classified,
          });
          if (!classified.retryable || attemptForSignal >= this.config.retry.maxAttempts) {
            throw new ClassifiedStateMachineError(classified);
          }
          await delay(this.config.retry.baseDelayMs * attemptForSignal);
        }
      }

      throw new ClassifiedStateMachineError(lastError ?? classifyExecutorKitError(new Error('submission failed')));
    };

    const context: StateMachineHookReadyHandlerContext = {
      matchedKey: resolved.key,
      submitSignal: (signal, overrides) => submitStateMachineSignal({
        ...this.config,
        stateMachineAddress: event.stateMachineAddress ?? this.config.stateMachineAddress,
        ...overrides,
      }, signal),
    };
    let handlerResult: StateMachineHookReadyHandlerResult = undefined;
    for (let attemptForHandler = 1; attemptForHandler <= this.config.retry.maxAttempts; attemptForHandler += 1) {
      attempts += 1;
      try {
        handlerResult = await resolved.handler(event, context);
        currentJob = await this.updateJob(job.id, {
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
        });
        break;
      } catch (error) {
        const classified = classifyExecutorKitError(error, 'handler_failure');
        currentJob = await this.updateJob(job.id, {
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        if (classified.retryable && attemptForHandler < this.config.retry.maxAttempts) {
          await delay(this.config.retry.baseDelayMs * attemptForHandler);
          continue;
        }
        const failed = await this.updateJob(job.id, {
          status: jobStatusForError(classified),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: 'handled',
          event,
          matchedKey: resolved.key,
          submissions: [],
          job: failed,
          error: classified,
        };
      }
    }

    const submissions = [];
    const signals = normalizeHandlerResult(handlerResult);
    for (const [index, signal] of signals.entries()) {
      try {
        submissions.push(await submitSignalWithJobRetry({
          ...signal,
          readyEventId: signal.readyEventId ?? event.eventId,
        }, index));
      } catch (error) {
        const classified = error instanceof ClassifiedStateMachineError
          ? error.classified
          : classifyExecutorKitError(error);
        const failed = await this.updateJob(job.id, {
          status: jobStatusForError(classified),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: classified.kind === 'duplicate_signal' ? 'ignored' : 'handled',
          event,
          matchedKey: resolved.key,
          submissions,
          job: failed,
          error: classified,
        };
      }
    }

    const finalStatus = statusForSuccessfulSubmissions(submissions, this.config.dryRun);
    currentJob = await this.updateJob(job.id, {
      status: finalStatus,
      updatedAt: this.config.now(),
      attempts,
      submissions: jobSubmissions,
    });

    return {
      status: 'handled',
      event,
      matchedKey: resolved.key,
      submissions,
      job: currentJob,
    };
  }

  async start(): Promise<StateMachineWatchHandle> {
    const run = async (): Promise<void> => {
      const result = await this.pollOnce();
      this.config.onPoll?.(result);
    };
    await run();
    let running = false;
    const tick = (): void => {
      if (running) {
        return;
      }
      running = true;
      void run()
        .catch((error: unknown) => {
          this.config.onError?.(error);
        })
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(tick, this.config.pollIntervalMs);

    return {
      stop(): void {
        clearInterval(timer);
      },
    };
  }

  private async updateJob(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob> {
    const updated = await this.config.jobStore.update(jobId, patch);
    if (!updated) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return updated;
  }
}

export function createStateMachineWatcher(config: StateMachineWatcherConfig): StateMachineWatcher {
  return new StateMachineWatcher(config);
}

export interface StateMachineJobRetryOptions {
  readonly operator: string;
  readonly reason?: string;
  readonly now?: () => string;
}

export interface StateMachineJobDeadLetterOptions {
  readonly operator: string;
  readonly reason: string;
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

  if (job.attempts >= job.maxAttempts) {
    const error = classifyExecutorKitError(
      new Error(`retry limit reached for job ${normalizedJobId}: ${job.attempts}/${job.maxAttempts}`),
    );
    const deadLetter = await watcher.config.jobStore.update(normalizedJobId, {
      status: 'dead_letter',
      updatedAt: at,
      manualActions,
      lastError: error,
    });
    if (!deadLetter) {
      throw new ValidationError(`job ${normalizedJobId} not found`);
    }
    return {
      status: 'ignored',
      submissions: [],
      job: deadLetter,
      error,
    };
  }

  await watcher.config.jobStore.update(normalizedJobId, {
    status: 'detected',
    updatedAt: at,
    manualActions,
    clearLastError: true,
  });
  return watcher.handleLog(job.raw);
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
  });
  if (!updated) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  return updated;
}

export function stateMachineJobToExecutorJobDTO(job: StateMachineWatcherJob): ExecutorJobDTO {
  const txHash = latestSubmissionTxHash(job.submissions);
  return {
    jobId: job.id,
    orderId: job.orderId,
    ...(job.stateMachineAddress ? { stateMachineAddress: job.stateMachineAddress } : {}),
    ...(job.planId ? { planId: job.planId } : {}),
    hookId: job.hookId,
    ...(job.stageIdentifier ? { stageIdentifier: job.stageIdentifier } : {}),
    ...(job.hookName ? { hookName: job.hookName } : {}),
    ...(job.supplierId ? { supplierId: job.supplierId } : {}),
    status: stateMachineJobStatusToExecutorStatus(job.status),
    attempts: job.attempts,
    ...(job.lastError ? { lastError: job.lastError } : {}),
    ...(txHash ? { txHash } : {}),
    createdAt: job.detectedAt,
    updatedAt: job.updatedAt,
  };
}

export function stateMachineHandlerConfigToExecutorConfigDTO(config: StateMachineHandlerConfig): ExecutorConfigDTO {
  const signals = Object.values(config.handlers)
    .flatMap((handler) => handler.signals)
    .map((signal) => signal.signalName && signal.stageIdentifier && !signal.signalName.includes('.')
      ? `${signal.stageIdentifier}.${signal.signalName}`
      : signal.signalName ?? signal.signalId ?? 'unknown');
  const stages = dedupe([
    ...(config.stages ?? []),
    ...Object.entries(config.handlers).flatMap(([key, handler]) => [
      ...stageCapabilitiesFromHandlerKey(key),
      ...handler.signals.flatMap((signal) => signal.stageIdentifier ? [signal.stageIdentifier] : []),
    ]),
  ]);

  return {
    ...(config.supplierId ?? config.executorId ? { supplierId: config.supplierId ?? config.executorId } : {}),
    ...(config.walletAddress ? { walletAddress: config.walletAddress } : {}),
    ...(config.chainId ? { chainId: config.chainId } : {}),
    ...(config.stateMachineAddress ? { stateMachineAddress: config.stateMachineAddress } : {}),
    ...(config.stateMachines ? { stateMachines: config.stateMachines.map((deployment) => normalizeStateMachineDeploymentConfig(deployment)) } : {}),
    ...(config.chainServicesUrl ? { chainServicesUrl: config.chainServicesUrl } : {}),
    stages,
    signals: dedupe(signals),
    callbackMode: config.callbackMode ?? 'auto',
    dryRun: config.dryRun ?? false,
    ...(config.authTokenRef ? { authTokenRef: config.authTokenRef } : {}),
  };
}

export function summarizeSupplierOps(
  config: Pick<StateMachineHandlerConfig, 'supplierId' | 'executorId' | 'walletAddress'>,
  jobs: readonly StateMachineWatcherJob[],
): SupplierOpsSummaryDTO {
  const supplierId = config.supplierId ?? config.executorId ?? 'unknown-supplier';
  return {
    supplierId,
    ...(config.walletAddress ? { walletAddress: config.walletAddress } : {}),
    attestationStatus: 'not_checked',
    activeJobs: jobs.filter((job) => ['detected', 'matched', 'submitted'].includes(job.status)).length,
    failedJobs: jobs.filter((job) => ['failed', 'dead_letter', 'ignored'].includes(job.status)).length,
    confirmedSignals: jobs.filter((job) => job.status === 'confirmed').length,
    reputationSnapshot: {
      source: 'local-job-store',
      status: 'not_available',
    },
  };
}

export function stateMachineJobId(event: Pick<StateMachineHookReady, 'orderId' | 'hookId' | 'eventId' | 'stateMachineAddress'>): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [event.stateMachineAddress ?? ZERO_ADDRESS, event.orderId, event.hookId, event.eventId],
  ));
}

export function decodeHookReadyLog(
  log: StateMachineRawLog,
  artifact?: StateMachineArtifactIndex,
): StateMachineHookReady | undefined {
  if (log.topics[0] !== HOOK_READY_TOPIC) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = decodeEventLog({
      abi: STATE_MACHINE_ABI,
      eventName: 'HookReady',
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch {
    return undefined;
  }

  const args = (decoded as { readonly args?: unknown }).args as {
    readonly orderId?: unknown;
    readonly hookId?: unknown;
    readonly stageId?: unknown;
    readonly hookName?: unknown;
  };
  const blockNumber = log.blockNumber ?? undefined;
  const transactionHash = log.transactionHash ?? undefined;
  const logIndex = normalizeLogIndex(log.logIndex);
  const hookId = normalizeBytes32(asString(args.hookId, 'hookId'), 'hookId');
  const metadata = artifact?.hooksByHookId?.[hookId];
  const stateMachineAddress = log.address ? normalizeAddress(log.address, 'log.address') : undefined;

  return {
    type: 'HookReady',
    eventId: hookReadyEventId(log),
    ...(stateMachineAddress ? { stateMachineAddress } : {}),
    orderId: normalizeBytes32(asString(args.orderId, 'orderId'), 'orderId'),
    hookId,
    stageId: normalizeBytes32(asString(args.stageId, 'stageId'), 'stageId'),
    hookNameId: normalizeBytes32(asString(args.hookName, 'hookName'), 'hookName'),
    ...(metadata?.stageIdentifier ? { stageIdentifier: metadata.stageIdentifier } : {}),
    ...(metadata?.hookName ? { hookName: metadata.hookName } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(transactionHash ? { transactionHash } : {}),
    ...(logIndex !== undefined ? { logIndex } : {}),
    raw: log,
  };
}

export function hookReadyEventId(log: Pick<StateMachineRawLog, 'transactionHash' | 'logIndex'>): Hex {
  const txHash = log.transactionHash ? normalizeBytes32(log.transactionHash, 'transactionHash') : ZERO_BYTES32;
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256' },
    ],
    [txHash, normalizeLogIndex(log.logIndex) ?? 0n],
  ));
}

export function getStateMachineHandlerKeys(event: StateMachineHookReady): readonly string[] {
  const textKeys = event.stageIdentifier && event.hookName
    ? [
        `${event.stageIdentifier}#${event.hookName}`,
        event.stageIdentifier,
      ]
    : [];
  return dedupe([
    ...textKeys,
    event.hookId,
    event.stageId,
    '*',
  ]);
}

export function resolveStateMachineHandler(
  handlers: Readonly<Record<string, StateMachineHookReadyHandler>>,
  event: StateMachineHookReady,
): { readonly key: string; readonly handler: StateMachineHookReadyHandler } | undefined {
  for (const key of getStateMachineHandlerKeys(event)) {
    const handler = handlers[key];
    if (handler) {
      return { key, handler };
    }
  }
  return undefined;
}

export function buildSubmitStateMachineSignalCall(
  config: SubmitStateMachineSignalConfig,
  signal: StateMachineSignal,
  from?: Address,
): SubmitStateMachineSignalCall {
  const normalizedConfig = normalizeSubmitConfig(config);
  const args = normalizeStateMachineSignal(signal);
  const request = {
    address: normalizedConfig.stateMachineAddress,
    abi: STATE_MACHINE_ABI,
    functionName: 'submitSignal',
    args: [args.orderId, args.sourceId, args.signalId, args.payloadHash, args.idempotencyKey],
    data: encodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      args: [args.orderId, args.sourceId, args.signalId, args.payloadHash, args.idempotencyKey],
    }),
    chainId: normalizedConfig.chainId,
    ...(from ? { from } : {}),
  } as const;
  return request;
}

export async function submitStateMachineSignal(
  config: SubmitStateMachineSignalConfig,
  signal: StateMachineSignal,
): Promise<SubmitStateMachineSignalResult> {
  const normalizedConfig = normalizeSubmitConfig(config);

  if (normalizedConfig.dryRun) {
    const from = resolveConfiguredWalletAddress(normalizedConfig);
    if (!from) {
      throw new ValidationError(
        `dry-run requires walletAddress or a private key env var in ${normalizedConfig.privateKeyEnv} so the from address can be shown`,
      );
    }
    const request = buildSubmitStateMachineSignalCall(normalizedConfig, signal, from);
    return {
      dryRun: true,
      request,
    };
  }

  const privateKey = loadPrivateKeyFromEnv(normalizedConfig.privateKeyEnv);
  if (!privateKey) {
    throw new ValidationError(`missing private key env var ${normalizedConfig.privateKeyEnv}`);
  }

  const client = getPublicClient(normalizedConfig);
  await ensureChainId(client, normalizedConfig.chainId);

  const account = privateKeyToAccount(privateKey);
  if (normalizedConfig.walletAddress && normalizedConfig.walletAddress !== account.address) {
    throw new ValidationError(`walletAddress ${normalizedConfig.walletAddress} does not match ${normalizedConfig.privateKeyEnv} address ${account.address}`);
  }
  const requestWithFrom = buildSubmitStateMachineSignalCall(normalizedConfig, signal, account.address);
  const wallet = createWalletClient({
    account,
    chain: buildChain(normalizedConfig.chainId, normalizedConfig.rpcUrl),
    transport: http(normalizedConfig.rpcUrl),
  });
  const txHash = await wallet.writeContract({
    address: requestWithFrom.address,
    abi: requestWithFrom.abi,
    functionName: requestWithFrom.functionName,
    args: requestWithFrom.args,
  });
  let confirmed: boolean | undefined;
  if (normalizedConfig.waitForReceipt && client.waitForTransactionReceipt) {
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status && receipt.status !== 'success') {
      throw new Error(`submitSignal transaction receipt status ${receipt.status}`);
    }
    confirmed = receipt.status === 'success';
  }

  return {
    dryRun: false,
    request: requestWithFrom,
    txHash,
    ...(confirmed !== undefined ? { confirmed } : {}),
  };
}

export async function loadStateMachineHandlerConfig(filePath: string): Promise<StateMachineHandlerConfig> {
  if (!filePath || filePath.trim().length === 0) {
    throw new ValidationError('config path is required');
  }
  const raw = await readFile(filePath, 'utf8');
  return normalizeStateMachineHandlerConfig(JSON.parse(raw) as unknown);
}

export function createStateMachineHandlersFromConfig(
  config: StateMachineHandlerConfig,
): Readonly<Record<string, StateMachineHookReadyHandler>> {
  return Object.fromEntries(
    Object.entries(config.handlers).map(([key, handler]) => [
      key,
      (event: StateMachineHookReady) => handler.signals.map((signal) => ({
        orderId: event.orderId,
        ...signal,
        payloadHash: signal.payloadHash ?? ZERO_BYTES32,
        readyEventId: signal.readyEventId ?? event.eventId,
        idempotencyKey: signal.idempotencyKey ?? `${event.orderId}:${event.hookId}:${signal.signalName ?? signal.signalId}`,
      })),
    ]),
  );
}

interface NormalizedSubmitConfig extends SubmitStateMachineSignalConfig {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly walletAddress?: Address;
  readonly privateKeyEnv: string;
  readonly dryRun: boolean;
  readonly waitForReceipt: boolean;
}

interface NormalizedStateMachineWatcherConfig extends NormalizedSubmitConfig {
  readonly supplierId?: string;
  readonly stateMachines: readonly NormalizedStateMachineDeploymentWatcherConfig[];
  readonly handlers: Readonly<Record<string, StateMachineHookReadyHandler>>;
  readonly artifact?: StateMachineArtifactIndex;
  readonly fromBlock?: bigint;
  readonly pollIntervalMs: number;
  readonly retry: NormalizedStateMachineRetryConfig;
  readonly jobStore: StateMachineJobStore;
  readonly now: () => string;
  readonly onPoll?: (result: StateMachinePollResult) => void;
  readonly onError?: (error: unknown) => void;
}

interface NormalizedStateMachineDeploymentWatcherConfig {
  readonly stateMachineAddress: Address;
  readonly deploymentId?: Hex;
  readonly status?: 'active' | 'deprecated' | 'canary' | 'candidate' | 'retired';
}

interface NormalizedStateMachineRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

function normalizeStateMachineWatcherConfig(config: StateMachineWatcherConfig): NormalizedStateMachineWatcherConfig {
  const stateMachines = normalizeStateMachineDeployments(config);
  const defaultStateMachineAddress = config.stateMachineAddress ?? stateMachines[0]?.stateMachineAddress;
  if (!defaultStateMachineAddress) {
    throw new ValidationError('state machine watcher requires stateMachineAddress or stateMachines[]');
  }
  const normalized = normalizeSubmitConfig({
    ...config,
    stateMachineAddress: defaultStateMachineAddress,
  });
  return {
    ...normalized,
    ...(config.supplierId ? { supplierId: asNonEmptyString(config.supplierId, 'supplierId') } : {}),
    stateMachines,
    handlers: config.handlers,
    ...(config.artifact ? { artifact: normalizeArtifactIndex(config.artifact) } : {}),
    ...(config.fromBlock !== undefined ? { fromBlock: parseBigNumberish(config.fromBlock, 'fromBlock') } : {}),
    pollIntervalMs: config.pollIntervalMs !== undefined
      ? parsePositiveInteger(config.pollIntervalMs, 'pollIntervalMs')
      : DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS,
    retry: normalizeRetryConfig(config.retry),
    jobStore: config.jobStore ?? new InMemoryStateMachineJobStore(),
    now: config.now ?? (() => new Date().toISOString()),
    ...(config.onPoll ? { onPoll: config.onPoll } : {}),
    ...(config.onError ? { onError: config.onError } : {}),
  };
}

function normalizeSubmitConfig(config: SubmitStateMachineSignalConfig): NormalizedSubmitConfig {
  if (!config.stateMachineAddress) {
    throw new ValidationError('stateMachineAddress is required');
  }
  return {
    rpcUrl: config.rpcUrl,
    stateMachineAddress: normalizeAddress(config.stateMachineAddress, 'stateMachineAddress'),
    chainId: parsePositiveInteger(config.chainId, 'chainId'),
    ...(config.walletAddress ? { walletAddress: normalizeAddress(config.walletAddress, 'walletAddress') } : {}),
    privateKeyEnv: config.privateKeyEnv ?? DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
    dryRun: config.dryRun ?? false,
    waitForReceipt: config.waitForReceipt ?? false,
    ...(config.publicClient ? { publicClient: config.publicClient } : {}),
  };
}

function normalizeStateMachineDeployments(
  config: Pick<StateMachineWatcherConfig, 'stateMachineAddress' | 'stateMachines'>,
): readonly NormalizedStateMachineDeploymentWatcherConfig[] {
  const rawDeployments = config.stateMachines?.length
    ? config.stateMachines
    : config.stateMachineAddress
      ? [{ stateMachineAddress: config.stateMachineAddress }]
      : [];
  if (rawDeployments.length === 0) {
    throw new ValidationError('state machine watcher requires stateMachineAddress or stateMachines[]');
  }
  const seen = new Set<string>();
  const deployments: NormalizedStateMachineDeploymentWatcherConfig[] = [];
  for (const [index, deployment] of rawDeployments.entries()) {
    const normalized = normalizeStateMachineDeploymentConfig(deployment, `stateMachines[${index}]`);
    if (normalized.status === 'retired') {
      continue;
    }
    const key = normalized.stateMachineAddress.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deployments.push(normalized);
  }
  if (deployments.length === 0) {
    throw new ValidationError('state machine watcher requires at least one non-retired state machine deployment');
  }
  return deployments;
}

function normalizeStateMachineDeploymentConfig(
  deployment: StateMachineDeploymentWatcherConfig,
  path = 'stateMachine',
): NormalizedStateMachineDeploymentWatcherConfig {
  const status = deployment.status;
  if (status && !['active', 'deprecated', 'canary', 'candidate', 'retired'].includes(status)) {
    throw new ValidationError(`${path}.status must be active, deprecated, canary, candidate, or retired`);
  }
  return {
    stateMachineAddress: normalizeAddress(deployment.stateMachineAddress, `${path}.stateMachineAddress`),
    ...(deployment.deploymentId ? { deploymentId: normalizeBytes32(deployment.deploymentId, `${path}.deploymentId`) } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeRetryConfig(config: StateMachineRetryConfig | Record<string, unknown> | undefined): NormalizedStateMachineRetryConfig {
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

function normalizeStateMachineSignal(signal: StateMachineSignal): StateMachineSignalCallArgs {
  const orderId = normalizeBytes32(signal.orderId, 'orderId');
  const payloadHash = signal.payloadHash ? normalizeBytes32(signal.payloadHash, 'payloadHash') : ZERO_BYTES32;
  const sourceId = signal.sourceId
    ? normalizeBytes32(signal.sourceId, 'sourceId')
    : hashText(signal.source ?? '', 'source');
  const signalName = signal.signalName && signal.stageIdentifier && !signal.signalName.includes('.')
    ? `${signal.stageIdentifier}.${signal.signalName}`
    : signal.signalName;
  const signalId = signal.signalId
    ? normalizeBytes32(signal.signalId, 'signalId')
    : hashText(asNonEmptyString(signalName, 'signalName'), 'signalName');

  return {
    orderId,
    sourceId,
    signalId,
    payloadHash,
    idempotencyKey: signal.idempotencyKey
      ? hashText(signal.idempotencyKey, 'idempotencyKey')
      : hashText(`${orderId}:${sourceId}:${signalId}:${signal.readyEventId ?? ZERO_BYTES32}`, 'idempotencyKey'),
  };
}

function normalizeStateMachineHandlerConfig(value: unknown): StateMachineHandlerConfig {
  if (!isRecord(value) || !isRecord(value.handlers)) {
    throw new ValidationError('state machine handler config must be an object with handlers');
  }
  const handlers = Object.entries(value.handlers);
  if (handlers.length === 0) {
    throw new ValidationError('state machine handler config must include at least one handler');
  }

  return {
    ...(typeof value.supplierId === 'string' ? { supplierId: asNonEmptyString(value.supplierId, 'supplierId') } : {}),
    ...(typeof value.executorId === 'string' ? { executorId: asNonEmptyString(value.executorId, 'executorId') } : {}),
    ...(typeof value.walletAddress === 'string' ? { walletAddress: normalizeAddress(value.walletAddress, 'walletAddress') } : {}),
    ...(value.chainId !== undefined ? { chainId: parsePositiveInteger(asNumberOrString(value.chainId, 'chainId'), 'chainId') } : {}),
    ...(typeof value.stateMachineAddress === 'string'
      ? { stateMachineAddress: normalizeAddress(value.stateMachineAddress, 'stateMachineAddress') }
      : {}),
    ...(Array.isArray(value.stateMachines)
      ? { stateMachines: value.stateMachines.map((deployment, index) => normalizeRawStateMachineDeploymentConfig(deployment, `stateMachines[${index}]`)) }
      : {}),
    ...(typeof value.chainServicesUrl === 'string' ? { chainServicesUrl: asNonEmptyString(value.chainServicesUrl, 'chainServicesUrl') } : {}),
    ...(Array.isArray(value.stages) ? { stages: value.stages.map((stage, index) => asNonEmptyString(stage, `stages[${index}]`)) } : {}),
    ...(typeof value.callbackMode === 'string' ? { callbackMode: normalizeCallbackMode(value.callbackMode) } : {}),
    ...(typeof value.dryRun === 'boolean' ? { dryRun: value.dryRun } : {}),
    ...(typeof value.authTokenRef === 'string' ? { authTokenRef: asNonEmptyString(value.authTokenRef, 'authTokenRef') } : {}),
    ...(isRecord(value.artifact) ? { artifact: normalizeArtifactIndex(value.artifact) } : {}),
    ...(isRecord(value.retry) ? { retry: normalizeRetryConfig(value.retry) } : {}),
    handlers: Object.fromEntries(
      handlers.map(([key, handler]) => [
        key,
        normalizeStaticHandlerDefinition(handler, `handlers.${key}`),
      ]),
    ),
  };
}

function normalizeStaticHandlerDefinition(value: unknown, path: string): StateMachineStaticHandlerDefinition {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object`);
  }

  return {
    signals: Array.isArray(value.signals)
      ? value.signals.map((signal, index) => normalizeStaticSignalDefinition(signal, `${path}.signals[${index}]`))
      : [normalizeStaticSignalDefinition(value, path)],
  };
}

function normalizeRawStateMachineDeploymentConfig(value: unknown, path: string): StateMachineDeploymentWatcherConfig {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  if (typeof value.stateMachineAddress !== 'string') {
    throw new ValidationError(`${path}.stateMachineAddress is required`);
  }
  const status = typeof value.status === 'string' ? value.status : undefined;
  if (status && !['active', 'deprecated', 'canary', 'candidate', 'retired'].includes(status)) {
    throw new ValidationError(`${path}.status must be active, deprecated, canary, candidate, or retired`);
  }
  const normalized: StateMachineDeploymentWatcherConfig = {
    stateMachineAddress: normalizeAddress(value.stateMachineAddress, `${path}.stateMachineAddress`),
  };
  if (typeof value.deploymentId === 'string') {
    (normalized as { deploymentId?: Hex }).deploymentId = normalizeBytes32(value.deploymentId, `${path}.deploymentId`);
  }
  if (status) {
    (normalized as { status?: StateMachineDeploymentWatcherConfig['status'] }).status =
      status as StateMachineDeploymentWatcherConfig['status'];
  }
  return normalized;
}

function normalizeStaticSignalDefinition(value: unknown, path: string): StateMachineStaticSignalDefinition {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  const hasTextIds = typeof value.source === 'string' && typeof value.signalName === 'string';
  const hasHashIds = typeof value.sourceId === 'string' && typeof value.signalId === 'string';
  if (!hasTextIds && !hasHashIds) {
    throw new ValidationError(`${path} must include source/signalName or sourceId/signalId`);
  }
  if (hasTextIds && typeof value.signalName === 'string' && !value.signalName.includes('.') && typeof value.stageIdentifier !== 'string') {
    throw new ValidationError(`${path}.stageIdentifier is required when signalName is not fully qualified`);
  }
  if (
    hasTextIds
    && typeof value.stageIdentifier === 'string'
    && typeof value.signalName === 'string'
    && value.signalName.includes('.')
    && !value.signalName.startsWith(`${value.stageIdentifier}.`)
  ) {
    throw new ValidationError(`${path}.signalName must belong to ${value.stageIdentifier}`);
  }

  return {
    ...(typeof value.source === 'string' ? { source: asNonEmptyString(value.source, `${path}.source`) } : {}),
    ...(typeof value.stageIdentifier === 'string' ? { stageIdentifier: asNonEmptyString(value.stageIdentifier, `${path}.stageIdentifier`) } : {}),
    ...(typeof value.signalName === 'string' ? { signalName: asNonEmptyString(value.signalName, `${path}.signalName`) } : {}),
    ...(typeof value.sourceId === 'string' ? { sourceId: normalizeBytes32(value.sourceId, `${path}.sourceId`) } : {}),
    ...(typeof value.signalId === 'string' ? { signalId: normalizeBytes32(value.signalId, `${path}.signalId`) } : {}),
    ...(typeof value.payloadHash === 'string' ? { payloadHash: normalizeBytes32(value.payloadHash, `${path}.payloadHash`) } : {}),
    ...(typeof value.readyEventId === 'string' ? { readyEventId: normalizeBytes32(value.readyEventId, `${path}.readyEventId`) } : {}),
    ...(typeof value.idempotencyKey === 'string' ? { idempotencyKey: value.idempotencyKey } : {}),
  };
}

function normalizeArtifactIndex(value: StateMachineArtifactIndex): StateMachineArtifactIndex {
  return {
    ...(value.hooksByHookId ? {
      hooksByHookId: Object.fromEntries(
        Object.entries(value.hooksByHookId).map(([hookId, metadata]) => [
          normalizeBytes32(hookId, 'artifact.hookId'),
          {
            stageIdentifier: asNonEmptyString(metadata.stageIdentifier, 'artifact.stageIdentifier'),
            hookName: asNonEmptyString(metadata.hookName, 'artifact.hookName'),
          },
        ]),
      ),
    } : {}),
    ...(value.signals ? {
      signals: Object.fromEntries(
        Object.entries(value.signals).map(([key, signal]) => [
          key,
          {
            sourceId: normalizeBytes32(signal.sourceId, `${key}.sourceId`),
            signalId: normalizeBytes32(signal.signalId, `${key}.signalId`),
          },
        ]),
      ),
    } : {}),
  };
}

function getPublicClient(config: Pick<NormalizedSubmitConfig, 'chainId' | 'rpcUrl' | 'publicClient'>): StateMachinePublicClient {
  if (config.publicClient) {
    return config.publicClient;
  }
  return createPublicClient({
    chain: buildChain(config.chainId, config.rpcUrl),
    transport: http(config.rpcUrl),
  }) as unknown as StateMachinePublicClient;
}

function resolveConfiguredWalletAddress(config: Pick<NormalizedSubmitConfig, 'walletAddress' | 'privateKeyEnv'>): Address | undefined {
  if (config.walletAddress) {
    return config.walletAddress;
  }
  const privateKey = loadPrivateKeyFromEnv(config.privateKeyEnv);
  return privateKey ? privateKeyToAccount(privateKey).address : undefined;
}

async function ensureChainId(client: StateMachinePublicClient, expectedChainId: number): Promise<void> {
  const actualChainId = await client.getChainId();
  if (actualChainId !== expectedChainId) {
    throw new ValidationError(`wrong chain id: got ${actualChainId}, expected ${expectedChainId}`);
  }
}

function buildChain(chainId: number, rpcUrl: string) {
  return {
    id: chainId,
    name: `uvp-${chainId}`,
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  } as const;
}

function normalizeHandlerResult(result: StateMachineHookReadyHandlerResult): readonly StateMachineSignal[] {
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result as readonly StateMachineSignal[] : [result as StateMachineSignal];
}

function toJobSubmission(
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
  };
}

function statusForSuccessfulSubmissions(
  submissions: readonly SubmitStateMachineSignalResult[],
  dryRun: boolean,
): StateMachineJobStatus {
  if (dryRun || submissions.length === 0) {
    return 'matched';
  }
  return submissions.every((submission) => !submission.dryRun && submission.confirmed) ? 'confirmed' : 'submitted';
}

function compareRawLogs(left: StateMachineRawLog, right: StateMachineRawLog): number {
  const leftBlock = left.blockNumber ?? 0n;
  const rightBlock = right.blockNumber ?? 0n;
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }
  const leftIndex = typeof left.logIndex === 'bigint' ? left.logIndex : BigInt(Number(left.logIndex ?? 0));
  const rightIndex = typeof right.logIndex === 'bigint' ? right.logIndex : BigInt(Number(right.logIndex ?? 0));
  if (leftIndex !== rightIndex) {
    return leftIndex < rightIndex ? -1 : 1;
  }
  return String(left.address ?? '').localeCompare(String(right.address ?? ''));
}

function jobStatusForError(error: ClassifiedExecutorKitError): StateMachineJobStatus {
  if (error.kind === 'missing_handler' || error.kind === 'duplicate_signal') {
    return 'ignored';
  }
  return error.retryable ? 'dead_letter' : 'failed';
}

function isTerminalJobStatus(status: StateMachineJobStatus): boolean {
  return status === 'submitted'
    || status === 'confirmed'
    || status === 'failed'
    || status === 'ignored'
    || status === 'dead_letter';
}

function isRetriableStateMachineJobStatus(status: StateMachineJobStatus): boolean {
  return status === 'failed' || status === 'matched';
}

function stateMachineJobStatusToExecutorStatus(status: StateMachineJobStatus): ExecutorJobStatusDTO {
  switch (status) {
    case 'detected':
      return 'queued';
    case 'matched':
      return 'callback_pending';
    case 'submitted':
      return 'submitted';
    case 'confirmed':
      return 'confirmed';
    case 'dead_letter':
      return 'dead_letter';
    case 'failed':
    case 'ignored':
      return 'failed';
  }
}

function latestSubmissionTxHash(submissions: readonly StateMachineJobSubmission[]): Hex | undefined {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const txHash = submissions[index]?.txHash;
    if (txHash) {
      return txHash;
    }
  }
  return undefined;
}

function appendManualAction(
  job: StateMachineWatcherJob,
  action: StateMachineJobManualAction,
): readonly StateMachineJobManualAction[] {
  return [...(job.manualActions ?? []), action];
}

function stageCapabilitiesFromHandlerKey(key: string): readonly string[] {
  if (key === '*') {
    return [];
  }
  const [stage] = key.split('#', 1);
  if (!stage || stage.startsWith('0x')) {
    return [];
  }
  return [stage];
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

async function writeStateMachineJobsFile(filePath: string, jobs: ReadonlyMap<Hex, StateMachineWatcherJob>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, jobs: [...jobs.values()] }, stateMachineJobJsonReplacer, 2)}\n`,
    'utf8',
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

function normalizeCallbackMode(value: string): ExecutorCallbackMode {
  if (value === 'manual' || value === 'auto' || value === 'webhook') {
    return value;
  }
  throw new ValidationError('callbackMode must be manual, auto, or webhook');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function cloneJob(job: StateMachineWatcherJob): StateMachineWatcherJob {
  return structuredClone(job) as StateMachineWatcherJob;
}

class ClassifiedStateMachineError extends Error {
  readonly classified: ClassifiedExecutorKitError;

  constructor(classified: ClassifiedExecutorKitError) {
    super(classified.message);
    this.name = 'ClassifiedStateMachineError';
    this.classified = classified;
  }
}

function normalizeLogIndex(value: number | bigint | null | undefined): bigint | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError('logIndex must be a non-negative safe integer');
  }
  return BigInt(value);
}

function parseNonNegativeSafeInteger(value: number | string, fieldName: string): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer string`);
  }

  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
  }
  return numberValue;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return value;
}

function asNumberOrString(value: unknown, fieldName: string): number | string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a number or string`);
  }
  return value;
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  const text = asString(value, fieldName).trim();
  if (text.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  return text;
}

function hashText(value: string, fieldName: string): Hex {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return keccak256(stringToBytes(value));
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
