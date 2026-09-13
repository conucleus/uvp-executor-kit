import { decodeEventLog, encodeAbiParameters, keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import { normalizeAddress, normalizeBytes32, ValidationError } from '../validation.js';
import { asString, describeError } from '../watcher/internal.js';

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
export function tryHookReadyEventId(log: StateMachineRawLog): Hex | undefined {
  try {
    return hookReadyEventId(log);
  } catch {
    return undefined;
  }
}

export function tryNormalizeStateMachineAddress(address: Address | string | undefined): Address | undefined {
  if (address === undefined) {
    return undefined;
  }
  try {
    return normalizeAddress(address, 'log.address');
  } catch {
    return undefined;
  }
}
