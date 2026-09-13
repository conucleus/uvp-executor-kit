import { readFile } from 'node:fs/promises';
import { ValidationError } from '../../validation.js';
import { asString, isNodeError, isRecord } from '../internal.js';
import { quarantineCorruptStateFile, writeStateFileAtomically } from './file.js';

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
