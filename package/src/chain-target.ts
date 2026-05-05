export type ChainTarget = 'evm' | 'solana';

export class UnsupportedChainTargetError extends Error {
  override readonly name = 'UnsupportedChainTargetError';
  readonly target: string;

  constructor(target: string, message = `${target} target is reserved but not implemented`) {
    super(message);
    this.target = target;
  }
}
