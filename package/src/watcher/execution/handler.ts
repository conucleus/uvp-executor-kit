import { readFile } from 'node:fs/promises';
import type { Address, Hex } from 'viem';
import { ZERO_BYTES32 } from '../../constants.js';
import {
  normalizeAddress,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../../validation.js';
import { asNonEmptyString, asNumberOrString, dedupe, isRecord } from '../internal.js';
import { normalizeRetryConfig, type StateMachineRetryConfig } from '../jobs/retry.js';
import type { StateMachineArtifactIndex, StateMachineHookReady } from '../../signal/decode.js';
import type { StateMachineSignal, SubmitStateMachineSignalConfig } from '../../signal/build.js';
import type { SubmitStateMachineSignalResult } from '../../signal/submit.js';
import type { StateMachineDeploymentWatcherConfig } from '../watcher.js';

export interface StateMachineHookReadyHandlerContext {
  readonly matchedKey: string;
  /**
   * Submit one signal through the handler-context channel. Resolves with the
   * submission result, or with `{ deferredBroadcast: true }` when the signal's
   * prior broadcast has an unknown outcome (or is inside the resend backoff
   * window): the transaction is already on chain or throttled, and a later
   * scan — not another in-run broadcast — settles it. Handlers must treat the
   * deferred marker as "pending, do not retry now", not as success.
   */
  readonly submitSignal: (
    signal: StateMachineSignal,
    overrides?: Partial<SubmitStateMachineSignalConfig>,
  ) => Promise<SubmitStateMachineSignalResult | DeferredBroadcastOutcome>;
}

export type StateMachineHookReadyHandlerResult =
  | void
  | StateMachineSignal
  | readonly StateMachineSignal[];

export type StateMachineHookReadyHandler = (
  event: StateMachineHookReady,
  context: StateMachineHookReadyHandlerContext,
) => StateMachineHookReadyHandlerResult | Promise<StateMachineHookReadyHandlerResult>;

/**
 * A retryable failure already put a transaction on chain, but its receipt
 * could not be obtained (lookup fault, client without receipt support, or not
 * mined yet). That is "outcome unknown", not provable absence — the run must
 * not blind-rebroadcast. The signal stays open and later scans re-check the
 * receipt, rebroadcasting only under the resend backoff. The handler-context
 * `submitSignal` channel resolves with this marker for the same condition.
 */
export type DeferredBroadcastOutcome = { readonly deferredBroadcast: true };

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

export type ExecutorCallbackMode = 'manual' | 'auto' | 'webhook';

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
        // No key-level default here: the config-only shape
        // orderId:hookId:signalName collapsed a re-emitted HookReady for the
        // same (order, hook) and distinct sources behind the same signalName
        // onto one chain idempotency key. Omitting the field lets the SDK
        // default apply — the logical (planId, orderId, sourceId, signalId)
        // tuple the contract itself dedupes on, the same caliber for config
        // and SDK producers.
      })),
    ]),
  );
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
    ...(typeof value.idempotencyKey === 'string' ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(typeof value.planId === 'string' ? { planId: normalizeBytes32(value.planId, `${path}.planId`) } : {}),
  };
}

export function normalizeArtifactIndex(value: StateMachineArtifactIndex): StateMachineArtifactIndex {
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

function normalizeCallbackMode(value: string): ExecutorCallbackMode {
  if (value === 'manual' || value === 'auto' || value === 'webhook') {
    return value;
  }
  throw new ValidationError('callbackMode must be manual, auto, or webhook');
}
