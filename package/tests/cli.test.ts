import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { chainPollExecutionFailed, executionOutcomeFailed, main } from '../src/cli.js';

const RETRY_STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const RETRY_WALLET = '0x0000000000000000000000000000000000000002';
const RETRY_ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const RETRY_PLAN_ID = `0x${'77'.repeat(32)}` as Hex;
const RETRY_HOOK_ID = `0x${'22'.repeat(32)}` as Hex;
const RETRY_STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const RETRY_HOOK_NAME_ID = `0x${'66'.repeat(32)}` as Hex;
const RETRY_TX_HASH = `0x${'33'.repeat(32)}` as Hex;
const HOOK_READY_TOPIC = keccak256(stringToBytes('HookReady(bytes32,bytes32,bytes32,bytes32)'));
const RETRY_RAW_LOG = {
  address: RETRY_STATE_MACHINE,
  data: encodeAbiParameters([{ type: 'bytes32' }], [RETRY_HOOK_NAME_ID]),
  topics: [HOOK_READY_TOPIC, RETRY_ORDER_ID, RETRY_HOOK_ID, RETRY_STAGE_ID],
  blockNumber: '12',
  transactionHash: RETRY_TX_HASH,
  logIndex: '7',
};
const RETRY_EVENT_ID = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint256' }],
  [RETRY_TX_HASH, 7n],
));
const RETRY_JOB_ID = keccak256(encodeAbiParameters(
  [
    { type: 'address' },
    { type: 'bytes32' },
    { type: 'bytes32' },
    { type: 'bytes32' },
  ],
  [RETRY_STATE_MACHINE, RETRY_ORDER_ID, RETRY_HOOK_ID, RETRY_EVENT_ID],
));

describe('executor CLI', () => {
  it('accepts the pnpm argument separator before wallet commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-'));
    const envFile = join(dir, '.env.local');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await main(['node', 'uvp-executor', '--', 'wallet', 'new', '--env-file', envFile]);
      const output = JSON.parse(logs[0] ?? '{}') as { wallet?: { envFile?: string } };
      expect(output.wallet?.envFile).toBe(resolve(envFile));
      expect(await readFile(envFile, 'utf8')).toContain('UVP_ETH_DEPLOYER_PRIVATE_KEY=0x');
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates standard state-machine executor configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-config-'));
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        executorId: 'logistics-provider-a',
        walletAddress: '0x0000000000000000000000000000000000000002',
        chainId: 84532,
        stateMachineAddress: '0x0000000000000000000000000000000000000001',
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
        handlers: {
          'export.customs#START': {
            signals: [
              {
                source: 'logistics-provider-a',
                stageIdentifier: 'export.customs',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      await main(['node', 'uvp-executor', 'config', 'validate', '--config', configPath]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        config?: {
          valid?: boolean;
          kind?: string;
          handlerCount?: number;
          signalCount?: number;
          supplier?: {
            supplierId?: string;
          };
          wallet?: {
            configured?: boolean;
            address?: string;
          };
          stageCapabilities?: Array<{
            key?: string;
            stageIdentifiers?: string[];
            signalCount?: number;
          }>;
        };
      };
      expect(output.config).toMatchObject({
        valid: true,
        kind: 'state-machine',
        handlerCount: 1,
        signalCount: 1,
        supplier: {
          supplierId: 'logistics-provider-a',
        },
        wallet: {
          configured: true,
          address: '0x0000000000000000000000000000000000000002',
        },
      });
      expect(output.config?.stageCapabilities?.[0]).toMatchObject({
        key: 'export.customs#START',
        stageIdentifiers: ['export.customs'],
        signalCount: 1,
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists and dead-letters local watcher jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-jobs-'));
    const jobsFile = join(dir, 'jobs.json');
    const jobId = `0x${'aa'.repeat(32)}`;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [
          {
            id: jobId,
            eventId: `0x${'bb'.repeat(32)}`,
            orderId: `0x${'11'.repeat(32)}`,
            hookId: `0x${'22'.repeat(32)}`,
            stageId: `0x${'33'.repeat(32)}`,
            stageIdentifier: 'export.customs',
            hookName: 'START',
            supplierId: 'logistics-provider-a',
            status: 'failed',
            attempts: 1,
            maxAttempts: 3,
            detectedAt: '2026-04-28T00:00:00.000Z',
            updatedAt: '2026-04-28T00:00:01.000Z',
            submissions: [],
            lastError: {
              kind: 'unauthorized',
              message: 'AccessControlUnauthorizedAccount submitter',
              retryable: false,
            },
          },
        ],
      }));

      await main(['node', 'uvp-executor', 'jobs', 'list', '--jobs-file', jobsFile]);
      const listed = JSON.parse(logs[0] ?? '{}') as {
        jobs?: Array<{ jobId?: string; status?: string; supplierId?: string }>;
      };
      expect(listed.jobs?.[0]).toMatchObject({
        jobId,
        status: 'failed',
        supplierId: 'logistics-provider-a',
      });

      await main([
        'node',
        'uvp-executor',
        'jobs',
        'dead-letter',
        jobId,
        '--jobs-file',
        jobsFile,
        '--operator',
        'ops@example.com',
        '--reason',
        'manual review required',
      ]);
      const deadLettered = JSON.parse(logs[1] ?? '{}') as {
        job?: { status?: string; lastError?: { message?: string } };
        rawJob?: { manualActions?: Array<{ action?: string; operator?: string; reason?: string }> };
      };
      expect(deadLettered.job).toMatchObject({
        status: 'dead_letter',
        lastError: {
          message: 'manual review required',
        },
      });
      expect(deadLettered.rawJob?.manualActions?.[0]).toMatchObject({
        action: 'dead_letter',
        operator: 'ops@example.com',
        reason: 'manual review required',
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects chain-signal --payload-ref instead of silently dropping it', async () => {
    // The frozen submitSignal ABI has no payloadRef field; before this guard the
    // flag was parsed, discarded, and the command reported success anyway.
    await expect(main([
      'node',
      'uvp-executor',
      'chain-signal',
      '--rpc-url',
      'http://127.0.0.1:8545',
      '--state-machine',
      RETRY_STATE_MACHINE,
      '--chain-id',
      '31337',
      '--order-id',
      RETRY_ORDER_ID,
      '--plan-id',
      RETRY_PLAN_ID,
      '--source',
      'buyer',
      '--stage',
      'exec.main',
      '--signal-name',
      'cmp',
      '--payload-hash',
      `0x${'44'.repeat(32)}`,
      '--payload-ref',
      'ipfs://payload',
      '--wallet-address',
      RETRY_WALLET,
      '--dry-run',
    ])).rejects.toThrow(/--payload-ref is not supported by chain-signal/);
  });
});

describe('honest execution exit codes', () => {
  it('flags poll outcomes that carry errors or terminal failure states', () => {
    expect(chainPollExecutionFailed({ results: [{ status: 'handled', submissions: [] }] })).toBe(false);
    expect(chainPollExecutionFailed({
      results: [{
        status: 'ignored',
        submissions: [],
        error: { kind: 'missing_handler', message: 'no state machine handler', retryable: false },
      }],
    })).toBe(true);
    expect(executionOutcomeFailed({})).toBe(false);
    expect(executionOutcomeFailed({ job: { status: 'failed' } })).toBe(true);
    expect(executionOutcomeFailed({ job: { status: 'dead_letter' } })).toBe(true);
    expect(executionOutcomeFailed({ job: { status: 'confirmed' } })).toBe(false);
  });

  it('leaves the exit code unset when jobs retry succeeds offline in dry-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-exit-ok-'));
    const jobsFile = join(dir, 'jobs.json');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [{
          id: RETRY_JOB_ID,
          eventId: RETRY_EVENT_ID,
          orderId: RETRY_ORDER_ID,
          planId: RETRY_PLAN_ID,
          hookId: RETRY_HOOK_ID,
          stageId: RETRY_STAGE_ID,
          stageIdentifier: 'exec.main',
          hookName: 'START',
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          detectedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:01.000Z',
          submissions: [],
          raw: RETRY_RAW_LOG,
        }],
      }));
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          '*': {
            signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }],
          },
        },
      }));

      await main([
        'node', 'uvp-executor', 'jobs', 'retry', RETRY_JOB_ID,
        '--jobs-file', jobsFile,
        '--rpc-url', 'http://127.0.0.1:8545',
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--operator', 'ops@example.com',
        '--wallet-address', RETRY_WALLET,
        '--dry-run',
      ]);

      const output = JSON.parse(logs[0] ?? '{}') as { retry?: { status?: string; job?: { status?: string } } };
      expect(output.retry?.status).toBe('handled');
      expect(output.retry?.job?.status).toBe('matched');
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when jobs retry ends with an error while still printing the full result JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-exit-fail-'));
    const jobsFile = join(dir, 'jobs.json');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [{
          id: RETRY_JOB_ID,
          eventId: RETRY_EVENT_ID,
          orderId: RETRY_ORDER_ID,
          planId: RETRY_PLAN_ID,
          hookId: RETRY_HOOK_ID,
          stageId: RETRY_STAGE_ID,
          stageIdentifier: 'exec.main',
          hookName: 'START',
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          detectedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:01.000Z',
          submissions: [],
          raw: RETRY_RAW_LOG,
        }],
      }));
      // No handler matches exec.main#START: the outcome carries an error and
      // the job is ignored — the process must not pretend this succeeded.
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          'nomatch.stage#X': {
            signals: [{ source: 'buyer', stageIdentifier: 'nomatch.stage', signalName: 'cmp' }],
          },
        },
      }));

      await main([
        'node', 'uvp-executor', 'jobs', 'retry', RETRY_JOB_ID,
        '--jobs-file', jobsFile,
        '--rpc-url', 'http://127.0.0.1:8545',
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--operator', 'ops@example.com',
        '--wallet-address', RETRY_WALLET,
        '--dry-run',
      ]);

      const output = JSON.parse(logs[0] ?? '{}') as {
        retry?: { status?: string; error?: { kind?: string }; job?: { status?: string } };
      };
      expect(output.retry?.status).toBe('ignored');
      expect(output.retry?.error?.kind).toBe('missing_handler');
      expect(output.retry?.job?.status).toBe('ignored');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
