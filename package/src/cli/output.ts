import type { Address, Hex } from 'viem';
import type { ClassifiedExecutorKitError } from '../errors.js';
import { dedupe } from '../watcher/internal.js';
import {
  latestSubmissionTxHash,
  type StateMachineJobStatus,
  type StateMachineWatcherJob,
} from '../watcher/jobs/model.js';
import { normalizeStateMachineDeploymentConfig } from '../watcher/watcher.js';
import type {
  ExecutorCallbackMode,
  StateMachineHandlerConfig,
} from '../watcher/execution/handler.js';

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

/**
 * True when one log-processing outcome carries an error or ended in a terminal
 * failure state. Used to drive honest process exit codes: a chain-once scan or
 * jobs retry whose callback submission failed must exit non-zero even though
 * the result object itself was produced without throwing.
 */
export function executionOutcomeFailed(result: {
  readonly error?: unknown;
  readonly job?: { readonly status?: string };
}): boolean {
  return Boolean(result.error)
    || result.job?.status === 'failed'
    || result.job?.status === 'dead_letter';
}

/**
 * Outcome error kinds that classify a skip, not a run failure:
 * `missing_handler` is a foreign HookReady event this executor is not
 * configured for (a shared chain always carries other suppliers' hooks), and
 * `duplicate_signal` is the chain's own dedupe fact for an already-delivered
 * signal. A scan that only met these must exit 0.
 */
const BENIGN_SCAN_OUTCOME_ERROR_KINDS = new Set(['missing_handler', 'duplicate_signal']);

export function chainPollExecutionFailed(poll: {
  readonly results?: readonly {
    readonly error?: unknown;
    readonly job?: { readonly status?: string };
  }[];
}): boolean {
  return (poll.results ?? []).some((result) => {
    if (!executionOutcomeFailed(result)) {
      return false;
    }
    const kind = (result.error as { readonly kind?: string } | undefined)?.kind;
    return !BENIGN_SCAN_OUTCOME_ERROR_KINDS.has(kind ?? '');
  });
}
