import { UnsupportedChainTargetError } from '../chain-target.js';

export interface SolanaParticipantSigner {
  readonly target: 'solana';
  readonly publicKey?: string;
}

export function requestSolanaProductSubmitSignature(): never {
  throw new UnsupportedChainTargetError('solana', 'solana participant signing is reserved but not implemented');
}

export { UnsupportedChainTargetError } from '../chain-target.js';
