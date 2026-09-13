import { encodeFunctionData, keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import { DEFAULT_SIGNING_KEY_ENV } from '../signing.js';
import {
  normalizeAddress,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../validation.js';
import { ZERO_BYTES32 } from '../constants.js';
import { asNonEmptyString } from '../watcher/internal.js';
import type { StateMachineRawLog } from './decode.js';


export const DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV = DEFAULT_SIGNING_KEY_ENV;

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

export interface NormalizedSubmitConfig extends SubmitStateMachineSignalConfig {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly walletAddress?: Address;
  readonly privateKeyEnv: string;
  readonly dryRun: boolean;
  readonly waitForReceipt: boolean;
}

export function normalizeSubmitConfig(config: SubmitStateMachineSignalConfig): NormalizedSubmitConfig {
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
  // Signal attribution is mandatory: hashing the empty string here minted one
  // constant pseudo sourceId shared by every unattributed signal, silently
  // collapsing the chain's (…, sourceId, signalId) identity across producers.
  if (signal.sourceId === undefined && (signal.source ?? '').trim().length === 0) {
    throw new ValidationError(
      'signal.source (or signal.sourceId) is required to submit a state machine signal: without an explicit source the sourceId would be a constant keccak("") shared by every unattributed signal',
    );
  }
  const sourceId = signal.sourceId
    ? normalizeBytes32(signal.sourceId, 'sourceId')
    : hashText(signal.source!, 'source');
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
    // Default keyed to the contract's SignalAlreadyExists tuple
    // (planId, orderId, sourceId, signalId): the same logical signal keeps the
    // same key even when its HookReady event is re-emitted in a new
    // transaction after a deep reorg, so the chain's dedupe sees one identity
    // instead of a fresh key per event anchor (which put a guaranteed-reverting
    // duplicate broadcast on chain).
    idempotencyKey: signal.idempotencyKey
      ? hashText(signal.idempotencyKey, 'idempotencyKey')
      : hashText(`${planId}:${orderId}:${sourceId}:${signalId}`, 'idempotencyKey'),
    // The emitting HookReady event anchor is off-chain correlation context
    // only. It is deliberately absent from both the call args and the default
    // key: the contract never sees it, and off-chain metadata must not
    // participate in the idempotency verdict (EXEC kit ruling #21).
  };
}

function hashText(value: string, fieldName: string): Hex {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return keccak256(stringToBytes(value));
}
