import type { StateMachinePublicClient } from '../../signal/build.js';
import type { StateMachineCursorCheckpoint } from '../storage/cursor.js';

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
 * Canonical block hash or undefined. Lookups can legitimately fail (pruned
 * node, client without block support, RPC hiccup); the reorg defenses treat
 * that as "no evidence" and keep the finality buffer as the only line rather
 * than failing the round.
 */
export async function tryGetBlockHash(client: StateMachinePublicClient, blockNumber: bigint): Promise<string | undefined> {
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

export function sameBlockHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Record one (height, hash) anchor into a checkpoint list, in place: dedupe
 * by height, keep the list sorted, and trim the stored body (not just a read
 * view) to the reorg window — re-sorting and re-persisting the full anchor
 * history every round would rewrite ~150k anchors/day, unbounded.
 */
export function recordCheckpoint(
  checkpoints: StateMachineCursorCheckpoint[],
  blockNumber: bigint,
  blockHash: string,
  reorgWindow: number,
): void {
  const filtered = checkpoints.filter((checkpoint) => checkpoint.blockNumber !== blockNumber);
  filtered.push({ blockNumber, blockHash });
  filtered.sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0));
  const trimmed = filtered.slice(-reorgWindow);
  checkpoints.length = 0;
  checkpoints.push(...trimmed);
}

/**
 * Heights to anchor this round, newest-first with exponentially growing gaps
 * (0, 1, 3, 7, ...): reorgs concentrate near the tip where anchors are dense,
 * while a deep one degrades to the full-rescan floor anyway. Bounded by the
 * configured reorg window and by fromBlock (lower blocks were anchored by the
 * round that actually scanned them).
 */
export function checkpointAnchorHeights(fromBlock: bigint, toBlock: bigint, reorgWindow: number): readonly bigint[] {
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
