import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildProductSubmitTypedData } from '@uvp-eth/protocol-bindings';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { signPreparedSignalContainer, type PreparedSignalContainer } from '../src/product.js';
import { ValidationError } from '../src/validation.js';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;
const otherContract = '0x9999999999999999999999999999999999999999' as const;
const privateKeyEnvName = 'UVP_SIGN_EXPECTED_DOMAIN_TEST_PRIVATE_KEY';

function bytes32(seed: string): Hex {
  return `0x${seed.padStart(64, '0')}` as const;
}

function preparedSubmission(input: { readonly chainId?: number; readonly verifyingContract?: Address } = {}): PreparedSignalContainer {
  const deadline = String(Math.floor(Date.now() / 1000) + 3600);
  return {
    prepareId: 'prep_anchor_1',
    taskId: 'task_anchor_1',
    orderId: 'order_anchor_1',
    intent: 'confirm_stage',
    submitter,
    status: 'prepared',
    expiresAt: '2026-05-01T00:05:00.000Z',
    humanSummary: {
      purpose: 'Submit task evidence',
      submitter,
    },
    typedData: buildProductSubmitTypedData({
      chainId: input.chainId ?? 31337,
      verifyingContract: input.verifyingContract ?? verifyingContract,
      planId: bytes32('06'),
      orderId: bytes32('01'),
      sourceId: bytes32('02'),
      signalId: bytes32('03'),
      payloadHash: bytes32('04'),
      idempotencyKey: bytes32('05'),
      submitter,
      deadline,
    }),
    evidence: [],
  };
}

function withPrivateKeyEnv(): () => void {
  const previous = process.env[privateKeyEnvName];
  process.env[privateKeyEnvName] = privateKey;
  return () => {
    if (previous === undefined) {
      delete process.env[privateKeyEnvName];
    } else {
      process.env[privateKeyEnvName] = previous;
    }
  };
}

describe('signPreparedSignalContainer 预期域锚', () => {
  it('预期锚与 prepared 域一致：放行并产出签名', async () => {
    const restore = withPrivateKeyEnv();
    try {
      const signed = await signPreparedSignalContainer({
        prepared: preparedSubmission(),
        privateKeyEnv: privateKeyEnvName,
        expectedDomain: { chainId: 31337, verifyingContract },
      });
      assert.match(signed.signature, /^0x[0-9a-fA-F]+$/u);
      assert.equal(signed.submitter, submitter);
    } finally {
      restore();
    }
  });

  it('chainId 不一致：fail-closed 拒绝，错误信息含两侧值', async () => {
    const restore = withPrivateKeyEnv();
    try {
      await assert.rejects(
        signPreparedSignalContainer({
          prepared: preparedSubmission({ chainId: 31337 }),
          privateKeyEnv: privateKeyEnvName,
          expectedDomain: { chainId: 1 },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /31337/u);
          assert.match(error.message, /\b1\b/u);
          assert.match(error.message, /chainId/u);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('verifyingContract 不一致：fail-closed 拒绝，错误信息含两侧地址', async () => {
    const restore = withPrivateKeyEnv();
    try {
      await assert.rejects(
        signPreparedSignalContainer({
          prepared: preparedSubmission({ verifyingContract }),
          privateKeyEnv: privateKeyEnvName,
          expectedDomain: { verifyingContract: otherContract },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /verifyingContract/u);
          const lowered = error.message.toLowerCase();
          assert.ok(lowered.includes(verifyingContract.toLowerCase()), `expected actual contract in message: ${error.message}`);
          assert.ok(lowered.includes(otherContract.toLowerCase()), `expected contract in message: ${error.message}`);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('verifyingContract 大小写不同但同址：放行', async () => {
    const restore = withPrivateKeyEnv();
    try {
      const signed = await signPreparedSignalContainer({
        prepared: preparedSubmission({ verifyingContract }),
        privateKeyEnv: privateKeyEnvName,
        expectedDomain: { verifyingContract: verifyingContract.toLowerCase() },
      });
      assert.match(signed.signature, /^0x[0-9a-fA-F]+$/u);
    } finally {
      restore();
    }
  });

  it('缺省预期锚：不比对域，保持既有放行行为', async () => {
    const restore = withPrivateKeyEnv();
    try {
      const signed = await signPreparedSignalContainer({
        prepared: preparedSubmission({ chainId: 31337, verifyingContract }),
        privateKeyEnv: privateKeyEnvName,
      });
      assert.match(signed.signature, /^0x[0-9a-fA-F]+$/u);
    } finally {
      restore();
    }
  });
});
