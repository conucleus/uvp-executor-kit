import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
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
  ExecutorKitError,
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
/**
 * Finality buffer in blocks: the watcher only scans up to head - N so a
 * short reorg cannot flip already-processed logs (and their confirmed
 * submissions) out from under the cursor. Mirrors the chain-services
 * indexer's finalityConfirmations.
 */
export const DEFAULT_FINALITY_CONFIRMATIONS = 1;
/**
 * How many recent block-hash checkpoints the cursor keeps for the bounded
 * common-ancestor search when a reorg is detected past the finality buffer.
 */
export const DEFAULT_REORG_WINDOW_BLOCKS = 64;
/**
 * Max blocks per eth_getLogs request. Deep-lag catch-up rounds used to issue
 * one unbounded query that RPC providers reject outright, failing every round.
 * Mirrors the chain-services indexer span.
 */
export const DEFAULT_GET_LOGS_BLOCK_SPAN = 9_999;
/** Cap on the poll-delay multiplier during consecutive-failure backoff. */
export const POLL_FAILURE_BACKOFF_MULTIPLIER_CAP = 8;
/**
 * First wait before rebroadcasting a signal whose earlier broadcast was
 * never confirmed (job-level resend backoff base).
 */
export const DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS = 30_000;
/** Ceiling of the resend backoff so an unconfirmed signal cannot starve forever. */
export const DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS = 600_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const HOOK_READY_TOPIC = keccak256(stringToBytes('HookReady(bytes32,bytes32,bytes32,bytes32,bytes32)'));

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
  /** 订单级事件全部 plan-scoped。 */
  readonly planId: Hex;
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
  /**
   * The state machine ABI is plan-scoped, so every signal carries the
   * owning order's planId as the first submitSignal argument. The zero
   * placeholder is rejected before signing/broadcasting: it can never pass the
   * on-chain (planId, orderId) existence check.
   */
  readonly planId?: Hex | string;
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  /** Off-chain metadata only: the frozen submitSignal ABI cannot carry it on chain. */
  readonly payloadRef?: string;
  readonly readyEventId?: Hex | string;
  readonly idempotencyKey?: string;
}

export interface StateMachineSignalCallArgs {
  readonly planId: Hex;
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
  readonly args: readonly [Hex, Hex, Hex, Hex, Hex, Hex];
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
  /**
   * Resolves when the loop is stopped manually via stop(). The loop never
   * aborts on its own: persistent poll failures are reported through onError
   * and the poll cadence backs off exponentially (capped) so an RPC outage
   * degrades the watcher instead of killing it.
   */
  readonly done: Promise<void>;
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
  readonly resendBackoff?: StateMachineResendBackoffConfig;
  /** Monotonic wall clock (ms) driving the resend backoff; defaults to Date.now. */
  readonly nowMs?: () => number;
  /**
   * Finality buffer in blocks (default DEFAULT_FINALITY_CONFIRMATIONS): each
   * round scans only up to head - confirmations. 0 restores tip scanning for
   * throwaway local chains.
   */
  readonly confirmations?: number | string;
  /**
   * Bounded reorg checkpoint window (default DEFAULT_REORG_WINDOW_BLOCKS):
   * recent scanned block hashes kept for the common-ancestor rollback when a
   * reorg slips past the finality buffer.
   */
  readonly reorgWindow?: number | string;
  /**
   * Max blocks per eth_getLogs request (default DEFAULT_GET_LOGS_BLOCK_SPAN);
   * larger scan ranges are chunked so deep-lag catch-up rounds do not trip
   * provider query limits.
   */
  readonly getLogsBlockSpan?: number | string;
  readonly jobStore?: StateMachineJobStore;
  /**
   * Optional durable store for the scan cursor (the next block to scan).
   * When configured, the watcher persists the cursor after every successful
   * round and restores it before the first poll, so a restart resumes instead
   * of rescanning from fromBlock. Without it the cursor stays in process memory.
   */
  readonly cursorStore?: StateMachineCursorStore;
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
  /**
   * Optional direct receipt lookup used by the replay guard: before a
   * retryable failure triggers a rebroadcast, the watcher checks whether the
   * already-broadcast transaction actually mined. Resolves null/undefined when
   * the receipt is not (yet) available.
   */
  getTransactionReceipt?(args: {
    readonly hash: Hex;
  }): Promise<{ readonly status?: 'success' | 'reverted' | string } | null | undefined>;
  /**
   * Optional canonical block lookup powering the reorg defenses: the genesis
   * hash binds the cursor identity to one chain, and per-round block hashes
   * anchor the cursor continuity check. Absent on a client, all hash-based
   * defenses degrade to the finality buffer alone.
   */
  getBlock?(args: {
    readonly blockNumber: bigint;
  }): Promise<{ readonly hash?: Hex | string }>;
}

export interface StateMachineLogProcessResult {
  readonly status: 'skipped' | 'ignored' | 'handled';
  readonly event?: StateMachineHookReady;
  readonly matchedKey?: string;
  readonly submissions: readonly SubmitStateMachineSignalResult[];
  readonly job?: StateMachineWatcherJob;
  readonly error?: ClassifiedExecutorKitError;
  /**
   * True when the log matched the HookReady topic but could not be decoded
   * (e.g. a mixed-ABI deployment). Such logs are skipped and recorded, never
   * fatal: the scan advances past them instead of rescanning them forever.
   */
  readonly decodeFailure?: boolean;
}

export interface StateMachinePollResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly scannedLogs: number;
  readonly results: readonly StateMachineLogProcessResult[];
  /** How many scanned logs in this round were skipped as decode failures. */
  readonly decodeFailures: number;
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
  /**
   * Optional explicit planId for the signal's order. When omitted (the normal
   * case) the planId decoded from the HookReady event is used: the plan-scoped
   * submitSignal ABI requires it, and config-driven handlers have no other
   * source of truth for it.
   */
  readonly planId?: Hex | string;
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
  /**
   * Wall-clock time of the last real signal attempt (broadcast outcome
   * known or not). The resend backoff anchors here — updatedAt also moves on
   * unrelated bookkeeping, which would restart the throttle every round.
   */
  readonly lastSignalAttemptAt?: string;
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
  /** Storage-mode label for diagnostics (`memory`, `file`, ...); optional so custom stores stay compatible. */
  readonly kind?: string;
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
  /** Records the order planId once it is known so retries can resubmit. */
  readonly planId?: Hex;
  readonly submissions?: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  readonly clearLastError?: boolean;
  readonly lastSignalAttemptAt?: string;
  readonly manualActions?: readonly StateMachineJobManualAction[];
}

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
    const { lastError: currentLastError, ...currentWithoutLastError } = current;
    const next: StateMachineWatcherJob = {
      ...currentWithoutLastError,
      ...(patch.status ? { status: patch.status } : {}),
      updatedAt: patch.updatedAt,
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.matchedKey !== undefined ? { matchedKey: patch.matchedKey } : {}),
      ...(patch.planId !== undefined ? { planId: patch.planId } : {}),
      ...(patch.submissions ? { submissions: patch.submissions } : {}),
      ...(patch.clearLastError ? {} : currentLastError ? { lastError: currentLastError } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.lastSignalAttemptAt !== undefined ? { lastSignalAttemptAt: patch.lastSignalAttemptAt } : {}),
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
      ...(patch.planId !== undefined ? { planId: patch.planId } : {}),
      ...(patch.submissions ? { submissions: patch.submissions } : {}),
      ...(patch.clearLastError ? {} : currentLastError ? { lastError: currentLastError } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.lastSignalAttemptAt !== undefined ? { lastSignalAttemptAt: patch.lastSignalAttemptAt } : {}),
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

/**
 * Identity of the scan position a cursor belongs to. A persisted cursor is only
 * restored when the watcher's chain id, state-machine set, and chain genesis
 * hash match, so reconfiguring the watcher or resetting the chain (e.g. a fresh
 * Anvil) can never resume from a foreign scan position.
 */
export interface StateMachineCursorContext {
  readonly chainId: number;
  /** Lowercase state-machine addresses, sorted; the watcher derives this from its config. */
  readonly stateMachines: readonly string[];
  /**
   * Canonical genesis (block-0) hash. Known only when the RPC client can read
   * blocks; a chain reset mints a different genesis even at the same chain id,
   * which is exactly the silent-drop case the identity must catch.
   */
  readonly genesisHash?: string;
}

/** A remembered (height, canonical hash) anchor inside the reorg window. */
export interface StateMachineCursorCheckpoint {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export type StateMachineCursorLoadResult =
  | {
    readonly status: 'restored';
    readonly nextBlock: bigint;
    /** Canonical hash of block nextBlock - 1, when the saving round could read it. */
    readonly blockHash?: string;
    readonly checkpoints?: readonly StateMachineCursorCheckpoint[];
  }
  | { readonly status: 'empty' }
  | { readonly status: 'foreign'; readonly reason: 'context' | 'genesis' };

export interface StateMachineCursorState {
  readonly nextBlock: bigint;
  readonly blockHash?: string;
  readonly checkpoints?: readonly StateMachineCursorCheckpoint[];
}

/**
 * Durable store for the watcher scan cursor (the next block to scan).
 * The job-store abstraction does not fit: jobs are keyed by bytes32 ids with
 * required event fields, while the cursor is a single block number bound to the
 * watcher identity above.
 */
export interface StateMachineCursorStore {
  /** Storage-mode label for diagnostics (`file`, ...); optional so custom stores stay compatible. */
  readonly kind?: string;
  /**
   * Resolve the persisted cursor for this context. `empty` when nothing usable
   * is stored; `foreign` when a cursor exists but belongs to another watcher
   * identity (the watcher alerts and starts fresh instead of silently adopting
   * it). Structurally invalid state is quarantined and reported as `empty`.
   */
  load(context: StateMachineCursorContext): Promise<StateMachineCursorLoadResult>;
  /** Persist the cursor after a successful scan round advanced past its toBlock. */
  save(state: StateMachineCursorState, context: StateMachineCursorContext): Promise<void>;
}

export class FileStateMachineCursorStore implements StateMachineCursorStore {
  readonly kind = 'file';
  readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || filePath.trim().length === 0) {
      throw new ValidationError('cursor file path is required');
    }
    this.filePath = filePath;
  }

  async load(context: StateMachineCursorContext): Promise<StateMachineCursorLoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { status: 'empty' };
      }
      throw error;
    }
    if (raw.trim().length === 0) {
      return { status: 'empty' };
    }

    try {
      const decoded = JSON.parse(raw) as unknown;
      if (!isRecord(decoded)) {
        throw new ValidationError('cursor file must contain a JSON object');
      }
      // A cursor from a different chain id, state-machine set, or genesis
      // belongs to another watcher identity: report it as foreign so the
      // watcher can alert and start fresh; the next successful save overwrites.
      if (!cursorContextMatches(decoded, context)) {
        return { status: 'foreign', reason: 'context' };
      }
      const storedGenesis = typeof decoded.genesisHash === 'string' ? decoded.genesisHash.toLowerCase() : undefined;
      if (context.genesisHash !== undefined && storedGenesis !== undefined && storedGenesis !== context.genesisHash) {
        return { status: 'foreign', reason: 'genesis' };
      }
      if (decoded.nextBlock === undefined || decoded.nextBlock === null) {
        return { status: 'empty' };
      }
      return {
        status: 'restored',
        nextBlock: parseStoredCursor(decoded.nextBlock),
        ...(typeof decoded.blockHash === 'string' && decoded.blockHash.length > 0 ? { blockHash: decoded.blockHash.toLowerCase() } : {}),
        ...(Array.isArray(decoded.checkpoints) ? { checkpoints: parseStoredCheckpoints(decoded.checkpoints) } : {}),
      };
    } catch (error) {
      // A crash-truncated or structurally invalid file is recoverable, not
      // poisoned: quarantine the bytes for inspection and start fresh.
      await quarantineCorruptStateFile(this.filePath, raw, error, 'cursor');
      return { status: 'empty' };
    }
  }

  async save(state: StateMachineCursorState, context: StateMachineCursorContext): Promise<void> {
    if (typeof state.nextBlock !== 'bigint' || state.nextBlock < 0n) {
      throw new ValidationError('cursor must be a non-negative bigint block number');
    }
    await writeStateFileAtomically(
      this.filePath,
      `${JSON.stringify({
        version: 2,
        nextBlock: state.nextBlock.toString(),
        ...(state.blockHash ? { blockHash: state.blockHash } : {}),
        ...(state.checkpoints && state.checkpoints.length > 0 ? { checkpoints: state.checkpoints.map((checkpoint) => ({ blockNumber: checkpoint.blockNumber.toString(), blockHash: checkpoint.blockHash })) } : {}),
        chainId: context.chainId,
        stateMachines: [...context.stateMachines],
        ...(context.genesisHash ? { genesisHash: context.genesisHash } : {}),
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
  }
}

export class StateMachineWatcher {
  readonly config: NormalizedStateMachineWatcherConfig;
  private nextBlock: bigint | undefined;
  private decodeFailuresTotal = 0;
  private cursorRestored = false;
  /** True once a persisted cursor was adopted; the G-11 overshoot correction only applies to that case. */
  private adoptedStoredCursor = false;
  private genesisHash: string | undefined;
  /** Canonical hash of block nextBlock - 1 from the last successful round, when readable. */
  private cursorBlockHash: string | undefined;
  private checkpoints: StateMachineCursorCheckpoint[] = [];

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
      confirmations: this.config.confirmations,
      reorgWindow: this.config.reorgWindow,
      getLogsBlockSpan: this.config.getLogsBlockSpan,
      handlerKeys: Object.keys(this.config.handlers),
      dryRun: this.config.dryRun,
      retry: this.config.retry,
      decodeFailures: this.decodeFailuresTotal,
      jobStore: this.config.jobStore.kind ?? 'custom',
      cursorStore: this.config.cursorStore?.kind ?? 'memory',
    };
  }

  /**
   * Resolve the watcher's chain identity and load the persisted scan cursor
   * once per watcher instance before the first poll. A restored cursor
   * replaces the initial fromBlock so a restarted watcher resumes where the
   * previous process stopped instead of rescanning the already-processed
   * range. A cursor belonging to another identity is reported through
   * onError and discarded — silently adopting it is how a reset dev chain
   * drops every event until the new head passes the stale position.
   */
  async restoreCursor(client?: StateMachinePublicClient): Promise<void> {
    if (this.cursorRestored) {
      return;
    }
    this.cursorRestored = true;
    this.genesisHash = client ? await tryGetBlockHash(client, 0n) : undefined;
    const store = this.config.cursorStore;
    if (!store) {
      return;
    }
    const result = await store.load(this.cursorContext());
    if (result.status === 'foreign') {
      const cause = result.reason === 'genesis'
        ? 'the chain genesis hash changed (chain reset or replacement chain at the same chain id)'
        : 'the chain id or state-machine set changed';
      this.config.onError?.(new ExecutorKitError(
        `discarding the persisted scan cursor: ${cause}`
        + `; rescanning from ${this.config.fromBlock !== undefined ? `fromBlock ${this.config.fromBlock}` : 'the current finalized head'}`
        + ` (stored cursor file: ${store.kind === 'file' && 'filePath' in store ? String((store as { readonly filePath: string }).filePath) : store.kind ?? 'custom'})`,
      ));
      return;
    }
    if (result.status === 'restored') {
      this.nextBlock = result.nextBlock;
      this.cursorBlockHash = result.blockHash;
      this.checkpoints = [...(result.checkpoints ?? [])];
      this.adoptedStoredCursor = true;
    }
  }

  async pollOnce(): Promise<StateMachinePollResult> {
    const client = getPublicClient(this.config);
    await ensureChainId(client, this.config.chainId);
    await this.restoreCursor(client);

    const latestBlock = await client.getBlockNumber();
    // Finality buffer: never scan the chain tip, so a short reorg cannot flip
    // processed logs (and their confirmed submissions) behind the cursor.
    const toBlock = latestBlock > BigInt(this.config.confirmations)
      ? latestBlock - BigInt(this.config.confirmations)
      : 0n;
    let fromBlock = this.nextBlock ?? this.config.fromBlock ?? toBlock;

    if (fromBlock > latestBlock) {
      // The cursor sits beyond the live chain head: the chain shrank under us
      // (node rollback, or a reset the genesis identity could not catch).
      // Alert instead of spinning silently, and when the overshoot came from a
      // adopted cursor, fall back to the configured fromBlock as the corrected
      // rescan floor.
      this.config.onError?.(new ExecutorKitError(
        `scan cursor ${fromBlock} is beyond the chain head ${latestBlock}${this.adoptedStoredCursor ? ' (persisted cursor is stale)' : ''}`
        + `; ${this.config.fromBlock !== undefined ? `rescanning from fromBlock ${this.config.fromBlock}` : 'waiting for the chain to grow'}`,
      ));
      if (this.adoptedStoredCursor && this.config.fromBlock !== undefined && this.config.fromBlock <= toBlock) {
        fromBlock = this.config.fromBlock;
        this.adoptedStoredCursor = false;
      } else {
        return { fromBlock, toBlock, scannedLogs: 0, results: [], decodeFailures: 0 };
      }
    } else {
      fromBlock = await this.enforceCursorContinuity(client, fromBlock);
    }

    if (fromBlock > toBlock) {
      // The finalized head has not caught up with the cursor yet — normal
      // finality lag, nothing to scan this round.
      return { fromBlock, toBlock, scannedLogs: 0, results: [], decodeFailures: 0 };
    }

    // Chunk deep ranges: one unbounded eth_getLogs over a large gap is exactly
    // the query RPC providers reject, which used to fail every catch-up round.
    const logBatches = await Promise.all(
      this.config.stateMachines.map(async (deployment) => {
        const logs = (
          await Promise.all(
            blockRanges(fromBlock, toBlock, BigInt(this.config.getLogsBlockSpan)).map((range) =>
              client.getLogs({
                address: deployment.stateMachineAddress,
                fromBlock: range.fromBlock,
                toBlock: range.toBlock,
              }),
            ),
          )
        ).flat();
        return logs.map((log) => log.address ? log : { ...log, address: deployment.stateMachineAddress });
      }),
    );
    const logs = logBatches.flat().sort(compareRawLogs);
    const results: StateMachineLogProcessResult[] = [];
    // Fail fast on unexpected log-processing errors: the round aborts before the
    // cursor advances, so the failing block range is rescanned on the next
    // successful poll. Decode failures are handled inside handleLog (skip and
    // record) precisely so an undecodable log cannot trap the cursor here.
    for (const log of logs) {
      results.push(await this.handleLog(log));
    }
    // Persistence is part of the round: save first, advance memory second. A
    // save that fails after the memory advance used to leave the process
    // holding an unpersisted skip interval — combined with a crash, blocks were
    // silently never rescanned by this or any restarted instance.
    const nextBlock = toBlock + 1n;
    // Remember canonical hashes for the scanned range (dense near the tip,
    // exponentially sparser deeper) so a later reorg can locate the common
    // ancestor instead of falling back to a full rescan.
    for (const anchorHeight of checkpointAnchorHeights(fromBlock, toBlock, this.config.reorgWindow)) {
      const anchorHash = await tryGetBlockHash(client, anchorHeight);
      if (anchorHash !== undefined) {
        this.recordCheckpoint(anchorHeight, anchorHash);
        if (anchorHeight === toBlock) {
          this.cursorBlockHash = anchorHash;
        }
      }
    }
    if (this.config.cursorStore) {
      await this.config.cursorStore.save(
        {
          nextBlock,
          ...(this.cursorBlockHash !== undefined ? { blockHash: this.cursorBlockHash } : {}),
          ...(this.checkpoints.length > 0 ? { checkpoints: this.trimmedCheckpoints() } : {}),
        },
        this.cursorContext(),
      );
    }
    this.nextBlock = nextBlock;

    const decodeFailures = results.filter((result) => result.decodeFailure).length;
    return {
      fromBlock,
      toBlock,
      scannedLogs: logs.length,
      results,
      decodeFailures,
    };
  }

  async handleLog(log: StateMachineRawLog, options?: {
    /**
     * Manual-recovery escape hatch for reorg-invalidated confirmations: ignore
     * the "already delivered" shortcuts and resubmit every signal. The chain's
     * own idempotency keys absorb a duplicate when the prior signal survived.
     */
    readonly resubmitDelivered?: boolean;
    /** Manual retries skip the resend backoff: the operator asked for it now. */
    readonly bypassResendBackoff?: boolean;
  }): Promise<StateMachineLogProcessResult> {
    if (log.topics[0] !== HOOK_READY_TOPIC) {
      return {
        status: 'skipped',
        submissions: [],
      };
    }

    let event: StateMachineHookReady;
    try {
      const decoded = decodeHookReadyLog(log, this.config.artifact);
      if (!decoded) {
        // Unreachable: decodeHookReadyLog returns undefined only for logs without
        // the HookReady topic and throws when a topic-matching log fails to decode.
        throw new ValidationError('HookReady log matched the topic but did not decode into an event');
      }
      event = decoded;
    } catch (error) {
      // A topic-matching log that cannot be decoded (e.g. a mixed-ABI deployment
      // or corrupted data) must never abort the scan: rescan would hit the same
      // deterministic failure every round until the watch loop gave up. Skip it,
      // record the decision, and let the cursor advance past it.
      return this.isolateUndecodableLog(log, error);
    }

    const detectedAt = this.config.now();
    let job = await this.config.jobStore.upsertDetected(event, {
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
    // Effective submit config for this event: the emitting contract wins over
    // the config-level default address. Shared by the direct submission path
    // and the receipt-recovery path below.
    const eventSubmitConfig = {
      ...this.config,
      stateMachineAddress: event.stateMachineAddress ?? this.config.stateMachineAddress,
    };
    const submitSignalWithJobRetry = async (
      signal: StateMachineSignal,
      signalIndex: number,
    ): Promise<SubmitStateMachineSignalResult> => {
      let lastError: ClassifiedExecutorKitError | undefined;
      for (let attemptForSignal = 1; attemptForSignal <= this.config.retry.maxAttempts; attemptForSignal += 1) {
        try {
          const result = await submitStateMachineSignal(eventSubmitConfig, signal);
          jobSubmissions.push(toJobSubmission(signalIndex, attemptForSignal, result));
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            lastSignalAttemptAt: this.config.now(),
            submissions: jobSubmissions,
          });
          return result;
        } catch (error) {
          const classified = classifyExecutorKitError(error);
          // attempts is the job-level count of REAL failures: successes and
          // per-signal bookkeeping must not consume the retry budget, or a
          // completed multi-signal dry-run arrives at the manual retry entry
          // already "exhausted" and gets dead-lettered without ever failing.
          attempts += 1;
          lastError = classified;
          // Fail-closed audit trail: a tx that was broadcast before the failure
          // (receipt reverted or receipt wait threw) must stay visible on the
          // job, mirroring how chain-services failedResult carries txHash.
          const broadcastTxHash = broadcastTxHashFromError(error);
          jobSubmissions.push({
            signalIndex,
            attempt: attemptForSignal,
            ...(broadcastTxHash ? { txHash: broadcastTxHash } : {}),
            error: classified,
          });
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            attempts,
            lastSignalAttemptAt: this.config.now(),
            submissions: jobSubmissions,
            lastError: classified,
          });
          // Replay guard: when the failed attempt already broadcast a tx, the
          // blind retry below would put a second transaction on chain for the
          // same signal. Consult the receipt first and only rebroadcast when
          // the broadcast is provably absent.
          if (classified.retryable && broadcastTxHash !== undefined && attemptForSignal < this.config.retry.maxAttempts) {
            const recovered = await this.recoverBroadcastSubmission(eventSubmitConfig, signal, broadcastTxHash);
            if (recovered) {
              jobSubmissions.push(toJobSubmission(signalIndex, attemptForSignal, recovered));
              currentJob = await this.updateJob(job.id, {
                updatedAt: this.config.now(),
                submissions: jobSubmissions,
                clearLastError: true,
              });
              return recovered;
            }
          }
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
        ...eventSubmitConfig,
        ...overrides,
      }, signal),
    };
    let handlerResult: StateMachineHookReadyHandlerResult = undefined;
    for (let attemptForHandler = 1; attemptForHandler <= this.config.retry.maxAttempts; attemptForHandler += 1) {
      try {
        handlerResult = await resolved.handler(event, context);
        currentJob = await this.updateJob(job.id, {
          updatedAt: this.config.now(),
          submissions: jobSubmissions,
        });
        break;
      } catch (error) {
        const classified = classifyExecutorKitError(error, 'handler_failure');
        // See submitSignalWithJobRetry: attempts counts real failures only.
        attempts += 1;
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
    // The plan-scoped submitSignal ABI requires the order
    // planId. Resolution order: an explicit per-signal planId (handler-supplied
    // or the new config `signals[].planId` field) wins; otherwise the planId
    // decoded from the HookReady event itself (the event is the authoritative
    // carrier, so it outranks any job-persisted value from older runs); the
    // persisted job planId is the last resort. A handler-derived planId is
    // persisted so manual retries can resubmit.
    const eventPlanId = event.planId !== ZERO_BYTES32 ? event.planId : undefined;
    const jobPlanId = signals.map((signal) => signal.planId).find((value) => value !== undefined)
      ?? eventPlanId
      ?? job.planId;
    if (jobPlanId !== undefined && job.planId === undefined) {
      const withPlanId = await this.updateJob(job.id, {
        updatedAt: this.config.now(),
        planId: normalizeBytes32(jobPlanId, 'job.planId'),
      });
      if (withPlanId) {
        job = withPlanId;
      }
    }
    const fallbackPlanId = jobPlanId;
    // Resume support: a signal with a prior real (non-dry-run) broadcast or a
    // duplicate_signal dedupe fact is already delivered on chain. Re-running
    // the job — manual `jobs retry` or a rescan of an open job — must continue
    // with the next pending signal instead of replaying delivered ones;
    // replaying them would dead-lock multi-signal jobs in `ignored` on the
    // first duplicate.
    const deliveredSignalIndexes = options?.resubmitDelivered
      ? new Set<number>()
      : deliveredSignalIndexesFromSubmissions(currentJob.submissions);
    let deferredResend = false;
    for (const [index, signal] of signals.entries()) {
      if (deliveredSignalIndexes.has(index)) {
        continue;
      }
      // O13 resend backoff: a signal with prior unconfirmed broadcasts gets a
      // growing (capped) wait before the next rebroadcast, so a rescan does
      // not put the same transaction on chain once per poll round. Behavior
      // otherwise unchanged — the chain's idempotency key stays the dedupe
      // anchor — this only stops the per-round gas burn.
      const priorUnconfirmedBroadcasts = !options?.bypassResendBackoff
        ? unconfirmedBroadcastCount(currentJob.submissions, index)
        : 0;
      if (priorUnconfirmedBroadcasts > 0) {
        const requiredDelayMs = resendBackoffDelayMs(this.config.resendBackoff, priorUnconfirmedBroadcasts);
        const lastAttemptAtMs = Date.parse(currentJob.lastSignalAttemptAt ?? currentJob.updatedAt);
        // A missing/unparseable anchor loses the clock: fall through to the
        // resend (chain idempotency stays the dedupe anchor) instead of
        // deferring forever.
        if (Number.isFinite(lastAttemptAtMs) && this.config.nowMs() - lastAttemptAtMs < requiredDelayMs) {
          deferredResend = true;
          continue;
        }
      }
      try {
        const result = await submitSignalWithJobRetry({
          ...signal,
          ...(signal.planId === undefined && fallbackPlanId !== undefined ? { planId: fallbackPlanId } : {}),
          readyEventId: signal.readyEventId ?? event.eventId,
        }, index);
        submissions.push(result);
        if (!result.dryRun) {
          deliveredSignalIndexes.add(index);
        }
      } catch (error) {
        const classified = error instanceof ClassifiedStateMachineError
          ? error.classified
          : classifyExecutorKitError(error);
        if (classified.kind === 'duplicate_signal') {
          // The chain already carries this signal: a deterministic dedupe fact,
          // not a failure. Count it as delivered and keep the remaining
          // signals progressing instead of parking the whole job.
          deliveredSignalIndexes.add(index);
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
          submissions,
          job: failed,
          error: classified,
        };
      }
    }

    const finalStatus = statusForCompletedRun(
      submissions,
      deliveredSignalIndexes.size,
      signals.length,
      this.config.dryRun,
    );
    if (deferredResend) {
      // A deferred signal keeps the job open. Preserve updatedAt: rewriting
      // now() would restart the backoff clock on every deferred round.
      currentJob = await this.updateJob(job.id, {
        status: finalStatus === 'matched' ? 'submitted' : finalStatus,
        updatedAt: currentJob.updatedAt,
        attempts,
        submissions: jobSubmissions,
      });
    } else {
      currentJob = await this.updateJob(job.id, {
        status: finalStatus,
        updatedAt: this.config.now(),
        attempts,
        submissions: jobSubmissions,
        clearLastError: true,
      });
    }

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
    // First-round failures still fail fast: a rejection here propagates out of start() itself.
    await run();
    let running = false;
    let stopped = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveStopped: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const tick = (): void => {
      if (running || stopped) {
        return;
      }
      running = true;
      void run()
        .then(() => {
          consecutiveFailures = 0;
        })
        .catch((error: unknown) => {
          // Keep watching, but slow down: a permanent clearInterval abort had
          // no recovery path, so a transient RPC outage killed the listener
          // until a human restarted the process.
          consecutiveFailures += 1;
          this.config.onError?.(error);
        })
        .finally(() => {
          running = false;
          if (!stopped) {
            const delayMs = consecutiveFailures > 0
              ? pollFailureDelayMs(this.config.pollIntervalMs, consecutiveFailures)
              : this.config.pollIntervalMs;
            timer = setTimeout(tick, delayMs);
          }
        });
    };
    tick();

    return {
      stop(): void {
        stopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolveStopped?.();
      },
      done,
    };
  }

  private async updateJob(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob> {
    const updated = await this.config.jobStore.update(jobId, patch);
    if (!updated) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return updated;
  }

  /**
   * Replay guard for retryable broadcast failures: consult the receipt of the
   * already-broadcast transaction before any rebroadcast.
   *
   * - receipt mined with status success: returns a confirmed submission result
   *   built from the recovered tx, so no second transaction is sent;
   * - receipt mined with a non-success status: the broadcast definitively
   *   reverted, so rebroadcasting is pointless — throws the same
   *   non-retryable receipt error as the direct receipt path;
   * - no receipt (not mined yet, or the lookup itself failed, or the client
   *   cannot look receipts up): returns undefined and the caller falls back to
   *   its normal retry decision.
   */
  private async recoverBroadcastSubmission(
    config: NormalizedSubmitConfig,
    signal: StateMachineSignal,
    txHash: Hex,
  ): Promise<SubmitStateMachineSignalResult | undefined> {
    const client = getPublicClient(config);
    if (!client.getTransactionReceipt) {
      return undefined;
    }
    let receipt: { readonly status?: 'success' | 'reverted' | string } | null | undefined;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch {
      return undefined;
    }
    if (!receipt) {
      return undefined;
    }
    if (receipt.status && receipt.status !== 'success') {
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt status ${receipt.status}`);
    }
    return {
      dryRun: false,
      request: buildSubmitStateMachineSignalCall(config, signal, config.walletAddress),
      txHash,
      confirmed: receipt.status === 'success',
    };
  }

  private cursorContext(): StateMachineCursorContext {
    return {
      chainId: this.config.chainId,
      stateMachines: this.config.stateMachines
        .map((deployment) => deployment.stateMachineAddress.toLowerCase())
        .sort(),
      ...(this.genesisHash ? { genesisHash: this.genesisHash } : {}),
    };
  }

  /**
   * Cursor block-hash continuity check plus bounded rollback, mirroring the
   * chain-services indexer defenses. The stored hash anchors the last scanned
   * height; a mismatch against the canonical chain means a reorg slipped past
   * the finality buffer. The remembered checkpoints inside the reorg window
   * are walked newest-first for the common ancestor, and the scan position is
   * rolled back to it so the affected range is rescanned (job idempotency
   * absorbs the overlap; on-chain idempotency keys absorb any rebroadcast).
   * A reorg deeper than the window falls back to a full rescan from the
   * configured floor instead of trusting a cursor that has provably diverged.
   */
  private async enforceCursorContinuity(
    client: StateMachinePublicClient,
    fromBlock: bigint,
  ): Promise<bigint> {
    if (!client.getBlock || this.cursorBlockHash === undefined || fromBlock <= 0n) {
      return fromBlock;
    }
    const cursorHeight = fromBlock - 1n;
    const canonicalHash = await tryGetBlockHash(client, cursorHeight);
    if (canonicalHash === undefined || sameBlockHash(canonicalHash, this.cursorBlockHash)) {
      return fromBlock;
    }

    const candidates = this.trimmedCheckpoints()
      .filter((checkpoint) => checkpoint.blockNumber < fromBlock)
      .sort((left, right) => (left.blockNumber > right.blockNumber ? -1 : left.blockNumber < right.blockNumber ? 1 : 0));
    for (const candidate of candidates) {
      const ancestorHash = await tryGetBlockHash(client, candidate.blockNumber);
      if (ancestorHash !== undefined && sameBlockHash(ancestorHash, candidate.blockHash)) {
        this.config.onError?.(new ExecutorKitError(
          `chain reorg detected at height ${cursorHeight} (stored ${this.cursorBlockHash}, canonical ${canonicalHash});`
          + ` rolling the scan cursor back to the common ancestor at block ${candidate.blockNumber} and rescanning from ${candidate.blockNumber + 1n}`,
        ));
        this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.blockNumber <= candidate.blockNumber);
        this.cursorBlockHash = candidate.blockHash;
        return candidate.blockNumber + 1n;
      }
    }

    const rescanFloor = this.config.fromBlock ?? 0n;
    this.config.onError?.(new ExecutorKitError(
      `chain reorg at height ${cursorHeight} deeper than the ${this.config.reorgWindow}-block checkpoint window;`
      + ` rescanning from block ${rescanFloor} instead of trusting the diverged cursor`,
    ));
    this.checkpoints = [];
    this.cursorBlockHash = undefined;
    return rescanFloor;
  }

  private recordCheckpoint(blockNumber: bigint, blockHash: string): void {
    this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.blockNumber !== blockNumber);
    this.checkpoints.push({ blockNumber, blockHash });
    this.checkpoints.sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0));
  }

  private trimmedCheckpoints(): readonly StateMachineCursorCheckpoint[] {
    return this.checkpoints.slice(-this.config.reorgWindow);
  }

  /**
   * Record-and-skip path for HookReady-topic logs that fail to decode.
   *
   * The decision is persisted in the job store (as a terminal `ignored` job with
   * sentinel ids and the raw log preserved for inspection) whenever the log has
   * enough identity to derive an event id, reported through `onError`, and
   * counted in poll results and `describe()`. It never throws: mixed-version
   * deployments degrade to "these logs are skipped", not a crashed watcher.
   */
  private async isolateUndecodableLog(log: StateMachineRawLog, error: unknown): Promise<StateMachineLogProcessResult> {
    const classified = classifyExecutorKitError(error, 'validation_failure');
    this.decodeFailuresTotal += 1;
    // onError is the kit's log/metric channel for degraded conditions; the CLI
    // wires it to stderr so operators see every skipped log.
    this.config.onError?.(error instanceof Error ? error : new Error(classified.message));

    const eventId = tryHookReadyEventId(log);
    if (!eventId) {
      // The log cannot be identified (missing or invalid transactionHash/logIndex),
      // so there is nothing to persist; skipping it still lets the round advance.
      return {
        status: 'ignored',
        submissions: [],
        error: classified,
        decodeFailure: true,
      };
    }

    const now = this.config.now();
    const stateMachineAddress = tryNormalizeStateMachineAddress(log.address);
    const event: StateMachineHookReady = {
      type: 'HookReady',
      eventId,
      ...(stateMachineAddress ? { stateMachineAddress } : {}),
      // Sentinel ids: the real ids are unrecoverable from the undecodable log.
      // The event id (derived from transactionHash+logIndex) keeps job ids unique
      // per log, so distinct undecodable logs never collapse into one job.
      planId: ZERO_BYTES32,
      orderId: ZERO_BYTES32,
      hookId: ZERO_BYTES32,
      stageId: ZERO_BYTES32,
      hookNameId: ZERO_BYTES32,
      ...(log.blockNumber !== undefined && log.blockNumber !== null ? { blockNumber: BigInt(log.blockNumber) } : {}),
      ...(log.transactionHash ? { transactionHash: log.transactionHash } : {}),
      ...(log.logIndex !== undefined && log.logIndex !== null ? { logIndex: BigInt(log.logIndex) } : {}),
      raw: log,
    };
    const job = await this.config.jobStore.upsertDetected(event, {
      now,
      maxAttempts: this.config.retry.maxAttempts,
      ...(this.config.supplierId ? { supplierId: this.config.supplierId } : {}),
    });
    const isolated = await this.updateJob(job.id, {
      status: 'ignored',
      updatedAt: now,
      lastError: classified,
    });
    return {
      status: 'ignored',
      submissions: [],
      job: isolated,
      error: classified,
      decodeFailure: true,
    };
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
    ...(job.status === 'failed' ? { attempts: 0 } : {}),
    manualActions,
    clearLastError: true,
  });
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
  } catch (error) {
    throw new ValidationError(`failed to decode HookReady log data: ${describeError(error)}`);
  }

  const args = (decoded as { readonly args?: unknown }).args as {
    readonly planId?: unknown;
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
    planId: normalizeBytes32(asString(args.planId, 'planId'), 'planId'),
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
  if (!log.transactionHash) {
    throw new ValidationError('HookReady log is missing transactionHash; refusing to derive an event id from zero values');
  }
  const logIndex = normalizeLogIndex(log.logIndex);
  if (logIndex === undefined) {
    throw new ValidationError('HookReady log is missing logIndex; refusing to derive an event id from zero values');
  }
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256' },
    ],
    [normalizeBytes32(log.transactionHash, 'transactionHash'), logIndex],
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
    args: [args.planId, args.orderId, args.sourceId, args.signalId, args.payloadHash, args.idempotencyKey],
    data: encodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      args: [args.planId, args.orderId, args.sourceId, args.signalId, args.payloadHash, args.idempotencyKey],
    }),
    chainId: normalizedConfig.chainId,
    ...(from ? { from } : {}),
  } as const;
  return request;
}

/**
 * Thrown after a submitSignal transaction was already broadcast but its receipt
 * could not be confirmed: either the receipt came back non-success (reverted)
 * or waiting for the receipt itself failed (timeout, RPC fault). The broadcast
 * txHash rides on the error so callers can keep the already-broadcast
 * transaction in the job audit trail instead of losing it to a retry.
 */
export class SubmitSignalReceiptError extends Error {
  readonly txHash: Hex;

  constructor(txHash: Hex, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SubmitSignalReceiptError';
    this.txHash = txHash;
  }
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
    let receipt: { readonly status?: 'success' | 'reverted' | string };
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      // The tx is already on chain; never let a receipt-wait fault drop the
      // hash of what was broadcast.
      const detail = error instanceof Error ? error.message : String(error);
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt wait failed for ${txHash}: ${detail}`, { cause: error });
    }
    if (receipt.status && receipt.status !== 'success') {
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt status ${receipt.status}`);
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
        // Protocol-defined sentinel, not a fallback: UVPStateMachine.submitSignal
        // treats bytes32(0) as the legal "no payload" value. Omitting payloadHash
        // here is the producer's explicit declaration of an empty payload.
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
  readonly confirmations: number;
  readonly reorgWindow: number;
  readonly getLogsBlockSpan: number;
  readonly retry: NormalizedStateMachineRetryConfig;
  readonly resendBackoff: NormalizedStateMachineResendBackoffConfig;
  readonly nowMs: () => number;
  readonly jobStore: StateMachineJobStore;
  readonly cursorStore?: StateMachineCursorStore;
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

interface NormalizedStateMachineResendBackoffConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
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
    confirmations: config.confirmations !== undefined
      ? parseNonNegativeSafeInteger(asNumberOrString(config.confirmations, 'confirmations'), 'confirmations')
      : DEFAULT_FINALITY_CONFIRMATIONS,
    reorgWindow: config.reorgWindow !== undefined
      ? parsePositiveInteger(asNumberOrString(config.reorgWindow, 'reorgWindow'), 'reorgWindow')
      : DEFAULT_REORG_WINDOW_BLOCKS,
    getLogsBlockSpan: config.getLogsBlockSpan !== undefined
      ? parsePositiveInteger(asNumberOrString(config.getLogsBlockSpan, 'getLogsBlockSpan'), 'getLogsBlockSpan')
      : DEFAULT_GET_LOGS_BLOCK_SPAN,
    retry: normalizeRetryConfig(config.retry),
    resendBackoff: {
      baseDelayMs: config.resendBackoff?.baseDelayMs !== undefined
        ? parseNonNegativeSafeInteger(asNumberOrString(config.resendBackoff.baseDelayMs, 'resendBackoff.baseDelayMs'), 'resendBackoff.baseDelayMs')
        : DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS,
      maxDelayMs: config.resendBackoff?.maxDelayMs !== undefined
        ? parseNonNegativeSafeInteger(asNumberOrString(config.resendBackoff.maxDelayMs, 'resendBackoff.maxDelayMs'), 'resendBackoff.maxDelayMs')
        : DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS,
    },
    nowMs: config.nowMs ?? (() => Date.now()),
    jobStore: config.jobStore ?? new InMemoryStateMachineJobStore(),
    ...(config.cursorStore ? { cursorStore: config.cursorStore } : {}),
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
    // Default ON: a broadcast whose receipt is never observed cannot be told
    // apart from a reverted one, so waiting is the safe single path. Callers
    // that explicitly opt out (`waitForReceipt: false`) keep unconfirmed jobs
    // non-terminal so the outcome is re-checked on a later scan instead of
    // being trusted.
    waitForReceipt: config.waitForReceipt ?? true,
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
  // submitSignal is plan-scoped. Unlike the payloadHash zero
  // sentinel below, a zero planId is NOT a legitimate encoding: the contract
  // verifies that (planId, orderId) exists, so the zero placeholder can only
  // produce a transaction that reverts. Refuse to build it instead of letting
  // the executor broadcast a doomed tx.
  const rawPlanId = signal.planId ?? undefined;
  if (rawPlanId === undefined || (typeof rawPlanId === 'string' && rawPlanId.trim().length === 0)) {
    throw new ValidationError(
      'planId is required to submit a state machine signal: the plan-scoped submitSignal(orderId, ...) ABI now takes the order planId as its first argument and rejects the zero placeholder on chain',
    );
  }
  const planId = normalizeBytes32(rawPlanId, 'planId');
  if (planId === ZERO_BYTES32) {
    throw new ValidationError('planId must be a non-zero bytes32: the zero placeholder cannot satisfy the on-chain (planId, orderId) existence check');
  }
  const orderId = normalizeBytes32(signal.orderId, 'orderId');
  // Protocol-defined sentinel, not a fallback: per the UVPStateMachine submitSignal
  // ABI, bytes32(0) is the legitimate encoding of "no payload" (see EXEC-3 ruling).
  // A producer omitting payloadHash is asserting an empty payload on chain.
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
    planId,
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
    ...(typeof value.planId === 'string' ? { planId: normalizeBytes32(value.planId, `${path}.planId`) } : {}),
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

/**
 * Recovers the hash of an already-broadcast transaction from a submission
 * failure. Mirrors the classified-code walk in errors.ts: any Error along the
 * cause chain may carry a `txHash` hex property (e.g. SubmitSignalReceiptError
 * thrown after a successful broadcast whose receipt never confirmed).
 */
function broadcastTxHashFromError(error: unknown): Hex | undefined {
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
 * Terminal status for a run that submitted (or resumed) every signal without a
 * failure: `confirmed` only when the whole signal set is delivered and every
 * this-run submission observed a successful receipt; `submitted` when at least
 * one real broadcast happened but confirmation is incomplete (including fully
 * resumed runs that had nothing new to send); `matched` for dry-runs and
 * handler-only runs with nothing to broadcast.
 */
function statusForCompletedRun(
  submissions: readonly SubmitStateMachineSignalResult[],
  deliveredSignalCount: number,
  totalSignals: number,
  dryRun: boolean,
): StateMachineJobStatus {
  if (dryRun) {
    return 'matched';
  }
  const allDelivered = totalSignals > 0 && deliveredSignalCount >= totalSignals;
  const allThisRunConfirmed = submissions.length > 0
    && submissions.every((submission) => !submission.dryRun && submission.confirmed);
  if (allDelivered && allThisRunConfirmed) {
    return 'confirmed';
  }
  if (submissions.length > 0 || deliveredSignalCount > 0) {
    return 'submitted';
  }
  return 'matched';
}

/**
 * Signal indexes that must not be (re)submitted: each has a prior real
 * (non-dry-run) submission that returned without error, or a duplicate_signal
 * response proving the chain already carries the signal. Dry-run submissions
 * never count — flipping dry-run off must still broadcast everything.
 */
function deliveredSignalIndexesFromSubmissions(
  submissions: readonly StateMachineJobSubmission[],
): Set<number> {
  const delivered = new Set<number>();
  for (const submission of submissions) {
    if (submission.error?.kind === 'duplicate_signal' || (!submission.error && submission.dryRun === false)) {
      delivered.add(submission.signalIndex);
    }
  }
  return delivered;
}

/**
 * Broadcast-but-unconfirmed attempts for one signal: the exact re-send
 * candidates the resend backoff throttles. Successful and dry-run submissions
 * never count.
 */
function unconfirmedBroadcastCount(
  submissions: readonly StateMachineJobSubmission[],
  signalIndex: number,
): number {
  return submissions.filter((submission) =>
    submission.signalIndex === signalIndex
    && submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.error !== undefined
    && submission.error.kind !== 'duplicate_signal',
  ).length;
}

/** Exponential resend delay capped at maxDelayMs. */
function resendBackoffDelayMs(
  config: NormalizedStateMachineResendBackoffConfig,
  priorUnconfirmedBroadcasts: number,
): number {
  const exponent = Math.min(Math.max(priorUnconfirmedBroadcasts - 1, 0), 16);
  return Math.min(config.baseDelayMs * 2 ** exponent, config.maxDelayMs);
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
  // Transient failures keep the retry channel open: after the in-run retries are
  // exhausted the job lands in `failed`, which `jobs retry` accepts. Deterministic
  // non-retryable failures dead-letter for human triage instead of parking in the
  // retryable lane where automatic or manual retries would pointlessly re-run them.
  return error.retryable ? 'failed' : 'dead_letter';
}

function isTerminalJobStatus(status: StateMachineJobStatus): boolean {
  // 'submitted' means a transaction was broadcast but no receipt confirmed it.
  // That is deliberately NON-terminal: until the chain confirms success the job
  // stays open so a later scan or manual retry can observe the real outcome
  // instead of trusting the broadcast (a reverted tx must never freeze as done).
  return status === 'confirmed'
    || status === 'failed'
    || status === 'ignored'
    || status === 'dead_letter';
}

function isRetriableStateMachineJobStatus(status: StateMachineJobStatus): boolean {
  // `confirmed` is retriable as the manual recovery channel: a reorg can flip
  // a confirmation off the canonical chain while the job stays terminal
  // forever otherwise. The retry resubmits and the on-chain idempotency key
  // absorbs a duplicate when the signal actually survived.
  return status === 'failed' || status === 'matched' || status === 'submitted' || status === 'confirmed';
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

  try {
    return parseStateMachineJobsFile(raw);
  } catch (error) {
    // Quarantine-and-recover instead of throwing forever: a truncated write
    // used to poison every later read, aborting the watch loop permanently.
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
 * mid-write leaves a truncated file that used to make every later parse throw
 * and eventually abort the watch loop.
 */
async function writeStateFileAtomically(filePath: string, contents: string): Promise<void> {
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
async function quarantineCorruptStateFile(filePath: string, raw: string, error: unknown, kind: 'jobs' | 'cursor'): Promise<void> {
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

function cursorContextMatches(stored: Record<string, unknown>, context: StateMachineCursorContext): boolean {
  if (stored.chainId !== context.chainId) {
    return false;
  }
  const storedMachines = Array.isArray(stored.stateMachines) ? stored.stateMachines : [];
  if (storedMachines.length !== context.stateMachines.length) {
    return false;
  }
  const expected = [...context.stateMachines].sort();
  const actual = storedMachines
    .map((address) => typeof address === 'string' ? address.toLowerCase() : '')
    .sort();
  return expected.every((address, index) => actual[index] === address);
}

function parseStoredCursor(value: unknown): bigint {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : undefined;
  if (text === undefined || !/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new ValidationError('stored cursor must be a non-negative integer block number');
  }
  return BigInt(text);
}

function parseStoredCheckpoints(value: readonly unknown[]): readonly StateMachineCursorCheckpoint[] {
  const parsed: StateMachineCursorCheckpoint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new ValidationError('stored cursor checkpoints must be objects');
    }
    parsed.push({
      blockNumber: parseStoredCursor(entry.blockNumber),
      blockHash: asString(entry.blockHash, 'checkpoint.blockHash').toLowerCase(),
    });
  }
  return parsed;
}

/**
 * Canonical block hash or undefined. Lookups can legitimately fail (pruned
 * node, client without block support, RPC hiccup); the reorg defenses treat
 * that as "no evidence" and keep the finality buffer as the only line rather
 * than failing the round.
 */
async function tryGetBlockHash(client: StateMachinePublicClient, blockNumber: bigint): Promise<string | undefined> {
  if (!client.getBlock) {
    return undefined;
  }
  try {
    const block = await client.getBlock({ blockNumber });
    const hash = block?.hash;
    return typeof hash === 'string' && hash.length > 0 ? hash.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function sameBlockHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Heights to anchor this round, newest-first with exponentially growing gaps
 * (0, 1, 3, 7, ...): reorgs concentrate near the tip where anchors are dense,
 * while a deep one degrades to the full-rescan floor anyway. Bounded by the
 * configured reorg window and by fromBlock (lower blocks were anchored by the
 * round that actually scanned them).
 */
function checkpointAnchorHeights(fromBlock: bigint, toBlock: bigint, reorgWindow: number): readonly bigint[] {
  const heights: bigint[] = [];
  for (let gap = 0n; gap <= BigInt(reorgWindow); gap = gap * 2n + 1n) {
    const height = toBlock - gap;
    if (height < fromBlock) {
      break;
    }
    heights.push(height);
  }
  return heights;
}

/** Chunk [fromBlock, toBlock] into inclusive spans of at most maxSpan blocks. */
function blockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint,
): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[] {
  if (maxSpan < 1n) {
    throw new ValidationError('getLogsBlockSpan must be a positive number of blocks');
  }
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start = start + maxSpan) {
    const end = start + maxSpan - 1n < toBlock ? start + maxSpan - 1n : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}

/**
 * Poll delay after consecutive failures: exponential from the base interval,
 * capped at POLL_FAILURE_BACKOFF_MULTIPLIER_CAP so a long RPC outage slows the
 * watcher down instead of aborting it or flooding the dead endpoint.
 */
function pollFailureDelayMs(pollIntervalMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 3);
  return pollIntervalMs * Math.min(2 ** exponent, POLL_FAILURE_BACKOFF_MULTIPLIER_CAP);
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

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

/**
 * Best-effort event id for logs that failed to decode: returns undefined instead
 * of throwing when the log lacks a usable (transactionHash, logIndex) identity.
 */
function tryHookReadyEventId(log: StateMachineRawLog): Hex | undefined {
  try {
    return hookReadyEventId(log);
  } catch {
    return undefined;
  }
}

function tryNormalizeStateMachineAddress(address: Address | string | undefined): Address | undefined {
  if (address === undefined) {
    return undefined;
  }
  try {
    return normalizeAddress(address, 'log.address');
  } catch {
    return undefined;
  }
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
