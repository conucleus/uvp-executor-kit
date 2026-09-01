import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProductSubmitTypedData } from '@uvp-eth/protocol-bindings';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { createProductMcpAdapter } from '../src/mcp.js';
import type {
  PreparedSignalContainer,
  ProductApiFetch,
  ProductApiFetchInit,
  ProductApiFetchResponse,
} from '../src/product.js';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;

describe('Product MCP adapter boundary', () => {
  it('wraps Product SDK calls without exposing raw protocol fields by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-mcp-'));
    const evidencePath = join(dir, 'evidence.txt');
    const envName = 'UVP_MCP_TEST_PRIVATE_KEY';
    const previousEnv = process.env[envName];
    const calls: Array<{ url: string; init?: ProductApiFetchInit }> = [];
    let submittedBody = '';
    process.env[envName] = privateKey;

    const fetch: ProductApiFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/product/tasks?')) {
        return jsonResponse({ tasks: [fundingTask()] });
      }
      if (url.endsWith('/product/tasks/task_funding') && init?.method === 'GET') {
        return jsonResponse({ task: fundingTask() });
      }
      if (url.endsWith('/product/tasks/task_funding/prepare-submit') && init?.method === 'POST') {
        return jsonResponse(preparedSubmission({ taskId: 'task_funding' }), 201);
      }
      if (url.endsWith('/product/tasks/task_funding/submit') && init?.method === 'POST') {
        submittedBody = typeof init.body === 'string' ? init.body : '';
        return jsonResponse(submittedSubmission());
      }
      if (url.endsWith('/product/submissions/sub_mcp') && init?.method === 'GET') {
        return jsonResponse(submittedSubmission());
      }
      throw new Error(`unexpected Product API call ${init?.method ?? 'GET'} ${url}`);
    };

    try {
      await writeFile(evidencePath, 'guarantee proof fingerprint');
      const adapter = createProductMcpAdapter({
        chainServicesUrl: 'http://chain.local/api',
        fetch,
        principalId: 'mcp-agent-1',
      });

      const tasks = await adapter.uvp_list_tasks({ walletAddress: submitter });
      expect(tasks.tasks[0]).toMatchObject({
        taskId: 'task_funding',
        fundingImpact: expect.stringContaining('no custody'),
      });
      expect(tasks.rawTasks).toBeUndefined();
      expect(JSON.stringify(tasks)).not.toContain('sourceId');
      expect(calls[0]?.url).toBe(`http://chain.local/api/product/tasks?assignee=${submitter}`);
      expect(calls[0]?.init?.headers?.['x-uvp-principal-id']).toBe('mcp-agent-1');

      const rawTask = await adapter.uvp_get_task({ taskId: 'task_funding', includeRaw: true });
      expect(rawTask.task).toMatchObject({ taskId: 'task_funding' });
      expect(rawTask.rawTask?.sourceId).toBe(bytes32('02'));

      const prepared = await adapter.uvp_prepare_signal({
        taskId: 'task_funding',
        walletAddress: submitter,
        evidenceIds: ['ev_guarantee'],
        intent: 'confirm_stage',
      });
      expect(prepared.prepared).toMatchObject({
        taskId: 'task_funding',
        intent: 'confirm_stage',
      });
      expect(JSON.stringify(prepared)).not.toContain('typedData');
      expect(JSON.stringify(prepared)).not.toContain('sourceId');

      const evidence = await adapter.uvp_hash_evidence({ path: evidencePath });
      expect(evidence).toMatchObject({
        algorithm: 'keccak256',
        source: 'file',
        byteLength: 27,
      });

      const submitted = await adapter.uvp_submit_signal({
        prepared: preparedSubmission({ taskId: 'task_funding' }),
        privateKeyEnv: envName,
      });
      const requestBody = JSON.parse(submittedBody) as { signature?: string; walletAddress?: string };
      expect(requestBody.walletAddress).toBe(submitter);
      expect(requestBody.signature).toMatch(/^0x[0-9a-f]+$/i);
      const serializedSubmission = JSON.stringify(submitted);
      expect(serializedSubmission).toContain('"submissionId":"sub_mcp"');
      expect(serializedSubmission).not.toContain(privateKey);
      expect(serializedSubmission).not.toContain(requestBody.signature ?? 'missing-signature');
      expect(serializedSubmission).not.toContain('signatureHash');
      expect(serializedSubmission).not.toContain('sourceId');
      expect(serializedSubmission).not.toContain('signalId');

      const proof = await adapter.uvp_get_proof({ submissionId: 'sub_mcp' });
      expect(proof.submission).toMatchObject({
        submissionId: 'sub_mcp',
        status: 'confirmed',
      });
      expect(JSON.stringify(proof)).not.toContain('signatureHash');
    } finally {
      restoreEnv(envName, previousEnv);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fundingTask(): Record<string, unknown> {
  return {
    taskId: 'task_funding',
    orderId: 'order_1',
    title: 'Confirm guarantee coverage',
    status: 'open',
    orderTitle: 'Demo order',
    subtitle: 'Funding condition signal',
    assigneeRole: 'Guarantor',
    assigneeWallet: submitter,
    stageName: 'Funding condition',
    deadline: '2026-05-01T00:05:00.000Z',
    sourceId: bytes32('02'),
    signalId: bytes32('03'),
    fundingImpact: 'Adapter placeholder: records funding condition only; no custody or settlement by UVP.',
    requiredEvidence: ['guarantee-proof'],
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
    primaryActionLabel: 'Confirm funding condition',
    proofRows: [{ label: 'Event', value: 'SignalSubmitted' }],
  };
}

function submittedSubmission(): Record<string, unknown> {
  return {
    submissionId: 'sub_mcp',
    prepareId: 'prep_1',
    taskId: 'task_funding',
    orderId: 'order_1',
    status: 'confirmed',
    intent: 'confirm_stage',
    submitter,
    signature: `0x${'ab'.repeat(65)}`,
    signatureHash: bytes32('66'),
    recoveredSubmitter: submitter,
    signatureStatus: 'signature_verified',
    broadcastStatus: 'confirmed',
    txHash: bytes32('44'),
    blockNumber: '123',
    sourceId: bytes32('02'),
    signalId: bytes32('03'),
    stageIdentifier: 'funding.condition',
    proofRows: [{ label: 'Transaction', value: bytes32('44') }],
  };
}

function preparedSubmission(options: { readonly taskId?: string; readonly submitter?: Address } = {}): PreparedSignalContainer {
  const planId = bytes32('06');
  const orderId = bytes32('01');
  const sourceId = bytes32('02');
  const signalId = bytes32('03');
  const payloadHash = bytes32('04');
  const idempotencyKey = bytes32('05');
  // Deadlines are validated to be a decimal uint in the future, so the fixture
  // computes one instead of pinning a date that ages into the past.
  const deadline = String(Math.floor(Date.now() / 1000) + 3600);
  const preparedSubmitter = options.submitter ?? submitter;
  return {
    prepareId: 'prep_1',
    taskId: options.taskId ?? 'task_1',
    orderId: 'order_1',
    onchainOrderId: orderId,
    stageIdentifier: 'funding.condition',
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
      taskTitle: 'Confirm guarantee coverage',
      stage: 'Funding condition',
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
      planId,
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
        evidenceId: 'ev_guarantee',
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
