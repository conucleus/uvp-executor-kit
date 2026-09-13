import { isProcessAlive } from '../internal.js';
import type { StateMachineJobPatch } from './model.js';

/**
 * 结论性状态写入释放运行认领：只有 `matched` 是运行中的占位状态，其余状
 * 态都意味着本轮运行已结束（含 submitted——回执未知但本轮不再推进，后续
 * 扫描重跑时会重新认领）。
 */
export function withConclusiveClaimRelease(patch: StateMachineJobPatch): StateMachineJobPatch {
  return patch.status !== undefined && patch.status !== 'matched' && patch.claim === undefined
    ? { ...patch, claim: null }
    : patch;
}

/**
 * Any held claim blocks a second executor: a foreign pid counts as held while
 * its process is alive, a same-pid claim is always held — the only way it can
 * exist is a run currently in flight inside this process (another watcher
 * instance or CLI entry), since every concluded run releases its claim.
 */
export function isHeldRunClaim(
  claim: { readonly pid: number; readonly at: string } | undefined,
): boolean {
  if (claim === undefined) {
    return false;
  }
  return claim.pid === process.pid || isProcessAlive(claim.pid);
}
