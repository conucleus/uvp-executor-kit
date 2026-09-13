import type { Address, Hex } from 'viem';
import {
  ExecutorKitError,
  ValidationError,
  normalizeAddress,
  normalizeBytes32,
  parseBigNumberish,
  parsePositiveInteger,
} from '../validation.js';
import { ZERO_BYTES32 } from '../constants.js';
import { classifyExecutorKitError, type ClassifiedExecutorKitError } from '../errors.js';
import {
  HOOK_READY_TOPIC,
  decodeHookReadyLog,
  tryHookReadyEventId,
  tryNormalizeStateMachineAddress,
  type StateMachineArtifactIndex,
  type StateMachineHookReady,
  type StateMachineRawLog,
} from '../signal/decode.js';
import {
  buildSubmitStateMachineSignalCall,
  normalizeSubmitConfig,
  type NormalizedSubmitConfig,
  type StateMachinePublicClient,
  type StateMachineSignal,
  type SubmitStateMachineSignalConfig,
} from '../signal/build.js';
import {
  ensureChainId,
  getPublicClient,
  submitStateMachineSignal,
  SubmitSignalReceiptError,
  type SubmitStateMachineSignalResult,
} from '../signal/submit.js';
import {
  normalizeArtifactIndex,
  resolveStateMachineHandler,
  type DeferredBroadcastOutcome,
  type StateMachineHookReadyHandler,
  type StateMachineHookReadyHandlerContext,
  type StateMachineHookReadyHandlerResult,
} from './execution/handler.js';
import {
  ClassifiedStateMachineError,
  appendJobSubmission,
  broadcastTxHashFromError,
  carriesKnownRevert,
  deliveredSignalIndexesFromSubmissions,
  isUnconfirmedBroadcast,
  jobStatusForError,
  nextSubmissionAttempt,
  normalizeHandlerResult,
  statusForCompletedRun,
  statusForTerminalError,
  toJobSubmission,
  unconfirmedBroadcastCount,
} from './execution/receipt.js';
import {
  DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS,
  DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS,
  normalizeRetryConfig,
  resendBackoffDelayMs,
  type NormalizedStateMachineResendBackoffConfig,
  type NormalizedStateMachineRetryConfig,
  type StateMachineResendBackoffConfig,
  type StateMachineRetryConfig,
} from './jobs/retry.js';
import { isHeldRunClaim, withConclusiveClaimRelease } from './jobs/claim.js';
import {
  isTerminalJobStatus,
  type StateMachineJobPatch,
  type StateMachineJobStore,
  type StateMachineJobSubmission,
  type StateMachineWatcherJob,
} from './jobs/model.js';
import { InMemoryStateMachineJobStore } from './storage/memory.js';
import type {
  StateMachineCursorCheckpoint,
  StateMachineCursorContext,
  StateMachineCursorStore,
} from './storage/cursor.js';
import {
  DEFAULT_GET_LOGS_BLOCK_SPAN,
  blockRanges,
  compareRawLogs,
} from './scan/logs.js';
import {
  DEFAULT_FINALITY_CONFIRMATIONS,
  DEFAULT_REORG_WINDOW_BLOCKS,
  checkpointAnchorHeights,
  recordCheckpoint,
  sameBlockHash,
  tryGetBlockHash,
} from './scan/reorg.js';
import {
  asNonEmptyString,
  asNumberOrString,
  delay,
  describeError,
  parseNonNegativeSafeInteger,
} from './internal.js';

export const DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS = 4_000;
/** Cap on the poll-delay multiplier during consecutive-failure backoff. */
export const POLL_FAILURE_BACKOFF_MULTIPLIER_CAP = 8;

/**
 * Runtime environment declaration, same value set as chain-services
 * CHAIN_SERVICES_RUNTIME_ENV. Non-local environments forbid the silent
 * finality default (see confirmations) — the same caliber as chain-services
 * requiring an explicit UVP_FINALITY_CONFIRMATIONS outside local.
 */
export type StateMachineRuntimeEnvironment = 'local' | 'testnet' | 'staging' | 'production';

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
   * throwaway local chains. The silent default is only allowed for local (or
   * undeclared) runtime environments: with runtimeEnvironment set to a
   * non-local value, confirmations must be set explicitly to a positive
   * integer — a silent 1-block buffer lets a single-block reorg flip
   * already-processed logs past the cursor.
   */
  readonly confirmations?: number | string;
  /**
   * Declared runtime environment (default: local caliber). Non-local values
   * make an explicit confirmations setting mandatory.
   */
  readonly runtimeEnvironment?: StateMachineRuntimeEnvironment;
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
  /**
   * Run claims whose release write failed (store fault): retried every poll
   * round. A same-pid claim is always "held" for isHeldRunClaim, so a stuck
   * release silently excludes the job from this process's scans and from
   * manual retries forever — the opposite of the dead-holder takeover the
   * pid check provides for crashed processes.
   */
  private pendingClaimReleases = new Set<Hex>();

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
      ...(this.config.runtimeEnvironment ? { runtimeEnvironment: this.config.runtimeEnvironment } : {}),
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
    const store = this.config.cursorStore;
    if (!store) {
      // Nothing to restore; the latch only guards the store interaction.
      this.cursorRestored = true;
      return;
    }
    this.genesisHash = client ? await tryGetBlockHash(client, 0n) : undefined;
    const result = await store.load(this.cursorContext());
    // Latch only after the store reached a decision: a transient load failure
    // (EACCES, EMFILE, a full disk) must retry on the next poll instead of
    // permanently abandoning the persisted position — the next successful
    // round would otherwise save a fresh cursor over anchors that were never
    // read, silently discarding the old position and its checkpoints.
    this.cursorRestored = true;
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
    // Claim-release retries run before any early return of the round: a stuck
    // release must not wait for new blocks (the finality-lag path returns
    // before scanning).
    await this.retryPendingClaimReleases();
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
        // The adopted anchors sit at or beyond the stale cursor height: kept
        // against the corrected floor, the next continuity check mismatches by
        // construction and forces a false-reorg rollback to anchors the live
        // chain no longer supports.
        this.checkpoints = [];
        this.cursorBlockHash = undefined;
      } else {
        return { fromBlock, toBlock, scannedLogs: 0, results: [], decodeFailures: 0 };
      }
    } else {
      fromBlock = await this.enforceCursorContinuity(client, fromBlock);
    }

    if (fromBlock > toBlock) {
      // The finalized head has not caught up with the cursor yet — normal
      // finality lag, nothing to scan this round. Open jobs behind the cursor
      // still get their later-scan recheck: receipts do not wait for new blocks.
      const revisitResults = await this.revisitOpenJobs(fromBlock);
      return {
        fromBlock,
        toBlock,
        scannedLogs: 0,
        results: revisitResults,
        decodeFailures: revisitResults.filter((result) => result.decodeFailure).length,
      };
    }

    // Chunk deep ranges: one unbounded eth_getLogs over a large gap is exactly
    // the query RPC providers reject; a rejected catch-up round fails wholesale.
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
    // save that fails after the memory advance leaves the process holding an
    // unpersisted skip interval — combined with a crash, blocks would be
    // silently never rescanned by this or any restarted instance.
    const nextBlock = toBlock + 1n;
    // Stage this round's cursor evidence off to the side: persistence happens
    // first and the in-memory anchors are committed only after the save
    // succeeds. A save failure with the memory already updated left the next
    // round's continuity check comparing the new height against hashes the
    // persisted cursor never got — a false reorg that rolled the range back.
    const stagedCheckpoints = [...this.checkpoints];
    // Remember canonical hashes for the scanned range (dense near the tip,
    // exponentially sparser deeper) so a later reorg can locate the common
    // ancestor instead of falling back to a full rescan. A failed read of the
    // toBlock hash is "no evidence", not a reorg: keeping the previous round's
    // hash against the new height would make the next round's continuity check
    // mismatch by construction and roll back forever (a false-reorg loop).
    let roundCursorBlockHash: string | undefined;
    for (const anchorHeight of checkpointAnchorHeights(fromBlock, toBlock, this.config.reorgWindow)) {
      const anchorHash = await tryGetBlockHash(client, anchorHeight);
      if (anchorHash !== undefined) {
        recordCheckpoint(stagedCheckpoints, anchorHeight, anchorHash, this.config.reorgWindow);
        if (anchorHeight === toBlock) {
          roundCursorBlockHash = anchorHash;
        }
      }
    }
    // Later-scan pass over open jobs behind the cursor (detected leftovers,
    // unconfirmed broadcasts). It runs before the cursor advances so a crash
    // mid-pass leaves the range (and the recheck) to the next round.
    results.push(...await this.revisitOpenJobs(fromBlock));
    if (this.config.cursorStore) {
      await this.config.cursorStore.save(
        {
          nextBlock,
          ...(roundCursorBlockHash !== undefined ? { blockHash: roundCursorBlockHash } : {}),
          ...(stagedCheckpoints.length > 0 ? { checkpoints: stagedCheckpoints } : {}),
        },
        this.cursorContext(),
      );
    }
    this.nextBlock = nextBlock;
    this.checkpoints = stagedCheckpoints;
    this.cursorBlockHash = roundCursorBlockHash;

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
    // A finished dry-run pass is converged: re-running its handler would replay
    // handler side effects and pile simulated submissions onto the audit trail
    // on every rescan. Flipping dry-run off, or a manual retry (which re-opens
    // the job as `detected`), still re-runs the job for real.
    if (
      this.config.dryRun
      && job.status === 'matched'
      && job.submissions.some((submission) => submission.dryRun === true)
    ) {
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

    // 任务级原子认领：读-验-写竞态下两个执行器（watcher 扫描与手工
    // `jobs retry`）可同时进入同一 handler，链上幂等键保护不了 handler 的
    // 链外副作用。认领以 CAS 写入（expectStatus+expectClaimPid），输者读到
    // 活认领即跳过本轮；持有者死亡（pid 不存活）时认领视为崩溃残留，可被
    // 接管——搁浅的 matched 任务仍保留手工重试这条恢复通道。
    const claimOutcome = await this.claimForRun(job, resolved.key);
    if (claimOutcome.outcome !== 'claimed') {
      return {
        status: 'skipped',
        event,
        submissions: [],
        ...(claimOutcome.job ? { job: claimOutcome.job } : {}),
      };
    }
    try {
      return await this.processClaimedRun(claimOutcome.job, event, resolved, options);
    } finally {
      // 认领保护的是"进行中的运行"，不是任务状态：dry-run 收敛等出口会
      // 把任务留在 matched（非终态，等待真实运行接管），若只在终态写时
      // 释放认领，这类任务会被一个早已结束的运行永久占住。
      await this.releaseRunClaim(job.id);
    }
  }

  private async processClaimedRun(
    claimedJob: StateMachineWatcherJob,
    event: StateMachineHookReady,
    resolved: { readonly key: string; readonly handler: StateMachineHookReadyHandler },
    options?: {
      readonly resubmitDelivered?: boolean;
      readonly bypassResendBackoff?: boolean;
    },
  ): Promise<StateMachineLogProcessResult> {
    let job = claimedJob;
    let currentJob = claimedJob;
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
    ): Promise<SubmitStateMachineSignalResult | DeferredBroadcastOutcome> => {
      let lastError: ClassifiedExecutorKitError | undefined;
      for (let attemptForSignal = 1; attemptForSignal <= this.config.retry.maxAttempts; attemptForSignal += 1) {
        try {
          const result = await submitStateMachineSignal(eventSubmitConfig, signal);
          appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attemptForSignal, result));
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
          // same signal. Consult the receipt first; a receipt that cannot be
          // obtained is NOT provable absence, so the run defers the signal to
          // later scans (receipt recheck + resend backoff) instead of
          // rebroadcasting on unknown evidence — regardless of the remaining
          // in-run budget, an unknown outcome is never settled by retrying.
          if (classified.retryable && broadcastTxHash !== undefined) {
            const recovered = await this.recoverBroadcastSubmission(eventSubmitConfig, signal, broadcastTxHash);
            if (recovered) {
              appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attemptForSignal, recovered));
              currentJob = await this.updateJob(job.id, {
                updatedAt: this.config.now(),
                submissions: jobSubmissions,
                clearLastError: true,
              });
              return recovered;
            }
            return { deferredBroadcast: true };
          }
          if (!classified.retryable || attemptForSignal >= this.config.retry.maxAttempts) {
            // Keep the original error reachable through the cause chain: the
            // terminal-status guard must tell a receipt-observed revert apart
            // from a broadcast whose outcome is simply unknown.
            throw new ClassifiedStateMachineError(classified, { cause: error });
          }
          await delay(this.config.retry.baseDelayMs * attemptForSignal);
        }
      }

      throw new ClassifiedStateMachineError(lastError ?? classifyExecutorKitError(new Error('submission failed')));
    };

    // Context-channel submissions share the job audit trail with the
    // returned-signals path (README: already-broadcast transactions are never
    // dropped from it). signalIndex -1, -2, ... keeps context submissions from
    // aliasing returned-signal indexes in the resume/backoff machinery.
    // The channel also honors the same replay rules as the returned-signal
    // lane: an already-delivered signal is answered from its recorded evidence
    // instead of rebroadcast (unless the run resubmits delivered signals —
    // the manual reorg-recovery channel), and an unresolved prior broadcast
    // is settled by its receipt (or deferred under the resend backoff) before
    // any new transaction goes out.
    let contextSubmissionCount = 0;
    let deferredResend = false;
    // Negative indexes continue across runs instead of restarting at -1: the
    // delivery-evidence set and the terminal-status computation treat the
    // index as the context signal's identity, so a recycled index would let a
    // re-run's different context signal inherit a prior signal's delivery
    // evidence and mask its own unresolved broadcast.
    const priorContextSignalCount = new Set(
      jobSubmissions.filter((submission) => submission.signalIndex < 0).map((submission) => submission.signalIndex),
    ).size;
    const context: StateMachineHookReadyHandlerContext = {
      matchedKey: resolved.key,
      submitSignal: async (signal, overrides) => {
        const signalIndex = -1 - priorContextSignalCount - contextSubmissionCount;
        contextSubmissionCount += 1;
        const attempt = contextSubmissionCount;
        const submitConfig = normalizeSubmitConfig({ ...eventSubmitConfig, ...overrides });
        // Signal identity for the replay decisions below: submitSignal calldata
        // is a deterministic function of the four-tuple (plus an explicit key),
        // so equal data across runs means the same logical signal.
        const identityRequest = buildSubmitStateMachineSignalCall(submitConfig, signal);
        const priorRecords = jobSubmissions.filter((submission) => submission.request?.data === identityRequest.data);
        const deliveredPrior = options?.resubmitDelivered
          ? undefined
          : priorRecords.find((submission) =>
            submission.error?.kind === 'duplicate_signal'
            || (!submission.error && submission.dryRun === false && submission.confirmed === true));
        if (deliveredPrior?.txHash !== undefined && !deliveredPrior.dryRun) {
          // The chain already carries this signal by this job's own recorded
          // evidence; rebroadcasting could only collect another revert. Under
          // resubmitDelivered the operator declared that evidence invalid
          // (reorg), so the shortcut must not answer from it.
          return {
            dryRun: false,
            request: deliveredPrior.request ?? identityRequest,
            txHash: deliveredPrior.txHash,
            confirmed: true,
          };
        }
        const unresolvedPrior = priorRecords
          .filter((submission) => isUnconfirmedBroadcast(submission, submission.signalIndex))
          .at(-1);
        if (unresolvedPrior?.txHash !== undefined) {
          // Replay guard, same as the returned-signal lane: the prior
          // broadcast's outcome is unknown until its receipt says otherwise.
          const recovered = await this.recoverBroadcastSubmission(submitConfig, signal, unresolvedPrior.txHash);
          if (recovered) {
            // The recovered record keeps the prior broadcast's index: one
            // logical signal, one index in the history the terminal-status
            // computation intersects over.
            appendJobSubmission(jobSubmissions, toJobSubmission(
              unresolvedPrior.signalIndex,
              nextSubmissionAttempt(jobSubmissions, unresolvedPrior.signalIndex),
              recovered,
            ));
            currentJob = await this.updateJob(job.id, {
              updatedAt: this.config.now(),
              submissions: jobSubmissions,
              clearLastError: true,
            });
            return recovered;
          }
          const priorUnconfirmed = priorRecords
            .filter((submission) => isUnconfirmedBroadcast(submission, submission.signalIndex)).length;
          const requiredDelayMs = resendBackoffDelayMs(this.config.resendBackoff, priorUnconfirmed);
          const lastAttemptAtMs = Date.parse(currentJob.lastSignalAttemptAt ?? '');
          if (
            options?.bypassResendBackoff !== true
            && Number.isFinite(lastAttemptAtMs)
            && this.config.nowMs() - lastAttemptAtMs < requiredDelayMs
          ) {
            deferredResend = true;
            return { deferredBroadcast: true };
          }
          // Past the backoff window: fall through and rebroadcast — the
          // contract's SignalAlreadyExists dedupe absorbs it if the prior
          // transaction actually mined.
        }
        try {
          const result = await submitStateMachineSignal(submitConfig, signal);
          appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attempt, result));
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            ...(result.dryRun ? {} : { lastSignalAttemptAt: this.config.now() }),
            submissions: jobSubmissions,
          });
          return result;
        } catch (error) {
          const classified = classifyExecutorKitError(error);
          const broadcastTxHash = broadcastTxHashFromError(error);
          jobSubmissions.push({
            signalIndex,
            attempt,
            request: identityRequest,
            ...(broadcastTxHash ? { txHash: broadcastTxHash } : {}),
            error: classified,
          });
          if (broadcastTxHash !== undefined && !carriesKnownRevert(error)) {
            // The broadcast went out but its outcome is unknown. Handing the
            // handler a retryable-looking error invited an immediate second
            // transaction for the same signal; consult the receipt once and
            // otherwise defer to the later-scan recheck under the backoff.
            const recovered = await this.recoverBroadcastSubmission(submitConfig, signal, broadcastTxHash)
              .catch(() => undefined);
            if (recovered) {
              appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attempt, recovered));
              currentJob = await this.updateJob(job.id, {
                updatedAt: this.config.now(),
                submissions: jobSubmissions,
                clearLastError: true,
              });
              return recovered;
            }
            currentJob = await this.updateJob(job.id, {
              updatedAt: this.config.now(),
              lastSignalAttemptAt: this.config.now(),
              submissions: jobSubmissions,
              lastError: classified,
            });
            deferredResend = true;
            return { deferredBroadcast: true };
          }
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            lastSignalAttemptAt: this.config.now(),
            submissions: jobSubmissions,
            lastError: classified,
          });
          throw error;
        }
      },
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
        const failed = await this.concludeRun(job.id, {
          status: statusForTerminalError(error, classified, jobSubmissions),
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

    const submissions: SubmitStateMachineSignalResult[] = [];
    const signals = normalizeHandlerResult(handlerResult);
    // Records appended from this point on are "this run"; the offset separates
    // them from prior-run history for the terminal-status computation.
    const priorSubmissionCount = jobSubmissions.length;
    // The plan-scoped submitSignal ABI requires the order planId, resolved per
    // signal: an explicit pin (handler-supplied or the config
    // `signals[].planId` field) wins; otherwise the planId decoded from the
    // HookReady event itself (the authoritative carrier, so it outranks any
    // job-persisted value from older runs); the persisted job planId is the
    // last resort. A sibling signal's explicit pin is deliberately NOT a
    // fallback: multi-signal handlers may mix pinned and unpinned signals, and
    // borrowing one signal's pin for its siblings broadcast a planId the event
    // never carried — an on-chain revert that dead-lettered the whole job.
    const eventPlanId = event.planId !== ZERO_BYTES32 ? event.planId : undefined;
    const fallbackPlanId = eventPlanId ?? job.planId;
    if (eventPlanId !== undefined && job.planId === undefined) {
      const withPlanId = await this.updateJob(job.id, {
        updatedAt: this.config.now(),
        planId: normalizeBytes32(eventPlanId, 'job.planId'),
      });
      if (withPlanId) {
        job = withPlanId;
      }
    }
    // Resume support: a signal whose delivery is evidenced (receipt-confirmed
    // submission or duplicate_signal dedupe fact) is already on chain.
    // Re-running the job — manual `jobs retry` or a later scan of an open
    // job — must continue with the next pending signal instead of replaying
    // delivered ones; replaying them would dead-lock multi-signal jobs in
    // `ignored` on the first duplicate. Unconfirmed broadcasts are NOT here:
    // the recheck below resolves them by receipt first.
    const deliveredSignalIndexes = options?.resubmitDelivered
      ? new Set<number>()
      : deliveredSignalIndexesFromSubmissions(currentJob.submissions);
    // Receipt recheck for every broadcast whose outcome is still unknown — the
    // returned-signal lane, the handler-context `submitSignal` lane, and
    // signals the handler no longer emits. A mined success settles the signal
    // without a rebroadcast; a mined revert refutes the job whichever channel
    // put the tx on chain (a `waitForReceipt:false` revert must not stay open
    // forever); a receipt that cannot be obtained leaves the signal open for
    // the next scan under the resend backoff.
    for (const submission of [...currentJob.submissions]) {
      if (submission.txHash === undefined || !isUnconfirmedBroadcast(submission, submission.signalIndex)) {
        continue;
      }
      let receiptStatus: 'success' | 'reverted' | undefined;
      try {
        receiptStatus = await this.lookupBroadcastReceipt(eventSubmitConfig, submission.txHash);
      } catch (error) {
        const classified = classifyExecutorKitError(error);
        attempts += 1;
        // This path only fires on a receipt actually observed as 'reverted' —
        // the one receipt outcome lookupBroadcastReceipt treats as terminal —
        // so dead_letter/failed here never freezes a broadcast whose outcome
        // is unknown.
        const failed = await this.concludeRun(job.id, {
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
      if (receiptStatus === undefined) {
        continue;
      }
      appendJobSubmission(jobSubmissions, {
        signalIndex: submission.signalIndex,
        attempt: nextSubmissionAttempt(jobSubmissions, submission.signalIndex),
        dryRun: false,
        ...(submission.request ? { request: submission.request } : {}),
        txHash: submission.txHash,
        confirmed: receiptStatus === 'success',
      });
      if (submission.request) {
        submissions.push({
          dryRun: false,
          request: submission.request,
          txHash: submission.txHash,
          confirmed: receiptStatus === 'success',
        });
      }
      deliveredSignalIndexes.add(submission.signalIndex);
      currentJob = await this.updateJob(job.id, {
        updatedAt: this.config.now(),
        submissions: jobSubmissions,
        clearLastError: true,
      });
    }
    for (const [index, signal] of signals.entries()) {
      if (deliveredSignalIndexes.has(index)) {
        continue;
      }
      try {
        const resolvedSignal: StateMachineSignal = {
          ...signal,
          ...(signal.planId === undefined && fallbackPlanId !== undefined ? { planId: fallbackPlanId } : {}),
        };
        const priorUnconfirmedBroadcasts = unconfirmedBroadcastCount(currentJob.submissions, index);
        if (priorUnconfirmedBroadcasts > 0 && options?.bypassResendBackoff !== true) {
          // resend backoff: a rescan must not put the same transaction on
          // chain once per poll round — a growing, capped wait anchored to
          // lastSignalAttemptAt throttles the rebroadcast. A missing or
          // unparseable anchor loses the clock: the resend goes out
          // immediately instead of deferring forever on an anchor that never
          // existed (updatedAt is no substitute — it moves on unrelated
          // bookkeeping every round).
          const requiredDelayMs = resendBackoffDelayMs(this.config.resendBackoff, priorUnconfirmedBroadcasts);
          const lastAttemptAtMs = Date.parse(currentJob.lastSignalAttemptAt ?? '');
          if (Number.isFinite(lastAttemptAtMs) && this.config.nowMs() - lastAttemptAtMs < requiredDelayMs) {
            deferredResend = true;
            continue;
          }
        }
        const result = await submitSignalWithJobRetry(resolvedSignal, index);
        if ('deferredBroadcast' in result) {
          // The in-run replay guard deferred this signal (broadcast outcome
          // unknown, receipt unavailable): keep the job open for later scans.
          deferredResend = true;
          continue;
        }
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
        const failed = await this.concludeRun(job.id, {
          status: statusForTerminalError(error, classified, jobSubmissions),
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

    const finalStatus = statusForCompletedRun({
      dryRun: this.config.dryRun,
      deliveredSignalIndexes,
      signals,
      jobSubmissions,
      thisRunSubmissions: jobSubmissions.slice(priorSubmissionCount),
    });
    if (deferredResend) {
      // A deferred signal keeps the job open. Preserve updatedAt: rewriting
      // now() would restart the backoff clock on every deferred round.
      currentJob = await this.concludeRun(job.id, {
        status: finalStatus === 'matched' ? 'submitted' : finalStatus,
        updatedAt: currentJob.updatedAt,
        attempts,
        submissions: jobSubmissions,
      });
    } else {
      currentJob = await this.concludeRun(job.id, {
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
    const updated = await this.config.jobStore.update(jobId, withConclusiveClaimRelease(patch));
    if (!updated) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return updated;
  }

  /**
   * Run-concluding write for a claimed run: the status only lands while the
   * job is still in this run's `matched` state. A CAS miss means a concurrent
   * verdict (operator dead-letter racing the claim gate) landed first — that
   * write wins, so the run reports the stored job instead of overwriting its
   * status or clearing its reason.
   */
  private async concludeRun(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob> {
    const concluded = await this.config.jobStore.update(jobId, {
      ...withConclusiveClaimRelease(patch),
      expectStatus: 'matched',
    });
    if (concluded) {
      return concluded;
    }
    const current = await this.config.jobStore.get(jobId);
    if (!current) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return current;
  }

  /**
   * Atomically take the run claim for this job. Returns:
   * - `claimed`: this process owns the run (status `matched`, claim set);
   * - `busy`: a live foreign claim holds the job — another executor is mid-run;
   * - `terminal`: the job reached a terminal state since the caller last read it;
   * - `lost`: the CAS write lost a race twice in a row — yield this round.
   */
  private async claimForRun(
    job: StateMachineWatcherJob,
    matchedKey: string,
  ): Promise<
    | { readonly outcome: 'claimed'; readonly job: StateMachineWatcherJob }
    | { readonly outcome: 'busy' | 'terminal' | 'lost'; readonly job?: StateMachineWatcherJob }
  > {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await this.config.jobStore.get(job.id);
      if (!fresh) {
        return { outcome: 'lost' };
      }
      if (isTerminalJobStatus(fresh.status)) {
        return { outcome: 'terminal', job: fresh };
      }
      if (isHeldRunClaim(fresh.claim)) {
        return { outcome: 'busy', job: fresh };
      }
      const at = this.config.now();
      const claimed = await this.config.jobStore.update(job.id, {
        status: 'matched',
        updatedAt: at,
        matchedKey,
        claim: { pid: process.pid, at },
        expectStatus: fresh.status,
        expectClaimPid: fresh.claim?.pid ?? null,
      });
      if (claimed) {
        return { outcome: 'claimed', job: claimed };
      }
    }
    return { outcome: 'lost' };
  }

  /**
   * Release this process's run claim; a no-op when the conclusive status write
   * already released it (the CAS guard loses, which is fine). A release write
   * that REJECTS is not fine: the claim stays held by this live pid, so it is
   * queued for {@link retryPendingClaimReleases} and reported through onError.
   */
  private async releaseRunClaim(jobId: Hex): Promise<void> {
    try {
      await this.config.jobStore.update(jobId, {
        updatedAt: this.config.now(),
        claim: null,
        expectClaimPid: process.pid,
      });
    } catch (error) {
      this.pendingClaimReleases.add(jobId);
      this.config.onError?.(new ExecutorKitError(
        `failed to release the run claim for job ${jobId} (${describeError(error)});`
          + ` the job stays claimed by pid ${process.pid} and is excluded from scans and manual retries until the release succeeds; the release is retried every poll round`,
      ));
    }
  }

  /**
   * Periodic retry of failed claim releases (each poll round, before any early
   * return). A lost CAS race also counts as released: the claim is then no
   * longer held by this process (conclusive write released it, or an operator
   * cleared it).
   */
  private async retryPendingClaimReleases(): Promise<void> {
    if (this.pendingClaimReleases.size === 0) {
      return;
    }
    for (const jobId of [...this.pendingClaimReleases]) {
      try {
        await this.config.jobStore.update(jobId, {
          updatedAt: this.config.now(),
          claim: null,
          expectClaimPid: process.pid,
        });
        this.pendingClaimReleases.delete(jobId);
      } catch (error) {
        this.config.onError?.(new ExecutorKitError(
          `releasing the run claim for job ${jobId} failed again (${describeError(error)});`
            + ` the job remains claimed by pid ${process.pid} and excluded from scans and manual retries`,
        ));
      }
    }
  }

  /**
   * Direct receipt lookup shared by both recheck lanes. Resolves 'success' or
   * 'reverted' for a mined transaction, and undefined when the receipt cannot
   * be obtained (lookup threw, client cannot look receipts up, the tx is not
   * mined yet, or the receipt carries a status string the kit does not
   * recognize — an unrecognized value is an unknown outcome, not evidence of
   * a revert) — "unavailable" is not provable absence, so callers must NOT
   * rebroadcast on it.
   */
  private async lookupBroadcastReceipt(
    config: NormalizedSubmitConfig,
    txHash: Hex,
  ): Promise<'success' | 'reverted' | undefined> {
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
    if (receipt.status === 'reverted') {
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt status ${receipt.status}`, { reverted: true });
    }
    return receipt.status === 'success' ? 'success' : undefined;
  }

  /**
   * Replay guard for retryable broadcast failures: consult the receipt of the
   * already-broadcast transaction before any rebroadcast.
   *
   * - receipt mined with status success: returns a confirmed submission result
   *   built from the recovered tx, so no second transaction is sent;
   * - receipt mined with status 'reverted': the broadcast definitively
   *   reverted, so rebroadcasting is pointless — throws the same
   *   non-retryable receipt error as the direct receipt path;
   * - receipt unavailable (or carrying an unrecognized status): returns
   *   undefined. "Unavailable" is not provable absence, so callers must NOT
   *   rebroadcast on it — the in-run retry defers the signal and later scans
   *   re-check this receipt (under the resend backoff) until it resolves.
   */
  private async recoverBroadcastSubmission(
    config: NormalizedSubmitConfig,
    signal: StateMachineSignal,
    txHash: Hex,
  ): Promise<SubmitStateMachineSignalResult | undefined> {
    const receiptStatus = await this.lookupBroadcastReceipt(config, txHash);
    if (receiptStatus === undefined) {
      return undefined;
    }
    return {
      dryRun: false,
      request: buildSubmitStateMachineSignalCall(config, signal, config.walletAddress),
      txHash,
      confirmed: receiptStatus === 'success',
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

    const candidates = this.checkpoints
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

  /**
   * Later-scan pass over open jobs whose blocks are already behind the scan
   * cursor: `detected` jobs stranded by a crash between detection and
   * processing, `submitted` jobs whose broadcast was never confirmed, and
   * `matched` jobs stranded by a crash between the claim and the conclusive
   * status write — their claim holder is dead, so no run is in flight.
   * README watcher semantics promise these are replayed/rechecked on later
   * scans; without this pass the cursor moving past their block made that
   * promise unreachable (handleLog only ever ran for logs inside the current
   * poll window or via manual retry). A live claim keeps the job out: that
   * run is in flight right now. Cost is bounded: handleLog resolves the
   * receipt of an unconfirmed broadcast before anything else and the resend
   * backoff throttles rebroadcasts.
   */
  private async revisitOpenJobs(fromBlock: bigint): Promise<readonly StateMachineLogProcessResult[]> {
    const jobs = await this.config.jobStore.list();
    const watched = new Set(this.config.stateMachines.map((deployment) => deployment.stateMachineAddress.toLowerCase()));
    const open = jobs.filter((job) => {
      const strandedMatched = job.status === 'matched' && !isHeldRunClaim(job.claim);
      if (job.status !== 'detected' && job.status !== 'submitted' && !strandedMatched) {
        return false;
      }
      if (!job.raw) {
        return false;
      }
      if (job.raw.blockNumber !== undefined && job.raw.blockNumber !== null && job.raw.blockNumber >= fromBlock) {
        // Inside (or ahead of) this round's window: the scan loop itself owns
        // it this round, so the pass must not double-process it.
        return false;
      }
      if (job.stateMachineAddress && !watched.has(job.stateMachineAddress.toLowerCase())) {
        // Belongs to a state machine this watcher no longer scans; its signals
        // are not this deployment's to submit.
        return false;
      }
      return true;
    });
    const results: StateMachineLogProcessResult[] = [];
    for (const job of open) {
      const raw = job.raw;
      if (raw) {
        results.push(await this.handleLog(raw));
      }
    }
    return results;
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

export interface NormalizedStateMachineWatcherConfig extends NormalizedSubmitConfig {
  readonly supplierId?: string;
  readonly stateMachines: readonly NormalizedStateMachineDeploymentWatcherConfig[];
  readonly handlers: Readonly<Record<string, StateMachineHookReadyHandler>>;
  readonly artifact?: StateMachineArtifactIndex;
  readonly fromBlock?: bigint;
  readonly pollIntervalMs: number;
  readonly confirmations: number;
  readonly runtimeEnvironment?: StateMachineRuntimeEnvironment;
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

function normalizeStateMachineWatcherConfig(config: StateMachineWatcherConfig): NormalizedStateMachineWatcherConfig {
  const stateMachines = normalizeStateMachineDeployments(config);
  const defaultStateMachineAddress = config.stateMachineAddress ?? stateMachines[0]?.stateMachineAddress;
  if (!defaultStateMachineAddress) {
    throw new ValidationError('state machine watcher requires stateMachineAddress or stateMachines[]');
  }
  const runtimeEnvironment = normalizeRuntimeEnvironment(config.runtimeEnvironment);
  const confirmations = config.confirmations !== undefined
    ? parseNonNegativeSafeInteger(asNumberOrString(config.confirmations, 'confirmations'), 'confirmations')
    : undefined;
  if (runtimeEnvironment !== undefined && runtimeEnvironment !== 'local') {
    // Same caliber as chain-services env.ts: outside local the finality buffer
    // must be an explicit positive integer. The silent default 1 (and the
    // explicit 0 tip-scanning opt-in) are local throwaway-chain conveniences
    // that must not leak into shared environments.
    if (confirmations === undefined) {
      throw new ValidationError(
        `confirmations must be explicitly configured when runtimeEnvironment is ${runtimeEnvironment}:`
          + ` the default ${DEFAULT_FINALITY_CONFIRMATIONS}-block finality buffer lets a single-block reorg flip already-processed logs past the scan cursor`
          + ' (same caliber as chain-services UVP_FINALITY_CONFIRMATIONS)',
      );
    }
    if (confirmations === 0) {
      throw new ValidationError(
        `confirmations must be a positive integer when runtimeEnvironment is ${runtimeEnvironment};`
          + ' 0 (tip scanning) is only for local throwaway chains',
      );
    }
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
    ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
    pollIntervalMs: config.pollIntervalMs !== undefined
      ? parsePositiveInteger(config.pollIntervalMs, 'pollIntervalMs')
      : DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS,
    confirmations: confirmations ?? DEFAULT_FINALITY_CONFIRMATIONS,
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

export function normalizeStateMachineDeploymentConfig(
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

/**
 * Poll delay after consecutive failures: exponential from the base interval,
 * capped at POLL_FAILURE_BACKOFF_MULTIPLIER_CAP so a long RPC outage slows the
 * watcher down instead of aborting it or flooding the dead endpoint.
 */
function pollFailureDelayMs(pollIntervalMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 3);
  return pollIntervalMs * Math.min(2 ** exponent, POLL_FAILURE_BACKOFF_MULTIPLIER_CAP);
}

function normalizeRuntimeEnvironment(value: StateMachineRuntimeEnvironment | undefined): StateMachineRuntimeEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'local' || value === 'testnet' || value === 'staging' || value === 'production') {
    return value;
  }
  throw new ValidationError(`runtimeEnvironment must be local, testnet, staging, or production (got ${String(value)})`);
}
