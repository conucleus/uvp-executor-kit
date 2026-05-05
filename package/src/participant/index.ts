import { isHex, type Address, type Hex } from 'viem';
import {
  normalizeAddress,
  type ProductSubmitTypedData,
} from '@uvp-eth/protocol-bindings';
import { UnsupportedChainTargetError, type ChainTarget } from '../chain-target.js';

export * from '@uvp-eth/protocol-bindings';

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
}

export interface ProductSubmitSignatureRequest {
  readonly target?: ChainTarget;
  readonly provider: Eip1193Provider;
  readonly typedData: ProductSubmitTypedData;
  readonly submitter: Address | string;
}

export async function requestProductSubmitSignature(
  provider: Eip1193Provider,
  typedData: ProductSubmitTypedData,
  submitter: Address | string,
): Promise<Hex> {
  const normalizedSubmitter = normalizeAddress(submitter, 'submitter');
  if (normalizedSubmitter !== normalizeAddress(typedData.message.submitter, 'typedData.message.submitter')) {
    throw new Error('submitter does not match typedData.message.submitter');
  }

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [normalizedSubmitter, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string' || !isHex(signature)) {
    throw new Error('wallet returned an invalid hex signature');
  }
  return signature;
}

export async function requestProductSubmitSignatureForTarget(
  input: ProductSubmitSignatureRequest,
): Promise<Hex> {
  const target = input.target ?? 'evm';
  switch (target) {
    case 'evm':
      return requestProductSubmitSignature(input.provider, input.typedData, input.submitter);
    case 'solana':
      throw new UnsupportedChainTargetError('solana', 'solana participant signing is reserved but not implemented');
  }
}

export { UnsupportedChainTargetError } from '../chain-target.js';
export type { ChainTarget } from '../chain-target.js';
