import { isHex, type Address, type Hex } from 'viem';
import {
  normalizeAddress,
  type ProductSubmitTypedData,
} from '@uvp-eth/protocol-bindings';

export * from '@uvp-eth/protocol-bindings';

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
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
