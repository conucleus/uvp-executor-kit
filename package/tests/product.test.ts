import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProductSubmitTypedData } from '@uvp-eth/protocol-bindings';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { main } from '../src/cli.js';
import {
  getSignalContainerProof,
  listSignalContainers,
  prepareSignalContainer,
  signPreparedSignalContainer,
  summarizeSignalContainer,
  type PreparedSignalContainer,
  type ProductApiFetch,
  type ProductApiFetchInit,
  type ProductApiFetchResponse,
} from '../src/product.js';
import { UnsupportedChainTargetError } from '../src/chain-target.js';
import { ValidationError } from '../src/validation.js';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address;
const otherWallet = '0x2222222222222222222222222222222222222222' as const;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;

describe('Product API mode', () => {
  it('parses Product API task and prepare responses', async () => {
    const calls: Array<{ url: string; init?: ProductApiFetchInit }> = [];
    const fetch: ProductApiFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/product/tasks?')) {
        return jsonResponse({
          tasks: [
            {
              taskId: 'task_1',
              orderId: 'order_1',
              title: 'Confirm customs release',
              status: 'open',
              sourceId: bytes32('02'),
              signalId: bytes32('03'),
            },
          ],
        });
      }
      return jsonResponse(preparedSubmission());
    };

    const tasks = await listSignalContainers({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      fetch,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: 'task_1',
      orderId: 'order_1',
      title: 'Confirm customs release',
      status: 'open',
    });
    expect(calls[0]?.url).toBe(`http://chain.local/api/product/tasks?assignee=${submitter}`);

    const prepared = await prepareSignalContainer({
      chainServicesUrl: 'http://chain.local/api',
      taskId: 'task_1',
      walletAddress: submitter,
      evidenceIds: ['ev_1'],
      intent: 'confirm_stage',
      fetch,
    });
    expect(prepared).toMatchObject({
      prepareId: 'prep_1',
      submitter,
      typedData: {
        message: {
          submitter,
        },
      },
    });
    expect(JSON.parse(calls[1]?.init?.body ?? '{}')).toEqual({
      evidenceIds: ['ev_1'],
      walletAddress: submitter,
      intent: 'confirm_stage',
    });
  });

  it('fails closed on malformed Product API task responses', async () => {
    const fetch: ProductApiFetch = async () => jsonResponse({ task: { taskId: 'wrong_shape' } });

    await expect(listSignalContainers({
      chainServicesUrl: 'http://chain.local',
      walletAddress: submitter,
      fetch,
    })).rejects.toThrow(ValidationError);
  });

  it('rejects wallet mismatch before signing prepared typed data', async () => {
    const envName = 'UVP_PRODUCT_TEST_PRIVATE_KEY';
    const previous = process.env[envName];
    process.env[envName] = privateKey;
    try {
      await expect(signPreparedSignalContainer({
        prepared: preparedSubmission(),
        privateKeyEnv: envName,
        walletAddress: otherWallet,
      })).rejects.toThrow('typedData.message.submitter does not match configured wallet');
    } finally {
      restoreEnv(envName, previous);
    }
  });

  it('reserves Solana prepared signal signing behind an explicit error', async () => {
    await expect(signPreparedSignalContainer({
      target: 'solana',
      prepared: preparedSubmission(),
      privateKeyEnv: 'UVP_PRODUCT_TEST_PRIVATE_KEY',
    })).rejects.toBeInstanceOf(UnsupportedChainTargetError);
  });

  it('requires an explicit private key env value before signing', async () => {
    const envName = 'UVP_PRODUCT_MISSING_PRIVATE_KEY';
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      await expect(signPreparedSignalContainer({
        prepared: preparedSubmission(),
        privateKeyEnv: envName,
      })).rejects.toThrow(`missing private key env var ${envName}`);
    } finally {
      restoreEnv(envName, previous);
    }
  });

  it('rejects private key signer mismatch before submitting a prepared signal', async () => {
    const envName = 'UVP_PRODUCT_SIGNER_MISMATCH_PRIVATE_KEY';
    const previous = process.env[envName];
    process.env[envName] = privateKey;
    try {
      await expect(signPreparedSignalContainer({
        prepared: preparedSubmission({ submitter: otherWallet }),
        privateKeyEnv: envName,
        walletAddress: otherWallet,
      })).rejects.toThrow('private key signer does not match configured wallet');
    } finally {
      restoreEnv(envName, previous);
    }
  });

  it('summarizes funding placeholder tasks as standard signal containers', () => {
    const summary = summarizeSignalContainer({
      taskId: 'task_funding',
      orderId: 'order_1',
      title: 'Confirm guarantee coverage',
      status: 'open',
      sourceId: bytes32('02'),
      signalId: bytes32('03'),
      fulfillmentKind: 'payment_placeholder',
      fundingImpact: 'Adapter placeholder: records funding condition only; no custody or settlement by UVP.',
      primaryActionLabel: 'Confirm funding condition',
      requiredInputs: [
        {
          inputId: 'funding-condition',
          label: 'Funding condition',
          inputType: 'payment_placeholder',
          required: true,
          completed: true,
        },
      ],
      settlementPreview: {
        label: 'Stablecoin adapter placeholder',
        statusLabel: 'No funds are held by UVP',
        adapterStatus: 'placeholder',
        disclaimer: 'Records proof only.',
      },
      capabilityPlugin: {
        pluginKind: 'payment_placeholder',
        source: 'explicit',
        requiredEvidence: ['guarantee-proof'],
      },
      businessPersonaLabels: ['Guarantor'],
      proofRows: [{ label: 'Event', value: 'SignalSubmitted' }],
    });

    expect(summary).toMatchObject({
      taskId: 'task_funding',
      fulfillmentKind: 'payment_placeholder',
      fundingImpact: expect.stringContaining('no custody'),
      primaryActionLabel: 'Confirm funding condition',
      businessPersonaLabels: ['Guarantor'],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('payment_placeholder');
    expect(serialized).not.toContain('sourceId');
    expect(serialized).not.toContain('signalId');
  });

  it('prints Product task JSON without low-level signal identifiers', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async () => jsonResponse({
      tasks: [
        {
          taskId: 'task_cli',
          orderId: 'order_cli',
          title: 'CLI task',
          status: 'open',
          sourceId: bytes32('02'),
          signalId: bytes32('03'),
          stageIdentifier: 'export.customs',
        },
      ],
    })) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'product',
        'tasks',
        '--chain-services-url',
        'http://chain.local',
        '--wallet-address',
        submitter,
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as { tasks?: Array<{ taskId?: string }> };
      expect(output.tasks?.[0]?.taskId).toBe('task_cli');
      expect(logs[0]).not.toContain('sourceId');
      expect(logs[0]).not.toContain('signalId');
      expect(logs[0]).not.toContain('stageIdentifier');
    } finally {
      console.log = originalLog;
      restoreFetch(originalFetch);
    }
  });

  it('signs and submits from an explicit env var without printing secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-product-submit-'));
    const preparedFile = join(dir, 'prepared.json');
    const envName = 'UVP_PRODUCT_SUBMIT_PRIVATE_KEY';
    const previousEnv = process.env[envName];
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs: string[] = [];
    let requestBody = '';
    process.env[envName] = privateKey;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (_url, init) => {
      requestBody = typeof init?.body === 'string' ? init.body : '';
      return jsonResponse({
        submissionId: 'sub_1',
        prepareId: 'prep_1',
        taskId: 'task_1',
        orderId: 'order_1',
        status: 'submitted',
        intent: 'confirm_stage',
        submitter,
        signatureStatus: 'signature_verified',
        broadcastStatus: 'submitted',
        txHash: bytes32('44'),
        attemptCount: 1,
        sourceId: bytes32('02'),
        signalId: bytes32('03'),
        proofRows: [{ label: 'Transaction', value: bytes32('44') }],
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await writeFile(preparedFile, JSON.stringify({ prepared: preparedSubmission() }));
      await main([
        'node',
        'uvp-executor',
        'product',
        'submit',
        'task_1',
        '--chain-services-url',
        'http://chain.local',
        '--prepared-file',
        preparedFile,
        '--private-key-env',
        envName,
      ]);

      const submittedBody = JSON.parse(requestBody) as { signature?: string; walletAddress?: string };
      expect(submittedBody.walletAddress).toBe(submitter);
      expect(submittedBody.signature).toMatch(/^0x[0-9a-f]+$/i);
      expect(logs[0]).toContain('"submissionId":"sub_1"');
      expect(logs[0]).not.toContain(privateKey);
      expect(logs[0]).not.toContain(submittedBody.signature ?? 'missing-signature');
      expect(logs[0]).not.toContain('sourceId');
      expect(logs[0]).not.toContain('signalId');
    } finally {
      console.log = originalLog;
      restoreFetch(originalFetch);
      restoreEnv(envName, previousEnv);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints Product proof and status JSON without signatures or low-level identifiers', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    const fakeSignature = `0x${'ab'.repeat(65)}`;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async () => jsonResponse({
      submissionId: 'sub_1',
      prepareId: 'prep_1',
      taskId: 'task_1',
      orderId: 'order_1',
      status: 'confirmed',
      intent: 'confirm_stage',
      submitter,
      signature: fakeSignature,
      signatureHash: bytes32('66'),
      recoveredSubmitter: submitter,
      signatureStatus: 'signature_verified',
      broadcastStatus: 'confirmed',
      txHash: bytes32('44'),
      blockNumber: '123',
      sourceId: bytes32('02'),
      signalId: bytes32('03'),
      stageIdentifier: 'export.customs',
      proofRows: [{ label: 'Transaction', value: bytes32('44') }],
    })) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'product',
        'proof',
        'sub_1',
        '--chain-services-url',
        'http://chain.local',
      ]);
      await main([
        'node',
        'uvp-executor',
        'product',
        'status',
        'sub_1',
        '--chain-services-url',
        'http://chain.local',
      ]);

      for (const output of logs) {
        expect(output).toContain('"submissionId":"sub_1"');
        expect(output).toContain('"status":"confirmed"');
        expect(output).toContain('"txHash"');
        expect(output).not.toContain(fakeSignature);
        expect(output).not.toContain('signatureHash');
        expect(output).not.toContain('recoveredSubmitter');
        expect(output).not.toContain('sourceId');
        expect(output).not.toContain('signalId');
        expect(output).not.toContain('stageIdentifier');
      }
    } finally {
      console.log = originalLog;
      restoreFetch(originalFetch);
    }
  });

  it('exposes raw Product API fields in verbose proof/status mode', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    const fakeSignature = `0x${'ab'.repeat(65)}`;
    const sourceIdHex = bytes32('02');
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async () => jsonResponse({
      submissionId: 'sub_verb',
      prepareId: 'prep_verb',
      taskId: 'task_verb',
      orderId: 'order_verb',
      status: 'confirmed',
      intent: 'confirm_stage',
      submitter,
      signature: fakeSignature,
      signatureStatus: 'signature_verified',
      broadcastStatus: 'confirmed',
      txHash: bytes32('55'),
      blockNumber: '456',
      sourceId: sourceIdHex,
      signalId: bytes32('03'),
      stageIdentifier: 'export.customs',
      proofRows: [{ label: 'Transaction', value: bytes32('55') }],
    })) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'product',
        'proof',
        'sub_verb',
        '--chain-services-url',
        'http://chain.local',
        '--verbose',
      ]);
      const output = logs[0] ?? '';
      const parsed = JSON.parse(output) as { submission?: Record<string, unknown> };
      expect(parsed.submission?.submissionId).toBe('sub_verb');
      expect(parsed.submission?.sourceId).toBe(sourceIdHex);
      expect(parsed.submission?.signalId).toBe(bytes32('03'));
      expect(parsed.submission?.stageIdentifier).toBe('export.customs');
      expect(output).toContain(fakeSignature);
    } finally {
      console.log = originalLog;
      restoreFetch(originalFetch);
    }
  });

  it('reads Product submission proof/status through the SDK', async () => {
    const fetch: ProductApiFetch = async (url) => {
      expect(url).toBe('http://chain.local/product/submissions/sub_1');
      return jsonResponse({
        submissionId: 'sub_1',
        prepareId: 'prep_1',
        taskId: 'task_1',
        orderId: 'order_1',
        status: 'confirmed',
        txHash: bytes32('44'),
        proofRows: [{ label: 'Transaction', value: bytes32('44') }],
      });
    };

    await expect(getSignalContainerProof({
      chainServicesUrl: 'http://chain.local',
      submissionId: 'sub_1',
      fetch,
    })).resolves.toMatchObject({
      submissionId: 'sub_1',
      status: 'confirmed',
    });
  });
});

function preparedSubmission(options: { readonly submitter?: Address } = {}): PreparedSignalContainer {
  const preparedSubmitter = options.submitter ?? submitter;
  const orderId = bytes32('01');
  const sourceId = bytes32('02');
  const signalId = bytes32('03');
  const payloadHash = bytes32('04');
  const idempotencyKey = bytes32('05');
  const deadline = '1777777777';
  return {
    prepareId: 'prep_1',
    taskId: 'task_1',
    orderId: 'order_1',
    onchainOrderId: orderId,
    stageIdentifier: 'export.customs',
    signalName: 'confirm_stage',
    sourceId,
    signalId,
    intent: 'confirm_stage',
    payloadHash,
    payloadRef: 'ipfs://payload',
    idempotencyKey,
    submitter: preparedSubmitter,
    nonce: '7',
    deadline,
    expiresAt: '2026-05-01T00:05:00.000Z',
    status: 'prepared',
    humanSummary: {
      purpose: 'Submit task evidence',
      orderId: 'order_1',
      taskTitle: 'Confirm customs release',
      stage: 'Customs release',
      action: 'Confirm stage',
      payloadHash,
      payloadRef: 'ipfs://payload',
      submitter: preparedSubmitter,
      validUntil: '2026-05-01T00:05:00.000Z',
      chainId: 31337,
      verifyingContract,
    },
    typedData: buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter: preparedSubmitter,
      deadline,
    }),
    evidence: [
      {
        evidenceId: 'ev_1',
        payloadHash,
        payloadRef: 'ipfs://evidence',
        verificationStatus: 'usable',
      },
    ],
    authorization: {
      source: 'allowlist',
    },
  };
}

function jsonResponse(body: unknown, status = 200): ProductApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function bytes32(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, '0')}`;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function restoreFetch(previous: typeof globalThis.fetch | undefined): void {
  if (previous) {
    globalThis.fetch = previous;
    return;
  }
  delete (globalThis as { fetch?: unknown }).fetch;
}
