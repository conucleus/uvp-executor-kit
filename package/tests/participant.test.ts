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
  requestProductSubmitSignatureForTarget,
  type Eip1193Provider,
} from '@uvp-eth/executor-kit/participant';
import {
  UnsupportedChainTargetError,
  requestSolanaProductSubmitSignature,
} from '@uvp-eth/executor-kit/participant/solana';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address.toLowerCase() as `0x${string}`;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;
const planId = bytes32('06');
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
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });

    // UVPStateMachineSignal is plan-scoped — planId is the first
    // field of the signed message and callers must pass the real order planId
    // instead of relying on the builder's zero placeholder default.
    expect(typedData).toEqual({
      domain: {
        name: 'UVPStateMachine',
        version: '0.10',
        chainId: 31337,
        verifyingContract,
      },
      types: {
        UVPStateMachineSignal: [
          { name: 'planId', type: 'bytes32' },
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
        planId,
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

  it('rejects typed data built from the zero planId placeholder for real signing', () => {
    // The protocol-bindings builder tolerates an absent planId as a zero
    // placeholder for shape-checking gates; a signer must not accept that
    // placeholder because it can never pass the on-chain (planId, orderId)
    // existence check.
    const zeroPlanTypedData = buildProductSubmitTypedData({
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
    expect(zeroPlanTypedData.message.planId).toBe(`0x${'0'.repeat(64)}`);
  });

  it('recovers the signer for a Product submit signature', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
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
      planId,
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
    // planId is the first ABI argument of submitSignalFor.
    expect(call.args).toEqual([
      planId,
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
      planId,
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

  it('keeps EVM as the default participant signer target and reserves Solana', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = `0x${'cc'.repeat(65)}` as const;
    const provider: Eip1193Provider = {
      request: async () => signature,
    };

    await expect(requestProductSubmitSignatureForTarget({ provider, typedData, submitter })).resolves.toBe(signature);
    await expect(requestProductSubmitSignatureForTarget({
      target: 'solana',
      provider,
      typedData,
      submitter,
    })).rejects.toBeInstanceOf(UnsupportedChainTargetError);
    expect(() => requestSolanaProductSubmitSignature()).toThrow(UnsupportedChainTargetError);
  });

  it('hashes canonical JSON through the browser-safe helper', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(hashEvidenceJson({ b: 2, a: 1 }).evidenceHash).toBe(hashEvidenceJson({ a: 1, b: 2 }).evidenceHash);
  });
});

function bytes32(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, '0')}`;
}
