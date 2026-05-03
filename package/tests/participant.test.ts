import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  STATE_MACHINE_ABI,
  buildProductSubmitTypedData,
  buildSubmitSignalForCall,
  canonicalJson,
  hashEvidenceJson,
  recoverProductSubmitSigner,
  requestProductSubmitSignature,
  type Eip1193Provider,
} from '@uvp-eth/executor-kit/participant';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address.toLowerCase() as `0x${string}`;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;
const orderId = bytes32('01');
const sourceId = bytes32('02');
const signalId = bytes32('03');
const payloadHash = bytes32('04');
const idempotencyKey = bytes32('05');
const deadline = '1777777777';

describe('participant entrypoint', () => {
  it('builds stable Product submit typed data', () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });

    expect(typedData).toEqual({
      domain: {
        name: 'UVPStateMachine',
        version: '0.2',
        chainId: 31337,
        verifyingContract,
      },
      types: {
        UVPStateMachineSignal: [
          { name: 'orderId', type: 'bytes32' },
          { name: 'sourceId', type: 'bytes32' },
          { name: 'signalId', type: 'bytes32' },
          { name: 'payloadHash', type: 'bytes32' },
          { name: 'idempotencyKey', type: 'bytes32' },
          { name: 'submitter', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'UVPStateMachineSignal',
      message: {
        orderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter,
        deadline,
      },
    });
  });

  it('recovers the signer for a Product submit signature', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = await account.signTypedData(
      typedData as unknown as Parameters<typeof account.signTypedData>[0],
    );

    await expect(recoverProductSubmitSigner(typedData, signature)).resolves.toBe(submitter);
  });

  it('builds submitSignalFor contract calls from the shared ABI', () => {
    const signature = `0x${'aa'.repeat(65)}` as const;
    const call = buildSubmitSignalForCall({
      stateMachineAddress: verifyingContract,
      chainId: 31337,
    }, {
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
      signature,
    });

    expect(call).toMatchObject({
      address: verifyingContract,
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignalFor',
      chainId: 31337,
    });
    expect(call.args).toEqual([
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      BigInt(deadline),
      signature,
    ]);
    expect(call.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it('requests injected wallet typed-data signatures', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = `0x${'bb'.repeat(65)}` as const;
    const requests: unknown[] = [];
    const provider: Eip1193Provider = {
      request: async (input) => {
        requests.push(input);
        return signature;
      },
    };

    await expect(requestProductSubmitSignature(provider, typedData, submitter)).resolves.toBe(signature);
    expect(requests).toEqual([
      {
        method: 'eth_signTypedData_v4',
        params: [submitter, JSON.stringify(typedData)],
      },
    ]);
  });

  it('hashes canonical JSON through the browser-safe helper', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(hashEvidenceJson({ b: 2, a: 1 }).evidenceHash).toBe(hashEvidenceJson({ a: 1, b: 2 }).evidenceHash);
  });
});

function bytes32(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, '0')}`;
}
