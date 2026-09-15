import { ValidationError } from '../../validation.js';
import type { StateMachineRawLog } from '../../signal/decode.js';

/**
 * Max blocks per eth_getLogs request. A deep-lag catch-up round issuing one
 * unbounded query gets it rejected outright by RPC providers, failing every
 * round. Mirrors the chain-services indexer span.
 */
export const DEFAULT_GET_LOGS_BLOCK_SPAN = 9_999;

export function compareRawLogs(left: StateMachineRawLog, right: StateMachineRawLog): number {
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

/** Chunk [fromBlock, toBlock] into inclusive spans of at most maxSpan blocks. */
export function blockRanges(
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
